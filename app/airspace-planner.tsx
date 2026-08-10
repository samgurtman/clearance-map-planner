"use client";

import buffer from "@turf/buffer";
import intersect from "@turf/intersect";
import { featureCollection, multiPolygon, point, polygon } from "@turf/helpers";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { union as unionPolygons } from "polyclip-ts";
import type { Geom } from "polyclip-ts";
import {
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

type Point = { x: number; y: number };
type Origin = { lat: number; lon: number };
type Building = Point & {
  id: string;
  name: string;
  envelopes: Point[][];
  heightFt: number;
  heightSource: string;
  groundElevationFt?: number;
};
type Zone = { id: string; label: string; points: Point[]; source: string };
type RenderBounds = { west: number; east: number; south: number; north: number };
type RenderProgress = { active: boolean; value: number; label: string };
type TerrainCell = {
  id: string;
  zoom: number;
  tileX: number;
  tileY: number;
  cellX: number;
  cellY: number;
  west: number;
  east: number;
  south: number;
  north: number;
  elevationFt: number;
};
type Check = {
  state: "conflict" | "clear" | "outside" | "unavailable";
  zone?: Zone;
  obstacle?: Building;
  controllingSource?: "surface" | "building";
  surfaceElevationFt?: number;
  obstacleTopElevationFt?: number;
  requiredFt?: number;
  marginFt?: number;
  envelopeDistanceFt?: number;
};
type ImportedDataset = { buildings: Building[]; origin: Origin; note: string };
type CoverageStatus = "idle" | "loading" | "ready" | "zoom-required" | "error";
type TerrainStatus = "idle" | "loading" | "ready" | "zoom-required" | "error";
type Basemap = "street" | "sectional";

const CHICAGO_ORIGIN: Origin = { lat: 41.8819, lon: -87.6324 };
const OVERTURE_FALLBACK_RELEASE = "2026-07-22.0";
const OVERTURE_CATALOG_URL = "https://stac.overturemaps.org/catalog.json";
const FAA_SECTIONAL_TILE_URL = "https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}";
const FAA_TERMINAL_TILE_URL = "https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}";
const TERRAIN_TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TERRAIN_TILE_ZOOM = 14;
const TERRAIN_CELL_DIVISIONS = 4;
const TERRAIN_MEMORY_CACHE_MAX_TILES = 192;
const TERRAIN_FETCH_CONCURRENCY = 8;
const OVERTURE_TILE_CACHE_DB = "clearance-overture-tile-cache-v1";
const OVERTURE_TILE_CACHE_STORE = "tiles";
const OVERTURE_TILE_CACHE_META_STORE = "metadata";
const OVERTURE_MEMORY_CACHE_MAX_TILES = 48;
const OVERTURE_MEMORY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const OVERTURE_PERSISTENT_CACHE_MAX_TILES = 256;
const OVERTURE_PERSISTENT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const MAX_VISIBLE_OVERTURE_TILES = 128;
const CLEARANCE_DISTANCE_FT = 2000;
const FEET_PER_LAT_DEGREE = 364_000;
const feetPerLonDegree = (latitude: number) => 364_000 * Math.cos((latitude * Math.PI) / 180);

type OvertureTileCacheMetadata = { key: string; byteLength: number; lastUsed: number };
type TerrainRaster = { width: number; height: number; data: Uint8ClampedArray };

const overtureMemoryTileCache = new Map<string, ArrayBuffer>();
const overtureTileRequests = new Map<string, Promise<ArrayBuffer | null>>();
const terrainMemoryTileCache = new Map<string, TerrainRaster>();
const terrainTileRequests = new Map<string, Promise<TerrainRaster | null>>();
let overtureMemoryTileCacheBytes = 0;
let overtureTileCacheDatabase: Promise<IDBDatabase | null> | null = null;

function rememberTerrainTile(key: string, raster: TerrainRaster) {
  terrainMemoryTileCache.delete(key);
  terrainMemoryTileCache.set(key, raster);
  while (terrainMemoryTileCache.size > TERRAIN_MEMORY_CACHE_MAX_TILES) {
    const oldestKey = terrainMemoryTileCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    terrainMemoryTileCache.delete(oldestKey);
  }
}

async function decodeTerrainRaster(data: ArrayBuffer): Promise<TerrainRaster> {
  const bitmap = await createImageBitmap(new Blob([data], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("Terrain image decoding is unavailable.");
  }
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: pixels.width, height: pixels.height, data: pixels.data };
}

async function loadTerrainTile(zoom: number, x: number, y: number) {
  const key = `${zoom}/${x}/${y}`;
  const cached = terrainMemoryTileCache.get(key);
  if (cached) {
    rememberTerrainTile(key, cached);
    return cached;
  }
  const pending = terrainTileRequests.get(key);
  if (pending) return pending;
  const request = (async () => {
    const response = await fetch(TERRAIN_TILE_URL.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y)));
    if (!response.ok) return null;
    const raster = await decodeTerrainRaster(await response.arrayBuffer());
    rememberTerrainTile(key, raster);
    return raster;
  })();
  terrainTileRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (terrainTileRequests.get(key) === request) terrainTileRequests.delete(key);
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function readMemoryTile(key: string) {
  const data = overtureMemoryTileCache.get(key);
  if (!data) return null;
  overtureMemoryTileCache.delete(key);
  overtureMemoryTileCache.set(key, data);
  return data;
}

function rememberMemoryTile(key: string, data: ArrayBuffer) {
  const previous = overtureMemoryTileCache.get(key);
  if (previous) {
    overtureMemoryTileCacheBytes -= previous.byteLength;
    overtureMemoryTileCache.delete(key);
  }
  if (data.byteLength > OVERTURE_MEMORY_CACHE_MAX_BYTES) return;
  overtureMemoryTileCache.set(key, data);
  overtureMemoryTileCacheBytes += data.byteLength;
  while (
    overtureMemoryTileCache.size > OVERTURE_MEMORY_CACHE_MAX_TILES
    || overtureMemoryTileCacheBytes > OVERTURE_MEMORY_CACHE_MAX_BYTES
  ) {
    const oldestKey = overtureMemoryTileCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = overtureMemoryTileCache.get(oldestKey);
    if (oldest) overtureMemoryTileCacheBytes -= oldest.byteLength;
    overtureMemoryTileCache.delete(oldestKey);
  }
}

function openOvertureTileCache() {
  if (overtureTileCacheDatabase) return overtureTileCacheDatabase;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  overtureTileCacheDatabase = new Promise((resolve) => {
    const request = indexedDB.open(OVERTURE_TILE_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OVERTURE_TILE_CACHE_STORE)) {
        database.createObjectStore(OVERTURE_TILE_CACHE_STORE);
      }
      if (!database.objectStoreNames.contains(OVERTURE_TILE_CACHE_META_STORE)) {
        const metadata = database.createObjectStore(OVERTURE_TILE_CACHE_META_STORE, { keyPath: "key" });
        metadata.createIndex("lastUsed", "lastUsed");
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return overtureTileCacheDatabase;
}

async function readPersistentTile(key: string) {
  const database = await openOvertureTileCache();
  if (!database) return null;
  return new Promise<ArrayBuffer | null>((resolve) => {
    try {
      const transaction = database.transaction(OVERTURE_TILE_CACHE_STORE, "readonly");
      const request = transaction.objectStore(OVERTURE_TILE_CACHE_STORE).get(key);
      request.onsuccess = () => {
        const data = request.result;
        if (!(data instanceof ArrayBuffer)) {
          resolve(null);
          return;
        }
        resolve(data);
        try {
          const touch = database.transaction(OVERTURE_TILE_CACHE_META_STORE, "readwrite");
          touch.objectStore(OVERTURE_TILE_CACHE_META_STORE).put({ key, byteLength: data.byteLength, lastUsed: Date.now() });
        } catch {
          // The tile remains usable even when cache metadata cannot be updated.
        }
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function prunePersistentTileCache(database: IDBDatabase) {
  const metadata = await new Promise<OvertureTileCacheMetadata[]>((resolve) => {
    try {
      const transaction = database.transaction(OVERTURE_TILE_CACHE_META_STORE, "readonly");
      const request = transaction.objectStore(OVERTURE_TILE_CACHE_META_STORE).getAll();
      request.onsuccess = () => resolve(request.result as OvertureTileCacheMetadata[]);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
  let totalBytes = metadata.reduce((sum, item) => sum + item.byteLength, 0);
  const oldestFirst = [...metadata].sort((a, b) => a.lastUsed - b.lastUsed);
  const evicted: string[] = [];
  while (
    oldestFirst.length > OVERTURE_PERSISTENT_CACHE_MAX_TILES
    || totalBytes > OVERTURE_PERSISTENT_CACHE_MAX_BYTES
  ) {
    const oldest = oldestFirst.shift();
    if (!oldest) break;
    totalBytes -= oldest.byteLength;
    evicted.push(oldest.key);
  }
  if (!evicted.length) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction([OVERTURE_TILE_CACHE_STORE, OVERTURE_TILE_CACHE_META_STORE], "readwrite");
      const tiles = transaction.objectStore(OVERTURE_TILE_CACHE_STORE);
      const tileMetadata = transaction.objectStore(OVERTURE_TILE_CACHE_META_STORE);
      evicted.forEach((key) => {
        tiles.delete(key);
        tileMetadata.delete(key);
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function writePersistentTile(key: string, data: ArrayBuffer) {
  if (data.byteLength > OVERTURE_PERSISTENT_CACHE_MAX_BYTES) return;
  const database = await openOvertureTileCache();
  if (!database) return;
  const stored = await new Promise<boolean>((resolve) => {
    try {
      const transaction = database.transaction([OVERTURE_TILE_CACHE_STORE, OVERTURE_TILE_CACHE_META_STORE], "readwrite");
      transaction.objectStore(OVERTURE_TILE_CACHE_STORE).put(data, key);
      transaction.objectStore(OVERTURE_TILE_CACHE_META_STORE).put({ key, byteLength: data.byteLength, lastUsed: Date.now() });
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  if (stored) await prunePersistentTileCache(database);
}

async function loadCachedOvertureTile(key: string, load: () => Promise<ArrayBuffer | null>) {
  const memoryTile = readMemoryTile(key);
  if (memoryTile) return memoryTile;
  const activeRequest = overtureTileRequests.get(key);
  if (activeRequest) return activeRequest;
  const request = (async () => {
    const persistentTile = await readPersistentTile(key);
    if (persistentTile) {
      rememberMemoryTile(key, persistentTile);
      return persistentTile;
    }
    const downloadedTile = await load();
    if (!downloadedTile) return null;
    rememberMemoryTile(key, downloadedTile);
    void writePersistentTile(key, downloadedTile);
    return downloadedTile;
  })();
  overtureTileRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (overtureTileRequests.get(key) === request) overtureTileRequests.delete(key);
  }
}

function rectangleEnvelope(x: number, y: number, width: number, depth: number): Point[] {
  return [
    { x: x - width / 2, y: y - depth / 2 },
    { x: x + width / 2, y: y - depth / 2 },
    { x: x + width / 2, y: y + depth / 2 },
    { x: x - width / 2, y: y + depth / 2 },
  ];
}

function localToLngLat(value: Point, origin: Origin): [number, number] {
  return [origin.lon + value.x / feetPerLonDegree(origin.lat), origin.lat - value.y / FEET_PER_LAT_DEGREE];
}

function lngLatToLocal(lon: number, lat: number, origin: Origin): Point {
  return {
    x: (lon - origin.lon) * feetPerLonDegree(origin.lat),
    y: -(lat - origin.lat) * FEET_PER_LAT_DEGREE,
  };
}

function pointInPolygon(value: Point, points: Point[]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    const crosses = a.y > value.y !== b.y > value.y && value.x < ((b.x - a.x) * (value.y - a.y)) / (b.y - a.y || 1) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegment(value: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, ((value.x - start.x) * dx + (value.y - start.y) * dy) / denominator)) : 0;
  return Math.hypot(value.x - (start.x + t * dx), value.y - (start.y + t * dy));
}

function distanceToEnvelope(value: Point, envelope: Point[]) {
  if (pointInPolygon(value, envelope)) return 0;
  let shortest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < envelope.length; i += 1) {
    shortest = Math.min(shortest, distanceToSegment(value, envelope[i], envelope[(i + 1) % envelope.length]));
  }
  return shortest;
}

function distanceToBuilding(value: Point, building: Building) {
  return Math.min(...building.envelopes.map((envelope) => distanceToEnvelope(value, envelope)));
}

function buildingTopElevationFt(building: Building) {
  return building.groundElevationFt == null ? null : building.groundElevationFt + building.heightFt;
}

function evaluatePoint(value: Point, altitudeFt: number, buildings: Building[], zones: Zone[], surfaceElevationFt: number | null): Check {
  const zone = zones.find((candidate) => pointInPolygon(value, candidate.points));
  if (!zone) return { state: "outside" };
  if (surfaceElevationFt == null) return { state: "unavailable", zone };
  let highest: { building: Building; distance: number } | undefined;
  for (const building of buildings) {
    const topElevationFt = buildingTopElevationFt(building);
    if (topElevationFt == null) continue;
    const distance = distanceToBuilding(value, building);
    if (distance <= CLEARANCE_DISTANCE_FT && (!highest || topElevationFt > (buildingTopElevationFt(highest.building) ?? -Infinity))) highest = { building, distance };
  }
  const surfaceRequiredFt = surfaceElevationFt + 1000;
  const obstacleTopElevationFt = highest ? buildingTopElevationFt(highest.building) ?? undefined : undefined;
  const buildingRequiredFt = obstacleTopElevationFt == null ? -Infinity : obstacleTopElevationFt + 1000;
  const controllingSource = buildingRequiredFt > surfaceRequiredFt ? "building" : "surface";
  const requiredFt = Math.ceil(Math.max(surfaceRequiredFt, buildingRequiredFt));
  const marginFt = altitudeFt - requiredFt;
  return {
    state: marginFt >= 0 ? "clear" : "conflict",
    zone,
    obstacle: highest?.building,
    controllingSource,
    surfaceElevationFt,
    obstacleTopElevationFt,
    requiredFt,
    marginFt,
    envelopeDistanceFt: highest?.distance,
  };
}

function closedCoordinates(points: Point[], origin: Origin) {
  const closed = points.length && (points[0].x !== points[points.length - 1].x || points[0].y !== points[points.length - 1].y)
    ? [...points, points[0]]
    : points;
  return closed.map((value) => localToLngLat(value, origin));
}

function buildingFeature(building: Building, origin: Origin): Feature<Polygon | MultiPolygon> {
  const properties = { id: building.id, name: building.name, heightFt: building.heightFt, groundElevationFt: building.groundElevationFt, topElevationFt: buildingTopElevationFt(building), heightSource: building.heightSource };
  if (building.envelopes.length > 1) {
    return multiPolygon(building.envelopes.map((envelope) => [closedCoordinates(envelope, origin)]), properties);
  }
  return polygon([closedCoordinates(building.envelopes[0], origin)], properties);
}

function zoneFeature(zone: Zone, origin: Origin): Feature<Polygon> {
  return polygon([closedCoordinates(zone.points, origin)], { id: zone.id, label: zone.label, source: zone.source });
}

function makeConservativeZone(buildings: Building[], label: string): Zone {
  const points = buildings.flatMap((building) => building.envelopes.flat());
  const xs = points.map((value) => value.x);
  const ys = points.map((value) => value.y);
  const minX = Math.min(...xs) - 700;
  const maxX = Math.max(...xs) + 700;
  const minY = Math.min(...ys) - 700;
  const maxY = Math.max(...ys) + 700;
  return {
    id: "imported-study-area",
    label,
    source: "Conservative imported-data screen",
    points: [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }],
  };
}

function propertyName(properties: Record<string, unknown>, fallback: string) {
  if (typeof properties["@name"] === "string" && properties["@name"]) return String(properties["@name"]);
  if (typeof properties.name === "string") return properties.name;
  const names = properties.names as { primary?: string; common?: Record<string, string> } | undefined;
  return names?.primary || names?.common?.en || fallback;
}

function propertyHeight(properties: Record<string, unknown>) {
  if (Number.isFinite(Number(properties.height_ft))) return { feet: Number(properties.height_ft), source: "height_ft" };
  if (Number.isFinite(Number(properties.height_m))) return { feet: Number(properties.height_m) * 3.28084, source: "height_m" };
  if (Number.isFinite(Number(properties.height))) return { feet: Number(properties.height) * 3.28084, source: "height (meters)" };
  if (Number.isFinite(Number(properties.num_floors))) return { feet: Number(properties.num_floors) * 10, source: "num_floors estimate" };
  if (Number.isFinite(Number(properties["building:levels"]))) return { feet: Number(properties["building:levels"]) * 10, source: "building:levels estimate" };
  return { feet: 30, source: "30 ft fallback" };
}

function parseCsv(text: string): ImportedDataset {
  const rows = text.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) throw new Error("The CSV needs a header and at least one building row.");
  const headers = rows[0].split(",").map((header) => header.trim().toLowerCase());
  const entries = rows.slice(1).map((row) => {
    const cells = row.split(",").map((cell) => cell.trim());
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  });
  const lats = entries.map((row) => Number(row.lat ?? row.latitude));
  const lons = entries.map((row) => Number(row.lon ?? row.lng ?? row.longitude));
  if (lats.some((value) => !Number.isFinite(value)) || lons.some((value) => !Number.isFinite(value))) {
    throw new Error("CSV columns required: lat, lon, height_ft, width_ft, depth_ft.");
  }
  const origin = {
    lat: lats.reduce((sum, value) => sum + value, 0) / lats.length,
    lon: lons.reduce((sum, value) => sum + value, 0) / lons.length,
  };
  const buildings = entries.map((row, index) => {
    const center = lngLatToLocal(lons[index], lats[index], origin);
    const heightFt = Number(row.height_ft);
    if (!Number.isFinite(heightFt)) throw new Error("Every CSV row needs a numeric height_ft value.");
    const width = Number(row.width_ft) || 180;
    const depth = Number(row.depth_ft) || 180;
    return {
      id: `csv-${index}`,
      name: row.name || `Imported building ${index + 1}`,
      ...center,
      envelopes: [rectangleEnvelope(center.x, center.y, width, depth)],
      heightFt,
      heightSource: "height_ft",
    };
  });
  return { buildings, origin, note: "CSV envelopes use width_ft × depth_ft rectangles" };
}

function parseGeoJson(text: string): ImportedDataset {
  const data = JSON.parse(text);
  const features: Array<Record<string, unknown>> = data.type === "FeatureCollection" ? data.features : data.type === "Feature" ? [data] : [];
  if (!features.length) throw new Error("GeoJSON must be a Feature or FeatureCollection.");
  const raw = features.flatMap((feature, index) => {
    const geometry = feature.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (!geometry || !["Point", "Polygon", "MultiPolygon"].includes(geometry.type || "")) return [];
    let rings: number[][][];
    if (geometry.type === "Point") rings = [[geometry.coordinates as number[]]];
    else if (geometry.type === "Polygon") rings = [(geometry.coordinates as number[][][])[0]];
    else rings = (geometry.coordinates as number[][][][]).map((candidate) => candidate[0]).filter(Boolean);
    if (!rings?.length) return [];
    const coordinates = rings.flat().map((coordinate) => [Number(coordinate[0]), Number(coordinate[1])]);
    if (!coordinates.length || coordinates.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat))) return [];
    const lon = coordinates.reduce((sum, coordinate) => sum + coordinate[0], 0) / coordinates.length;
    const lat = coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) / coordinates.length;
    return [{ index, feature, rings, lon, lat }];
  });
  if (!raw.length) throw new Error("No point or polygon building geometries were found.");
  const origin = {
    lat: raw.reduce((sum, item) => sum + item.lat, 0) / raw.length,
    lon: raw.reduce((sum, item) => sum + item.lon, 0) / raw.length,
  };
  const buildings = raw.map((item) => {
    const properties = (item.feature.properties || {}) as Record<string, unknown>;
    const height = propertyHeight(properties);
    const center = lngLatToLocal(item.lon, item.lat, origin);
    let envelopes = item.rings.map((ring) => ring.map(([lon, lat]) => lngLatToLocal(lon, lat, origin)));
    if (envelopes.length === 1 && envelopes[0].length === 1) envelopes = [rectangleEnvelope(center.x, center.y, Number(properties.width_ft) || 180, Number(properties.depth_ft) || 180)];
    envelopes = envelopes.map((envelope) => envelope.length > 2 && envelope[0].x === envelope[envelope.length - 1].x && envelope[0].y === envelope[envelope.length - 1].y ? envelope.slice(0, -1) : envelope);
    return {
      id: String(properties.id || item.feature.id || `geo-${item.index}`),
      name: propertyName(properties, `Imported building ${item.index + 1}`),
      ...center,
      envelopes,
      heightFt: Math.round(height.feet),
      heightSource: height.source,
    };
  });
  return { buildings, origin, note: "GeoJSON envelopes preserved · Overture height fields supported" };
}

function estimateFlaggedSquareMiles(altitudeFt: number, buildings: Building[], zones: Zone[], origin: Origin, terrainIndex: Map<string, TerrainCell>) {
  if (!zones.length) return 0;
  const xs = zones.flatMap((zone) => zone.points.map((value) => value.x));
  const ys = zones.flatMap((zone) => zone.points.map((value) => value.y));
  const width = Math.max(...xs) - Math.min(...xs);
  const depth = Math.max(...ys) - Math.min(...ys);
  const step = Math.max(300, Math.sqrt((width * depth) / 2500));
  const active = buildings.filter((building) => {
    const topElevationFt = buildingTopElevationFt(building);
    return topElevationFt != null && altitudeFt < topElevationFt + 1000;
  });
  const screened = active.length > 500 ? groupDenseBuildings(active) : active;
  let flagged = 0;
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += step) {
      const sample = { x, y };
      if (!zones.some((zone) => pointInPolygon(sample, zone.points))) continue;
      const [lon, lat] = localToLngLat(sample, origin);
      const surfaceElevationFt = terrainElevationAtLngLat(lon, lat, terrainIndex);
      if ((surfaceElevationFt != null && altitudeFt < surfaceElevationFt + 1000) || screened.some((building) => distanceToBuilding(sample, building) <= CLEARANCE_DISTANCE_FT)) flagged += 1;
    }
  }
  return (flagged * step * step) / 27_878_400;
}

function groupDenseBuildings(buildings: Building[], cellSize = 750): Building[] {
  const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; heightFt: number; groundElevationFt?: number; topElevationFt: number; count: number }>();
  buildings.forEach((building) => {
    const key = `${Math.floor(building.x / cellSize)}:${Math.floor(building.y / cellSize)}`;
    const points = building.envelopes.flat();
    const current = groups.get(key) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, heightFt: 0, topElevationFt: -Infinity, count: 0 };
    points.forEach((value) => {
      current.minX = Math.min(current.minX, value.x);
      current.minY = Math.min(current.minY, value.y);
      current.maxX = Math.max(current.maxX, value.x);
      current.maxY = Math.max(current.maxY, value.y);
    });
    const topElevationFt = buildingTopElevationFt(building);
    if (topElevationFt != null && topElevationFt > current.topElevationFt) {
      current.topElevationFt = topElevationFt;
      current.heightFt = building.heightFt;
      current.groundElevationFt = building.groundElevationFt;
    }
    current.count += 1;
    groups.set(key, current);
  });
  return [...groups.entries()].map(([key, group]) => {
    const width = Math.max(20, group.maxX - group.minX);
    const depth = Math.max(20, group.maxY - group.minY);
    const x = (group.minX + group.maxX) / 2;
    const y = (group.minY + group.maxY) / 2;
    return { id: `group-${key}`, name: `${group.count} nearby envelopes`, x, y, envelopes: [rectangleEnvelope(x, y, width, depth)], heightFt: group.heightFt, groundElevationFt: group.groundElevationFt, heightSource: "Dense-view group" };
  });
}

const emptyFeatures = (): FeatureCollection => featureCollection([]);

function dissolveConflictFeatures(features: Array<Feature<Polygon | MultiPolygon>>): FeatureCollection<Polygon | MultiPolygon> {
  if (features.length < 2) return featureCollection(features);
  try {
    const geometries = features.map((feature) => feature.geometry.coordinates as Geom);
    const coordinates = unionPolygons(geometries[0], ...geometries.slice(1));
    return coordinates.length
      ? featureCollection([multiPolygon(coordinates, { dissolved: true })])
      : featureCollection([]);
  } catch (error) {
    console.error("Conflict geometry dissolve failed", error);
    return featureCollection(features);
  }
}

function ringsFromOvertureFeature(feature: Feature<Polygon | MultiPolygon>): number[][][] {
  if (feature.geometry.type === "Polygon") return [(feature.geometry.coordinates as number[][][])[0]];
  if (feature.geometry.type === "MultiPolygon") return (feature.geometry.coordinates as number[][][][]).map((candidate) => candidate[0]);
  return [];
}

function overtureBuildingsFromFeatures(features: Array<Feature<Polygon | MultiPolygon>>, origin: Origin): Building[] {
  const records = new Map<string, Building>();
  features.forEach((feature, index) => {
    const properties = (feature.properties || {}) as Record<string, unknown>;
    const sourceLayer = String(properties.__sourceLayer || "building");
    const rings = ringsFromOvertureFeature(feature);
    if (!rings.length) return;
    const key = `${sourceLayer}:${String(properties.id || feature.id || index)}`;
    const envelopes = rings
      .map((ring) => ring.map(([lon, lat]) => lngLatToLocal(Number(lon), Number(lat), origin)))
      .map((envelope) => envelope.length > 2 && envelope[0].x === envelope[envelope.length - 1].x && envelope[0].y === envelope[envelope.length - 1].y ? envelope.slice(0, -1) : envelope)
      .filter((envelope) => envelope.length >= 3);
    if (!envelopes.length) return;
    const existing = records.get(key);
    if (existing) {
      existing.envelopes.push(...envelopes);
      return;
    }
    const points = envelopes.flat();
    const height = propertyHeight(properties);
    records.set(key, {
      id: key,
      name: propertyName(properties, sourceLayer === "building_part" ? "Building part" : "Building"),
      x: points.reduce((sum, value) => sum + value.x, 0) / points.length,
      y: points.reduce((sum, value) => sum + value.y, 0) / points.length,
      envelopes,
      heightFt: Math.round(height.feet),
      heightSource: height.source,
    });
  });
  return [...records.values()];
}

function tileX(lon: number, zoom: number) {
  return Math.floor(((lon + 180) / 360) * (2 ** zoom));
}

function tileY(lat: number, zoom: number) {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * (2 ** zoom));
}

function tileXPosition(lon: number, zoom: number) {
  return ((lon + 180) / 360) * (2 ** zoom);
}

function tileYPosition(lat: number, zoom: number) {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * (2 ** zoom);
}

function longitudeAtTilePosition(position: number, zoom: number) {
  return (position / (2 ** zoom)) * 360 - 180;
}

function latitudeAtTilePosition(position: number, zoom: number) {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * position) / (2 ** zoom)))) * 180 / Math.PI;
}

function terrainCellId(zoom: number, tileColumn: number, tileRow: number, cellColumn: number, cellRow: number) {
  return `${zoom}/${tileColumn}/${tileRow}/${cellColumn}/${cellRow}`;
}

async function terrainCellsFromTiles(tiles: Array<{ x: number; y: number; raster: TerrainRaster }>, zoom: number, onProgress?: (value: number) => void) {
  const cells: TerrainCell[] = [];
  for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
    const { x, y, raster } = tiles[tileIndex];
    const maxima = new Array<number>(TERRAIN_CELL_DIVISIONS * TERRAIN_CELL_DIVISIONS).fill(-Infinity);
    for (let pixelY = 0; pixelY < raster.height; pixelY += 1) {
      const cellY = Math.min(TERRAIN_CELL_DIVISIONS - 1, Math.floor((pixelY / raster.height) * TERRAIN_CELL_DIVISIONS));
      for (let pixelX = 0; pixelX < raster.width; pixelX += 1) {
        const offset = (pixelY * raster.width + pixelX) * 4;
        if (raster.data[offset + 3] === 0) continue;
        const elevationMeters = (raster.data[offset] * 256 + raster.data[offset + 1] + raster.data[offset + 2] / 256) - 32768;
        const cellX = Math.min(TERRAIN_CELL_DIVISIONS - 1, Math.floor((pixelX / raster.width) * TERRAIN_CELL_DIVISIONS));
        const cellIndex = cellY * TERRAIN_CELL_DIVISIONS + cellX;
        maxima[cellIndex] = Math.max(maxima[cellIndex], elevationMeters);
      }
    }
    for (let cellY = 0; cellY < TERRAIN_CELL_DIVISIONS; cellY += 1) {
      for (let cellX = 0; cellX < TERRAIN_CELL_DIVISIONS; cellX += 1) {
        const elevationMeters = maxima[cellY * TERRAIN_CELL_DIVISIONS + cellX];
        if (!Number.isFinite(elevationMeters)) continue;
        const west = longitudeAtTilePosition(x + cellX / TERRAIN_CELL_DIVISIONS, zoom);
        const east = longitudeAtTilePosition(x + (cellX + 1) / TERRAIN_CELL_DIVISIONS, zoom);
        const north = latitudeAtTilePosition(y + cellY / TERRAIN_CELL_DIVISIONS, zoom);
        const south = latitudeAtTilePosition(y + (cellY + 1) / TERRAIN_CELL_DIVISIONS, zoom);
        cells.push({
          id: terrainCellId(zoom, x, y, cellX, cellY),
          zoom,
          tileX: x,
          tileY: y,
          cellX,
          cellY,
          west,
          east,
          south,
          north,
          elevationFt: Math.ceil(elevationMeters * 3.28084),
        });
      }
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    onProgress?.((tileIndex + 1) / tiles.length);
  }
  return cells;
}

function terrainElevationAtLngLat(lon: number, lat: number, terrainIndex: Map<string, TerrainCell>) {
  const xPosition = tileXPosition(lon, TERRAIN_TILE_ZOOM);
  const yPosition = tileYPosition(lat, TERRAIN_TILE_ZOOM);
  const tileColumn = Math.floor(xPosition);
  const tileRow = Math.floor(yPosition);
  const cellColumn = Math.max(0, Math.min(TERRAIN_CELL_DIVISIONS - 1, Math.floor((xPosition - tileColumn) * TERRAIN_CELL_DIVISIONS)));
  const cellRow = Math.max(0, Math.min(TERRAIN_CELL_DIVISIONS - 1, Math.floor((yPosition - tileRow) * TERRAIN_CELL_DIVISIONS)));
  return terrainIndex.get(terrainCellId(TERRAIN_TILE_ZOOM, tileColumn, tileRow, cellColumn, cellRow))?.elevationFt ?? null;
}

function addGroundElevations(buildings: Building[], origin: Origin, terrainIndex: Map<string, TerrainCell>) {
  return buildings.map((building) => {
    const samples: Point[] = [{ x: building.x, y: building.y }];
    building.envelopes.forEach((envelope) => {
      const stride = Math.max(1, Math.ceil(envelope.length / 16));
      for (let index = 0; index < envelope.length; index += stride) samples.push(envelope[index]);
    });
    const elevations = samples.flatMap((sample) => {
      const [lon, lat] = localToLngLat(sample, origin);
      const elevationFt = terrainElevationAtLngLat(lon, lat, terrainIndex);
      return elevationFt == null ? [] : [elevationFt];
    });
    return { ...building, groundElevationFt: elevations.length ? Math.max(...elevations) : undefined };
  });
}

function terrainCellFeature(cell: TerrainCell) {
  return polygon([[ [cell.west, cell.north], [cell.east, cell.north], [cell.east, cell.south], [cell.west, cell.south], [cell.west, cell.north] ]], {
    surfaceElevationFt: cell.elevationFt,
    requiredFt: cell.elevationFt + 1000,
    source: "Mapzen Terrain Tiles / USGS 3DEP",
  });
}

function boundsStudyZone(bounds: RenderBounds, origin: Origin): Zone {
  return {
    id: "rendered-study-area",
    label: "Selected conservative study area",
    source: "User-selected bounds; not an FAA designation",
    points: [
      lngLatToLocal(bounds.west, bounds.north, origin),
      lngLatToLocal(bounds.east, bounds.north, origin),
      lngLatToLocal(bounds.east, bounds.south, origin),
      lngLatToLocal(bounds.west, bounds.south, origin),
    ],
  };
}

function normalizedBounds(first: [number, number], second: [number, number]): RenderBounds {
  return {
    west: Math.min(first[0], second[0]),
    east: Math.max(first[0], second[0]),
    south: Math.min(first[1], second[1]),
    north: Math.max(first[1], second[1]),
  };
}

function mapViewportBounds(map: MapLibreMap): RenderBounds {
  const bounds = map.getBounds();
  return { west: bounds.getWest(), east: bounds.getEast(), south: bounds.getSouth(), north: bounds.getNorth() };
}

function boundsForZone(zone: Zone, origin: Origin): RenderBounds {
  const coordinates = zone.points.map((value) => localToLngLat(value, origin));
  return {
    west: Math.min(...coordinates.map(([lon]) => lon)),
    east: Math.max(...coordinates.map(([lon]) => lon)),
    south: Math.min(...coordinates.map(([, lat]) => lat)),
    north: Math.max(...coordinates.map(([, lat]) => lat)),
  };
}

function boundsFeature(bounds: RenderBounds, properties: Record<string, unknown> = {}) {
  return polygon([[
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
    [bounds.west, bounds.north],
  ]], properties);
}

function terrainCellIntersectsBounds(cell: TerrainCell, bounds: RenderBounds) {
  return cell.west < bounds.east && cell.east > bounds.west && cell.south < bounds.north && cell.north > bounds.south;
}

export function AirspacePlanner() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renderAreaRef = useRef<(bounds: RenderBounds) => Promise<boolean>>(async () => false);
  const drawingAreaRef = useRef(false);
  const selectionStartRef = useRef<[number, number] | null>(null);
  const coverageBoundsRef = useRef<{ west: number; east: number; south: number; north: number } | null>(null);
  const terrainCoverageBoundsRef = useRef<{ west: number; east: number; south: number; north: number } | null>(null);
  const loadedTileKeyRef = useRef<string | null>(null);
  const loadedViewportKeyRef = useRef<string | null>(null);
  const pendingTileKeyRef = useRef<string | null>(null);
  const loadedTerrainTileKeyRef = useRef<string | null>(null);
  const pendingTerrainTileKeyRef = useRef<string | null>(null);
  const liveDataRef = useRef({ altitudeFt: 1800, buildings: [] as Building[], zones: [] as Zone[], origin: CHICAGO_ORIGIN, sourceMode: "overture" as "overture" | "local" });
  const [altitudeFt, setAltitudeFt] = useState(1800);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [origin, setOrigin] = useState<Origin>(CHICAGO_ORIGIN);
  const [datasetName, setDatasetName] = useState("Overture Maps · automatic");
  const [dataNote, setDataNote] = useState("Select an area, then render building coverage");
  const [coverageStatus, setCoverageStatus] = useState<CoverageStatus>("idle");
  const [terrainCells, setTerrainCells] = useState<TerrainCell[]>([]);
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus>("idle");
  const [terrainNote, setTerrainNote] = useState("Surface elevations render only for the selected area");
  const [sourceMode, setSourceMode] = useState<"overture" | "local">("overture");
  const [overtureRelease, setOvertureRelease] = useState(OVERTURE_FALLBACK_RELEASE);
  const [selectedLngLat, setSelectedLngLat] = useState<[number, number]>(localToLngLat({ x: 80, y: 160 }, CHICAGO_ORIGIN));
  const [importError, setImportError] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [basemapError, setBasemapError] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>("street");
  const [selectedBounds, setSelectedBounds] = useState<RenderBounds | null>(null);
  const [renderedBounds, setRenderedBounds] = useState<RenderBounds | null>(null);
  const [drawingArea, setDrawingArea] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress>({ active: false, value: 0, label: "Ready" });
  const [renderError, setRenderError] = useState("");

  useEffect(() => {
    liveDataRef.current = { altitudeFt, buildings, zones, origin, sourceMode };
  }, [altitudeFt, buildings, zones, origin, sourceMode]);

  useEffect(() => {
    drawingAreaRef.current = drawingArea;
    if (!mapRef.current) return;
    if (drawingArea) mapRef.current.dragPan.disable();
    else mapRef.current.dragPan.enable();
  }, [drawingArea]);

  useEffect(() => {
    if (!drawingArea) return;
    const cancelDrawing = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      selectionStartRef.current = null;
      setDrawingArea(false);
    };
    window.addEventListener("keydown", cancelDrawing);
    return () => window.removeEventListener("keydown", cancelDrawing);
  }, [drawingArea]);

  const selected = useMemo(() => lngLatToLocal(selectedLngLat[0], selectedLngLat[1], origin), [selectedLngLat, origin]);
  const terrainIndex = useMemo(() => new Map(terrainCells.map((cell) => [cell.id, cell])), [terrainCells]);
  const modeledBuildings = useMemo(() => addGroundElevations(buildings, origin, terrainIndex), [buildings, origin, terrainIndex]);
  const selectedSurfaceElevationFt = useMemo(() => terrainElevationAtLngLat(selectedLngLat[0], selectedLngLat[1], terrainIndex), [selectedLngLat, terrainIndex]);
  const buildingCoverageAvailable = sourceMode === "local" || coverageStatus === "ready";
  const modelAvailable = Boolean(renderedBounds) && buildingCoverageAvailable && terrainStatus === "ready";
  const check = useMemo<Check>(
    () => modelAvailable ? evaluatePoint(selected, altitudeFt, modeledBuildings, zones, selectedSurfaceElevationFt) : { state: "unavailable" },
    [modelAvailable, selected, altitudeFt, modeledBuildings, zones, selectedSurfaceElevationFt],
  );
  const activeObstacles = useMemo(() => modeledBuildings.filter((building) => {
    const topElevationFt = buildingTopElevationFt(building);
    return topElevationFt != null && altitudeFt < topElevationFt + 1000;
  }).length, [altitudeFt, modeledBuildings]);
  const flaggedSquareMiles = useMemo(() => estimateFlaggedSquareMiles(altitudeFt, modeledBuildings, zones, origin, terrainIndex), [altitudeFt, modeledBuildings, zones, origin, terrainIndex]);
  const buildingsGeoJson = useMemo(
    () => sourceMode === "local" ? featureCollection(modeledBuildings.map((building) => buildingFeature(building, origin))) : emptyFeatures(),
    [modeledBuildings, origin, sourceMode],
  );
  const zonesGeoJson = useMemo(() => featureCollection(zones.map((zone) => zoneFeature(zone, origin))), [zones, origin]);
  const selectionGeoJson = useMemo(() => selectedBounds ? featureCollection([boundsFeature(selectedBounds, { state: "selection" })]) : emptyFeatures(), [selectedBounds]);
  const selectedGeoJson = useMemo(() => featureCollection([point(localToLngLat(selected, origin), { state: check.state })]), [selected, origin, check.state]);
  const conflictsGeoJson = useMemo(() => {
    if (!modelAvailable) return emptyFeatures();
    const features: Array<Feature<Polygon | MultiPolygon>> = [];
    terrainCells.forEach((cell) => {
      if (renderedBounds && terrainCellIntersectsBounds(cell, renderedBounds) && altitudeFt < cell.elevationFt + 1000) features.push(terrainCellFeature(cell));
    });
    const active = modeledBuildings.filter((building) => {
      const topElevationFt = buildingTopElevationFt(building);
      return topElevationFt != null && altitudeFt < topElevationFt + 1000;
    });
    const displayBuildings = active.length > 500 ? groupDenseBuildings(active) : active;
    displayBuildings.forEach((building) => {
      const expanded = buffer(buildingFeature(building, origin), CLEARANCE_DISTANCE_FT, { units: "feet", steps: 12 });
      if (!expanded) return;
      zones.forEach((zone) => {
        const clipped = intersect(featureCollection([expanded, zoneFeature(zone, origin)]));
        if (clipped) {
          const topElevationFt = buildingTopElevationFt(building);
          clipped.properties = { building: building.name, heightFt: building.heightFt, groundElevationFt: building.groundElevationFt, topElevationFt, requiredFt: topElevationFt == null ? null : topElevationFt + 1000 };
          features.push(clipped);
        }
      });
    });
    return dissolveConflictFeatures(features);
  }, [modelAvailable, altitudeFt, modeledBuildings, terrainCells, renderedBounds, zones, origin]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    let disposed = false;
    let loadSerial = 0;
    let terrainLoadSerial = 0;
    let areaRenderSerial = 0;
    Promise.all([
      import("maplibre-gl"),
      import("pmtiles"),
      import("@mapbox/vector-tile"),
      import("pbf"),
      fetch(OVERTURE_CATALOG_URL).then((response) => response.ok ? response.json() : null).catch(() => null),
    ]).then(([maplibregl, { PMTiles }, { VectorTile }, { PbfReader }, catalog]) => {
      if (disposed || !mapContainerRef.current) return;
      maplibregl.setWorkerUrl(maplibreWorkerUrl);
      const release = typeof catalog?.latest === "string" ? catalog.latest : OVERTURE_FALLBACK_RELEASE;
      const tilesUrl = `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}/buildings.pmtiles`;
      setOvertureRelease(release);
      setDatasetName(`Overture Maps · ${release}`);
      const archive = new PMTiles(tilesUrl);
      let fullTileZoom = 14;
      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: {
          version: 8,
          sources: {
            "carto-positron": {
              type: "raster",
              tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png"],
              tileSize: 256,
              maxzoom: 20,
              attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
            },
            "faa-sectional": {
              type: "raster",
              tiles: [FAA_SECTIONAL_TILE_URL],
              tileSize: 256,
              minzoom: 8,
              maxzoom: 12,
              attribution: '<a href="https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/" target="_blank">FAA VFR Sectional</a>',
            },
            "faa-terminal": {
              type: "raster",
              tiles: [FAA_TERMINAL_TILE_URL],
              tileSize: 256,
              minzoom: 10,
              maxzoom: 12,
              attribution: '<a href="https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/" target="_blank">FAA VFR Terminal Area Charts</a>',
            },
          },
          layers: [
            { id: "carto-positron", type: "raster", source: "carto-positron", minzoom: 0 },
            { id: "faa-sectional", type: "raster", source: "faa-sectional", minzoom: 8, layout: { visibility: "none" } },
            { id: "faa-terminal", type: "raster", source: "faa-terminal", minzoom: 10, layout: { visibility: "none" } },
          ],
        },
        center: [CHICAGO_ORIGIN.lon, CHICAGO_ORIGIN.lat],
        zoom: 14.2,
        maxZoom: 24,
        pitch: 0,
        bearing: 0,
        attributionControl: { customAttribution: '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank">Terrain © Mapzen · USGS 3DEP</a>' },
      });
      mapRef.current = map;

      const loadVisibleTerrainTiles = async (selection: RenderBounds, onProgress?: (value: number) => void) => {
        const center = { lat: (selection.south + selection.north) / 2, lng: (selection.west + selection.east) / 2 };
        const clearanceLatPadding = CLEARANCE_DISTANCE_FT / FEET_PER_LAT_DEGREE;
        const clearanceLonPadding = CLEARANCE_DISTANCE_FT / Math.max(1, feetPerLonDegree(center.lat));
        const requiredCoverage = {
          west: selection.west - clearanceLonPadding,
          east: selection.east + clearanceLonPadding,
          south: selection.south - clearanceLatPadding,
          north: selection.north + clearanceLatPadding,
        };
        const previousCoverage = terrainCoverageBoundsRef.current;
        const alreadyCovered = Boolean(previousCoverage
          && requiredCoverage.west >= previousCoverage.west
          && requiredCoverage.east <= previousCoverage.east
          && requiredCoverage.south >= previousCoverage.south
          && requiredCoverage.north <= previousCoverage.north);
        const clearTerrain = () => {
          terrainLoadSerial += 1;
          terrainCoverageBoundsRef.current = null;
          loadedTerrainTileKeyRef.current = null;
          pendingTerrainTileKeyRef.current = null;
          setTerrainCells([]);
        };
        if (alreadyCovered && loadedTerrainTileKeyRef.current) {
          if (pendingTerrainTileKeyRef.current) {
            terrainLoadSerial += 1;
            pendingTerrainTileKeyRef.current = null;
            setTerrainNote("Using already-loaded bare-earth elevation coverage");
          }
          setTerrainStatus("ready");
          onProgress?.(1);
          return true;
        }
        const maxTile = (2 ** TERRAIN_TILE_ZOOM) - 1;
        const minX = Math.max(0, Math.min(maxTile, tileX(requiredCoverage.west, TERRAIN_TILE_ZOOM)));
        const maxX = Math.max(0, Math.min(maxTile, tileX(requiredCoverage.east, TERRAIN_TILE_ZOOM)));
        const minY = Math.max(0, Math.min(maxTile, tileY(requiredCoverage.north, TERRAIN_TILE_ZOOM)));
        const maxY = Math.max(0, Math.min(maxTile, tileY(requiredCoverage.south, TERRAIN_TILE_ZOOM)));
        const visibleTileCount = (maxX - minX + 1) * (maxY - minY + 1);
        if (visibleTileCount <= 0 || visibleTileCount > MAX_VISIBLE_OVERTURE_TILES) {
          clearTerrain();
          setTerrainStatus("zoom-required");
          setTerrainNote(`Selected area spans ${visibleTileCount.toLocaleString()} elevation tiles · select an area using ${MAX_VISIBLE_OVERTURE_TILES} or fewer`);
          return false;
        }
        const coordinates: Array<{ x: number; y: number }> = [];
        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) coordinates.push({ x, y });
        }
        const tileKey = coordinates.map(({ x, y }) => `${TERRAIN_TILE_ZOOM}/${x}/${y}`).join("|");
        if (loadedTerrainTileKeyRef.current === tileKey) {
          terrainCoverageBoundsRef.current = {
            west: Math.min(previousCoverage?.west ?? requiredCoverage.west, requiredCoverage.west),
            east: Math.max(previousCoverage?.east ?? requiredCoverage.east, requiredCoverage.east),
            south: Math.min(previousCoverage?.south ?? requiredCoverage.south, requiredCoverage.south),
            north: Math.max(previousCoverage?.north ?? requiredCoverage.north, requiredCoverage.north),
          };
          setTerrainStatus("ready");
          onProgress?.(1);
          return true;
        }
        if (pendingTerrainTileKeyRef.current === tileKey) return false;
        const requestId = ++terrainLoadSerial;
        pendingTerrainTileKeyRef.current = tileKey;
        setTerrainStatus("loading");
        setTerrainNote(`Loading ${coordinates.length} bare-earth elevation tile${coordinates.length === 1 ? "" : "s"}…`);
        try {
          let fetched = 0;
          const loaded = await mapWithConcurrency(coordinates, TERRAIN_FETCH_CONCURRENCY, async ({ x, y }) => {
            const raster = await loadTerrainTile(TERRAIN_TILE_ZOOM, x, y);
            fetched += 1;
            onProgress?.(0.45 * (fetched / coordinates.length));
            return { x, y, raster };
          });
          if (disposed || requestId !== terrainLoadSerial) return false;
          if (loaded.some(({ raster }) => !raster)) throw new Error("One or more terrain tiles were unavailable.");
          const completeTiles = loaded as Array<{ x: number; y: number; raster: TerrainRaster }>;
          const cells = await terrainCellsFromTiles(completeTiles, TERRAIN_TILE_ZOOM, (value) => onProgress?.(0.45 + value * 0.55));
          if (disposed || requestId !== terrainLoadSerial) return false;
          setTerrainCells(cells);
          loadedTerrainTileKeyRef.current = tileKey;
          pendingTerrainTileKeyRef.current = null;
          terrainCoverageBoundsRef.current = requiredCoverage;
          setTerrainStatus("ready");
          setTerrainNote(`${cells.length.toLocaleString()} conservative surface cells · ${coordinates.length} z${TERRAIN_TILE_ZOOM} elevation tile${coordinates.length === 1 ? "" : "s"}`);
          onProgress?.(1);
          return true;
        } catch (error) {
          console.error("Terrain tile load failed", error);
          if (!disposed && requestId === terrainLoadSerial) {
            clearTerrain();
            setTerrainStatus("error");
            setTerrainNote("Bare-earth elevation tiles could not be reached. Reload to try again.");
          }
          return false;
        }
      };

      const loadVisibleBuildingTiles = async (selection: RenderBounds, onProgress?: (value: number) => void) => {
        if (liveDataRef.current.sourceMode !== "overture" || !map.getSource("overture-buildings")) return false;
        const center = { lat: (selection.south + selection.north) / 2, lng: (selection.west + selection.east) / 2 };
        const nextOrigin = { lat: center.lat, lon: center.lng };
        const source = map.getSource("overture-buildings") as GeoJSONSource;
        const viewportKey = [
          selection.west,
          selection.south,
          selection.east,
          selection.north,
        ].map((value) => value.toFixed(6)).join(":");
        const clearanceLatPadding = CLEARANCE_DISTANCE_FT / FEET_PER_LAT_DEGREE;
        const clearanceLonPadding = CLEARANCE_DISTANCE_FT / Math.max(1, feetPerLonDegree(center.lat));
        const requiredCoverage = {
          west: selection.west - clearanceLonPadding,
          east: selection.east + clearanceLonPadding,
          south: selection.south - clearanceLatPadding,
          north: selection.north + clearanceLatPadding,
        };
        const previousCoverage = coverageBoundsRef.current;
        const viewportAlreadyCovered = Boolean(previousCoverage
          && requiredCoverage.west >= previousCoverage.west
          && requiredCoverage.east <= previousCoverage.east
          && requiredCoverage.south >= previousCoverage.south
          && requiredCoverage.north <= previousCoverage.north);
        const clearCoverage = () => {
          loadSerial += 1;
          coverageBoundsRef.current = null;
          loadedTileKeyRef.current = null;
          loadedViewportKeyRef.current = null;
          pendingTileKeyRef.current = null;
          source.setData(emptyFeatures());
          setOrigin(nextOrigin);
          setBuildings([]);
          setZones([boundsStudyZone(selection, nextOrigin)]);
        };
        if (viewportAlreadyCovered && loadedTileKeyRef.current) {
          const cancelledRefresh = Boolean(pendingTileKeyRef.current);
          if (cancelledRefresh) {
            loadSerial += 1;
            pendingTileKeyRef.current = null;
          }
          const stableOrigin = liveDataRef.current.origin;
          setZones([boundsStudyZone(selection, stableOrigin)]);
          loadedViewportKeyRef.current = viewportKey;
          setCoverageStatus("ready");
          if (cancelledRefresh) setDataNote("Using already-loaded full-detail coverage · no tile reload needed");
          onProgress?.(1);
          return true;
        }
        const zoom = fullTileZoom;
        const maxTile = (2 ** zoom) - 1;
        const minX = Math.max(0, Math.min(maxTile, tileX(requiredCoverage.west, zoom)));
        const maxX = Math.max(0, Math.min(maxTile, tileX(requiredCoverage.east, zoom)));
        const minY = Math.max(0, Math.min(maxTile, tileY(requiredCoverage.north, zoom)));
        const maxY = Math.max(0, Math.min(maxTile, tileY(requiredCoverage.south, zoom)));
        const visibleTileCount = (maxX - minX + 1) * (maxY - minY + 1);
        if (visibleTileCount <= 0 || visibleTileCount > MAX_VISIBLE_OVERTURE_TILES) {
          clearCoverage();
          setCoverageStatus("zoom-required");
          setDataNote(`Selected area plus the 2,000-ft clearance halo spans ${visibleTileCount.toLocaleString()} full-detail tiles · select an area using ${MAX_VISIBLE_OVERTURE_TILES} or fewer`);
          return false;
        }
        const coordinates: Array<{ x: number; y: number }> = [];
        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) coordinates.push({ x, y });
        }
        const tileKey = `${release}:${coordinates.map(({ x, y }) => `${zoom}/${x}/${y}`).join("|")}`;
        if (loadedTileKeyRef.current === tileKey) {
          if (loadedViewportKeyRef.current !== viewportKey) {
            const stableOrigin = liveDataRef.current.origin;
            setZones([boundsStudyZone(selection, stableOrigin)]);
            coverageBoundsRef.current = {
              west: Math.min(previousCoverage?.west ?? requiredCoverage.west, requiredCoverage.west),
              east: Math.max(previousCoverage?.east ?? requiredCoverage.east, requiredCoverage.east),
              south: Math.min(previousCoverage?.south ?? requiredCoverage.south, requiredCoverage.south),
              north: Math.max(previousCoverage?.north ?? requiredCoverage.north, requiredCoverage.north),
            };
            loadedViewportKeyRef.current = viewportKey;
          }
          setCoverageStatus("ready");
          onProgress?.(1);
          return true;
        }
        if (pendingTileKeyRef.current === tileKey) return false;
        const requestId = ++loadSerial;
        pendingTileKeyRef.current = tileKey;
        setCoverageStatus("loading");
        setDataNote(`Loading ${coordinates.length} selected-area Overture tile${coordinates.length === 1 ? "" : "s"}…`);
        try {
          let fetched = 0;
          const tiles = await Promise.all(coordinates.map(async ({ x, y }) => {
            const tile = await loadCachedOvertureTile(
              `${release}:${zoom}/${x}/${y}`,
              async () => (await archive.getZxy(zoom, x, y))?.data || null,
            );
            fetched += 1;
            onProgress?.(0.45 * (fetched / coordinates.length));
            return { x, y, tile };
          }));
          if (disposed || requestId !== loadSerial) return false;
          const decoded: Array<Feature<Polygon | MultiPolygon>> = [];
          for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
            const { x, y, tile } = tiles[tileIndex];
            if (!tile) continue;
            const vectorTile = new VectorTile(new PbfReader(new Uint8Array(tile)));
            (["building", "building_part"] as const).forEach((sourceLayer) => {
              const layer = vectorTile.layers[sourceLayer];
              if (!layer) return;
              for (let index = 0; index < layer.length; index += 1) {
                const vectorFeature = layer.feature(index);
                const geojson = vectorFeature.toGeoJSON(x, y, zoom);
                if (geojson.geometry.type !== "Polygon" && geojson.geometry.type !== "MultiPolygon") continue;
                const raw = (geojson.properties || {}) as Record<string, unknown>;
                const isUnderground = raw.is_underground === true || raw.is_underground === "true";
                const hasParts = raw.has_parts === true || raw.has_parts === "true";
                if (isUnderground || (sourceLayer === "building" && hasParts)) continue;
                const height = propertyHeight(raw);
                geojson.properties = {
                  id: raw.id || vectorFeature.id || `${zoom}/${x}/${y}/${sourceLayer}/${index}`,
                  name: raw.name,
                  "@name": raw["@name"],
                  names: raw.names,
                  height: raw.height,
                  height_m: raw.height_m,
                  height_ft: raw.height_ft,
                  num_floors: raw.num_floors,
                  "building:levels": raw["building:levels"],
                  __sourceLayer: sourceLayer,
                  __renderHeightM: height.feet / 3.28084,
                };
                decoded.push(geojson as Feature<Polygon | MultiPolygon>);
              }
            });
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            onProgress?.(0.45 + 0.55 * ((tileIndex + 1) / tiles.length));
            if (disposed || requestId !== loadSerial) return false;
          }
          const nextBuildings = overtureBuildingsFromFeatures(decoded, nextOrigin);
          const measured = nextBuildings.filter((building) => building.heightSource !== "30 ft fallback").length;
          source.setData(featureCollection(decoded));
          setOrigin(nextOrigin);
          setBuildings(nextBuildings);
          setZones([boundsStudyZone(selection, nextOrigin)]);
          loadedTileKeyRef.current = tileKey;
          loadedViewportKeyRef.current = viewportKey;
          pendingTileKeyRef.current = null;
          coverageBoundsRef.current = requiredCoverage;
          setCoverageStatus("ready");
          setDatasetName(`Overture Maps · ${release}`);
          setDataNote(`${nextBuildings.length.toLocaleString()} selected-area envelopes · ${measured.toLocaleString()} with height/floor data · ${coordinates.length} full-detail z${zoom} tile${coordinates.length === 1 ? "" : "s"}`);
          onProgress?.(1);
          return true;
        } catch (error) {
          console.error("Overture building tile load failed", error);
          if (!disposed && requestId === loadSerial) {
            pendingTileKeyRef.current = null;
            if (viewportAlreadyCovered) {
              setCoverageStatus("ready");
              setDataNote("Using previously loaded coverage · refresh unavailable");
            } else {
              clearCoverage();
              setCoverageStatus("error");
              setDataNote("Overture building tiles could not be reached. Reload to try again.");
            }
          }
          return false;
        }
      };

      renderAreaRef.current = async (selection: RenderBounds) => {
        const renderId = ++areaRenderSerial;
        setRenderError("");
        setRenderedBounds(null);
        setTerrainStatus("loading");
        setTerrainNote("Waiting to render surface elevations…");
        setRenderProgress({ active: true, value: 2, label: "Preparing selected area" });
        let buildingsReady = true;
        if (liveDataRef.current.sourceMode === "overture") {
          buildingsReady = await loadVisibleBuildingTiles(selection, (value) => {
            if (renderId === areaRenderSerial) setRenderProgress({ active: true, value: Math.round(2 + value * 47), label: value < 0.45 ? "Loading building tiles" : "Decoding building envelopes" });
          });
        } else {
          const stableOrigin = liveDataRef.current.origin;
          setZones([boundsStudyZone(selection, stableOrigin)]);
          setCoverageStatus("ready");
          setRenderProgress({ active: true, value: 49, label: "Local building envelopes ready" });
        }
        if (!buildingsReady || disposed || renderId !== areaRenderSerial) {
          if (!disposed && renderId === areaRenderSerial) {
            setRenderError("The selected building coverage could not be rendered.");
            setRenderProgress({ active: false, value: 0, label: "Render failed" });
          }
          return false;
        }
        const terrainReady = await loadVisibleTerrainTiles(selection, (value) => {
          if (renderId === areaRenderSerial) setRenderProgress({ active: true, value: Math.round(50 + value * 49), label: value < 0.45 ? "Loading elevation tiles" : "Screening surface elevations" });
        });
        if (!terrainReady || disposed || renderId !== areaRenderSerial) {
          if (!disposed && renderId === areaRenderSerial) {
            setRenderError("The selected surface coverage could not be rendered.");
            setRenderProgress({ active: false, value: 0, label: "Render failed" });
          }
          return false;
        }
        setRenderedBounds(selection);
        setSelectedLngLat([(selection.west + selection.east) / 2, (selection.south + selection.north) / 2]);
        setRenderProgress({ active: true, value: 100, label: "Render complete" });
        setTimeout(() => {
          if (!disposed && renderId === areaRenderSerial) setRenderProgress({ active: false, value: 100, label: "Render complete" });
        }, 700);
        return true;
      };

      map.on("style.load", () => {
        setBasemapError(false);
        requestAnimationFrame(async () => {
          try {
            const header = await archive.getHeader();
            fullTileZoom = header.maxZoom;
            const beforeId = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
            map.addSource("overture-buildings", { type: "geojson", data: emptyFeatures(), attribution: '<a href="https://docs.overturemaps.org/attribution" target="_blank">© Overture Maps Foundation</a>' });
            map.addSource("clearance-zones", { type: "geojson", data: emptyFeatures() });
            map.addSource("clearance-conflicts", { type: "geojson", data: emptyFeatures() });
            map.addSource("clearance-buildings", { type: "geojson", data: emptyFeatures() });
            map.addSource("clearance-selected", { type: "geojson", data: emptyFeatures() });
            map.addSource("clearance-selection", { type: "geojson", data: emptyFeatures() });
            map.addLayer({ id: "clearance-zone-fill", type: "fill", source: "clearance-zones", paint: { "fill-color": "#c08a2c", "fill-opacity": 0.07 } }, beforeId);
            map.addLayer({ id: "clearance-zone-line", type: "line", source: "clearance-zones", paint: { "line-color": "#8f6b28", "line-width": 1.25, "line-dasharray": [3, 2] } }, beforeId);
            map.addLayer({ id: "clearance-selection-fill", type: "fill", source: "clearance-selection", paint: { "fill-color": "#276f9e", "fill-opacity": 0.08 } }, beforeId);
            map.addLayer({ id: "clearance-selection-line", type: "line", source: "clearance-selection", paint: { "line-color": "#276f9e", "line-width": 2, "line-dasharray": [2, 1.5] } }, beforeId);
            map.addLayer({ id: "clearance-conflict-fill", type: "fill", source: "clearance-conflicts", paint: { "fill-color": "#df3d33", "fill-opacity": 0.25 } }, beforeId);
            map.addLayer({ id: "clearance-conflict-line", type: "line", source: "clearance-conflicts", filter: ["!", ["has", "source"]], paint: { "line-color": "#bd3028", "line-width": 1 } }, beforeId);
            map.addLayer({ id: "overture-building-fill", type: "fill", source: "overture-buildings", filter: ["==", ["get", "__sourceLayer"], "building"], paint: { "fill-color": ["step", ["get", "__renderHeightM"], "#89908e", 107, "#4e585c", 244, "#182229"], "fill-opacity": 0.84 } }, beforeId);
            map.addLayer({ id: "overture-building-part-fill", type: "fill", source: "overture-buildings", filter: ["==", ["get", "__sourceLayer"], "building_part"], paint: { "fill-color": ["step", ["get", "__renderHeightM"], "#7f8886", 107, "#465156", 244, "#111b21"], "fill-opacity": 0.9 } }, beforeId);
            map.addLayer({ id: "overture-building-line", type: "line", source: "overture-buildings", filter: ["==", ["get", "__sourceLayer"], "building"], paint: { "line-color": "#ffffff", "line-width": 0.65, "line-opacity": 0.72 } }, beforeId);
            map.addLayer({ id: "clearance-building-fill", type: "fill", source: "clearance-buildings", paint: { "fill-color": ["step", ["get", "heightFt"], "#89908e", 350, "#4e585c", 800, "#182229"], "fill-opacity": 0.9 } }, beforeId);
            map.addLayer({ id: "clearance-building-line", type: "line", source: "clearance-buildings", paint: { "line-color": "#ffffff", "line-width": 0.65, "line-opacity": 0.72 } }, beforeId);
            map.addLayer({ id: "clearance-selected-outer", type: "circle", source: "clearance-selected", paint: { "circle-radius": 10, "circle-color": "#fffdf7", "circle-stroke-width": 4, "circle-stroke-color": ["match", ["get", "state"], "conflict", "#d82f29", "clear", "#176b59", "unavailable", "#c08a2c", "#182229"] } });
            map.addLayer({ id: "clearance-selected-inner", type: "circle", source: "clearance-selected", paint: { "circle-radius": 3, "circle-color": ["match", ["get", "state"], "conflict", "#d82f29", "clear", "#176b59", "unavailable", "#c08a2c", "#182229"] } });
            setCoverageStatus("idle");
            setTerrainStatus("idle");
            setMapReady(true);
          } catch (error) {
            console.error("Clearance map layer setup failed", error);
            setCoverageStatus("error");
            setDataNote("Overture building archive could not be reached. Reload to try again.");
          }
        });
      });
      let suppressNextClick = false;
      map.on("mousedown", (event) => {
        if (!drawingAreaRef.current) return;
        event.preventDefault();
        selectionStartRef.current = [event.lngLat.lng, event.lngLat.lat];
        setSelectedBounds(normalizedBounds(selectionStartRef.current, selectionStartRef.current));
      });
      map.on("mousemove", (event) => {
        if (!drawingAreaRef.current || !selectionStartRef.current) return;
        setSelectedBounds(normalizedBounds(selectionStartRef.current, [event.lngLat.lng, event.lngLat.lat]));
      });
      map.on("mouseup", (event) => {
        if (!drawingAreaRef.current || !selectionStartRef.current) return;
        setSelectedBounds(normalizedBounds(selectionStartRef.current, [event.lngLat.lng, event.lngLat.lat]));
        selectionStartRef.current = null;
        drawingAreaRef.current = false;
        setDrawingArea(false);
        map.dragPan.enable();
        suppressNextClick = true;
      });
      map.on("click", (event) => {
        if (suppressNextClick) {
          suppressNextClick = false;
          return;
        }
        if (drawingAreaRef.current) return;
        setSelectedLngLat([event.lngLat.lng, event.lngLat.lat]);
      });
      map.on("error", (event) => {
        const message = event.error?.message || "Unknown map error";
        console.error("Clearance map error", message);
        if (!map.isStyleLoaded()) setBasemapError(true);
      });
    }).catch(() => {
      if (!disposed) setBasemapError(true);
    });
    return () => {
      disposed = true;
      loadSerial += 1;
      terrainLoadSerial += 1;
      areaRenderSerial += 1;
      renderAreaRef.current = async () => false;
      drawingAreaRef.current = false;
      selectionStartRef.current = null;
      loadedTileKeyRef.current = null;
      loadedViewportKeyRef.current = null;
      pendingTileKeyRef.current = null;
      terrainCoverageBoundsRef.current = null;
      loadedTerrainTileKeyRef.current = null;
      pendingTerrainTileKeyRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    (mapRef.current.getSource("clearance-zones") as GeoJSONSource)?.setData(zonesGeoJson);
    (mapRef.current.getSource("clearance-conflicts") as GeoJSONSource)?.setData(conflictsGeoJson);
    (mapRef.current.getSource("clearance-buildings") as GeoJSONSource)?.setData(buildingsGeoJson);
    (mapRef.current.getSource("clearance-selected") as GeoJSONSource)?.setData(selectedGeoJson);
    (mapRef.current.getSource("clearance-selection") as GeoJSONSource)?.setData(selectionGeoJson);
    ["clearance-building-fill", "clearance-building-line"].forEach((id) => {
      if (mapRef.current?.getLayer(id)) mapRef.current.setLayoutProperty(id, "visibility", sourceMode === "local" ? "visible" : "none");
    });
    ["overture-building-fill", "overture-building-part-fill", "overture-building-line"].forEach((id) => {
      if (mapRef.current?.getLayer(id)) mapRef.current.setLayoutProperty(id, "visibility", sourceMode === "overture" ? "visible" : "none");
    });
  }, [mapReady, zonesGeoJson, conflictsGeoJson, buildingsGeoJson, selectedGeoJson, selectionGeoJson, sourceMode]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const streetVisibility = basemap === "street" ? "visible" : "none";
    const faaVisibility = basemap === "sectional" ? "visible" : "none";
    if (mapRef.current.getLayer("carto-positron")) mapRef.current.setLayoutProperty("carto-positron", "visibility", streetVisibility);
    ["faa-sectional", "faa-terminal"].forEach((id) => {
      if (mapRef.current?.getLayer(id)) mapRef.current.setLayoutProperty(id, "visibility", faaVisibility);
    });
  }, [basemap, mapReady]);

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportError("");
    try {
      const text = await file.text();
      const imported = file.name.toLowerCase().endsWith(".csv") ? parseCsv(text) : parseGeoJson(text);
      if (!imported.buildings.length) throw new Error("No usable building records were found.");
      setSourceMode("local");
      coverageBoundsRef.current = null;
      loadedTileKeyRef.current = null;
      loadedViewportKeyRef.current = null;
      pendingTileKeyRef.current = null;
      const importedZone = makeConservativeZone(imported.buildings, "Imported conservative study area");
      setCoverageStatus("idle");
      setBuildings(imported.buildings);
      setOrigin(imported.origin);
      setZones([]);
      setSelectedBounds(boundsForZone(importedZone, imported.origin));
      setRenderedBounds(null);
      setDatasetName(file.name);
      setDataNote(`${imported.buildings.length.toLocaleString()} buildings · ${imported.note} · press Render`);
      setSelectedLngLat([imported.origin.lon, imported.origin.lat]);
      setTerrainCells([]);
      setTerrainStatus("idle");
      setTerrainNote("Surface elevations render only after you press Render");
      setRenderError("");
      mapRef.current?.flyTo({ center: [imported.origin.lon, imported.origin.lat], zoom: 15, essential: true });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "This file could not be read.");
    } finally {
      event.target.value = "";
    }
  }

  function activateOverture() {
    const center = mapRef.current?.getCenter();
    const nextOrigin = center ? { lat: center.lat, lon: center.lng } : CHICAGO_ORIGIN;
    setSourceMode("overture");
    coverageBoundsRef.current = null;
    loadedTileKeyRef.current = null;
    loadedViewportKeyRef.current = null;
    pendingTileKeyRef.current = null;
    setCoverageStatus("idle");
    setBuildings([]);
    setOrigin(nextOrigin);
    setZones([]);
    setSelectedBounds(mapRef.current ? mapViewportBounds(mapRef.current) : null);
    setRenderedBounds(null);
    setDatasetName(`Overture Maps · ${overtureRelease}`);
    setDataNote("Area selected · press Render to load building coverage");
    setSelectedLngLat([nextOrigin.lon, nextOrigin.lat]);
    setTerrainCells([]);
    setTerrainStatus("idle");
    setTerrainNote("Surface elevations render only after you press Render");
    setImportError("");
    setRenderError("");
    mapRef.current?.triggerRepaint();
  }

  function beginAreaSelection() {
    if (!mapReady || renderProgress.active) return;
    setRenderError("");
    setDrawingArea((current) => !current);
    selectionStartRef.current = null;
  }

  function useCurrentView() {
    if (!mapRef.current || renderProgress.active) return;
    setDrawingArea(false);
    selectionStartRef.current = null;
    setSelectedBounds(mapViewportBounds(mapRef.current));
    setRenderError("");
  }

  async function renderSelectedArea() {
    if (!selectedBounds || renderProgress.active) return;
    setDrawingArea(false);
    selectionStartRef.current = null;
    await renderAreaRef.current(selectedBounds);
  }

  function downloadTemplate() {
    const csv = [
      "name,lat,lon,height_ft,width_ft,depth_ft",
      "Example Tower,41.8819,-87.6324,820,220,180",
      "Example Building,41.8832,-87.6298,240,160,140",
    ].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = "clearance-building-template.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const statusTitle = check.state === "conflict"
    ? "Modeled clearance not met"
    : check.state === "clear"
      ? "Modeled clearance met"
      : check.state === "unavailable"
        ? "Clearance not evaluated"
        : "Outside study polygons";
  const overtureCoverageLabel = coverageStatus === "idle"
    ? "Overture Maps · Awaiting render"
    : coverageStatus === "loading"
    ? "Overture Maps · Loading coverage"
    : coverageStatus === "error"
      ? "Overture Maps · Coverage unavailable"
      : coverageStatus === "ready"
        ? "Overture Maps · Coverage loaded"
        : "Overture Maps · View too wide";
  const terrainCoverageLabel = terrainStatus === "idle"
    ? "Surface elevation · Awaiting render"
    : terrainStatus === "loading"
    ? "Surface elevation · Loading"
    : terrainStatus === "error"
      ? "Surface elevation · Unavailable"
      : terrainStatus === "ready"
        ? "Surface elevation · Loaded"
        : "Surface elevation · View too wide";
  const modelDataLabel = !buildingCoverageAvailable
    ? sourceMode === "overture" ? overtureCoverageLabel : "Local buildings · Ready"
    : terrainCoverageLabel;
  const modelBadge = !renderedBounds && !renderProgress.active && coverageStatus === "idle" && terrainStatus === "idle"
    ? "RENDER"
    : !buildingCoverageAvailable
      ? coverageStatus === "loading" ? "LOADING" : coverageStatus === "error" ? "ERROR" : "NARROW AREA"
      : terrainStatus === "loading" ? "TERRAIN" : terrainStatus === "error" ? "ERROR" : terrainStatus === "idle" ? "RENDER" : "NARROW AREA";
  const unavailableMessage = modelAvailable && selectedSurfaceElevationFt == null
    ? "No decoded surface elevation is available at the selected point, so no clearance conclusion is shown."
    : !renderedBounds && coverageStatus === "idle" && terrainStatus === "idle"
      ? "Select an area on the map and press Render. The completed clearance result will remain fixed while you pan or zoom."
    : coverageStatus === "zoom-required"
    ? `The selected area and its 2,000-ft clearance halo exceed the ${MAX_VISIBLE_OVERTURE_TILES}-tile full-detail budget. Select a smaller area to evaluate clearance.`
    : terrainStatus === "zoom-required"
      ? `Surface coverage exceeds the ${MAX_VISIBLE_OVERTURE_TILES}-tile elevation budget. Select a smaller area to evaluate terrain clearance.`
      : terrainStatus === "loading"
        ? "Bare-earth surface elevations must load before clearance can be evaluated."
        : terrainStatus === "error"
          ? "Surface elevation coverage is unavailable, so no clearance conclusion is shown."
          : "Building and surface coverage must finish rendering before clearance can be evaluated.";
  const selectionIsValid = Boolean(selectedBounds
    && selectedBounds.east - selectedBounds.west > 0.000001
    && selectedBounds.north - selectedBounds.south > 0.000001);
  const selectionLabel = drawingArea
    ? "Drag across the map to draw a box"
    : selectedBounds
      ? renderedBounds ? "New area ready · current result stays until re-render" : "Area selected · ready to render"
      : "Draw a box or use the current view";

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={activateOverture} aria-label="Clearance home and use automatic Overture buildings"><span className="brand-mark" aria-hidden="true"><i /></span><span>CLEARANCE</span></button>
        <div className="rule-chip"><span>RULESET</span> FAA §91.119(b)</div>
        <div className="topbar-actions">
          <div className={`overture-status ${sourceMode === "local" ? "local" : modelAvailable ? "" : "paused"}`}><span className="status-dot" /><span><small>MODEL DATA</small>{modelDataLabel}</span></div>
          <button className="icon-button" onClick={() => setInfoOpen(true)} aria-label="About this planning aid">?</button>
          <input ref={inputRef} className="visually-hidden" type="file" accept=".csv,.geojson,.json,application/geo+json,text/csv" onChange={handleImport} />
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <div className="eyebrow-row"><span className="eyebrow">FLIGHT ALTITUDE</span><span className={`live-label ${modelAvailable ? "" : "paused"}`}><i /> ENVELOPE MODEL</span></div>
          <div className="altitude-readout"><strong>{altitudeFt.toLocaleString()}</strong><span>FT<br />MSL</span></div>
          <label className="slider-wrap"><span className="visually-hidden">Flight altitude in feet above mean sea level</span><input type="range" min="1000" max="18000" step="100" value={altitudeFt} onChange={(event) => setAltitudeFt(Number(event.target.value))} /><span className="range-labels"><b>1,000</b><b>18,000 FT MSL</b></span></label>
          <div className="preset-row" aria-label="Altitude presets">{[2000, 5000, 10000, 15000].map((preset) => <button key={preset} className={altitudeFt === preset ? "active" : ""} onClick={() => setAltitudeFt(preset)}>{preset.toLocaleString()}</button>)}</div>

          <div className="rule-block">
            <div className="rule-heading"><span className="rule-number">§</span><span><small>MODELED STANDARD</small>91.119(b) clearance</span></div>
            <div className="rule-metrics"><div><strong>1,000</strong><span>FT ABOVE</span></div><i /><div><strong>2,000</strong><span>FT FROM ENVELOPE</span></div></div>
            <p>Altitude is MSL. The model requires 1,000 ft above the bare-earth surface and above building tops within 2,000 ft horizontally.</p>
          </div>

          <div className={`point-check ${check.state}`} aria-live="polite">
            <div className="point-check-title"><span className="check-symbol">{check.state === "conflict" ? "!" : check.state === "clear" ? "✓" : check.state === "unavailable" ? "?" : "·"}</span><span><small>SELECTED POINT</small>{statusTitle}</span></div>
            {check.state === "unavailable" ? <p>{unavailableMessage}</p> : check.state !== "outside" ? <dl>
              <div><dt>Required altitude</dt><dd>{check.requiredFt?.toLocaleString()} ft MSL</dd></div>
              <div><dt>{(check.marginFt ?? 0) < 0 ? "Shortfall" : "Margin"}</dt><dd>{Math.abs(check.marginFt ?? 0).toLocaleString()} ft</dd></div>
              <div><dt>Surface cell maximum</dt><dd>{check.surfaceElevationFt?.toLocaleString()} ft MSL</dd></div>
              <div><dt>Controlling surface</dt><dd>{check.controllingSource === "building" ? check.obstacle?.name ?? "Building" : "Bare earth"}</dd></div>
              {check.obstacleTopElevationFt != null && <div><dt>Highest building top</dt><dd>{check.obstacleTopElevationFt.toLocaleString()} ft MSL</dd></div>}
              {check.obstacle && <div><dt>Distance to envelope</dt><dd>{Math.round(check.envelopeDistanceFt ?? 0).toLocaleString()} ft</dd></div>}
            </dl> : <p>Click inside a dashed amber study polygon to run the clearance screen.</p>}
          </div>

          <div className="screen-summary"><span><small>RED AREA</small><strong>{modelAvailable ? `${flaggedSquareMiles.toFixed(2)} mi²` : "—"}</strong></span><span><small>ACTIVE OBSTACLES</small><strong>{modelAvailable ? activeObstacles : "—"}</strong></span></div>

          <a className="national-source" href="https://docs.overturemaps.org/guides/buildings/" target="_blank" rel="noreferrer">
            <span className="source-kicker">AUTOMATIC NATIONAL LAYER · LIVE</span>
            <strong>Overture Maps Buildings <b>↗</b></strong>
            <span>PMTiles {overtureRelease} · footprints, heights, and building parts</span>
          </a>
          <a className="national-source terrain-source" href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noreferrer">
            <span className="source-kicker">BARE-EARTH ELEVATION · AUTOMATIC</span>
            <strong>Mapzen Terrain Tiles <b>↗</b></strong>
            <span>Terrarium z{TERRAIN_TILE_ZOOM} · U.S. elevations sourced from USGS 3DEP/NED</span>
          </a>

          <div className="panel-footer">
            <button onClick={() => setDetailsOpen((current) => !current)}>{detailsOpen ? "Hide" : "Show"} model details <span>{detailsOpen ? "−" : "+"}</span></button>
            {detailsOpen && <div className="model-details"><p>Red geometry combines conservative surface-elevation cells with a true 2,000-ft buffer around each active building footprint. Overlapping conflicts are dissolved into one layer, so the red shade stays uniform.</p><p>Airspace, temporary restrictions, weather, routes, takeoff/landing exceptions, and §91.119(a)/(c)/(d) are not modeled.</p></div>}
          </div>
        </aside>

        <section className="map-panel" aria-label="Interactive two-dimensional clearance map">
          <div ref={mapContainerRef} className={`map-container ${drawingArea ? "drawing-area" : ""}`} aria-label={`Interactive basemap at ${altitudeFt} feet MSL. Draw a selection box to render a clearance model, or click to check a point in the rendered area.`} />
          {!mapReady && !basemapError && <div className="basemap-loading"><i />Loading basemap…</div>}
          {basemapError && !mapReady && <div className="basemap-loading error">Basemap unavailable. Check your connection.</div>}
          <div className="map-titlebar"><div><span className="location-pin" aria-hidden="true" /><strong>{sourceMode === "overture" ? "Building + surface clearance" : datasetName}</strong><small>{origin.lat.toFixed(4)}° N, {Math.abs(origin.lon).toFixed(4)}° W</small></div><span className="map-mode">2D · MSL</span></div>
          <div className="map-controls" aria-label="Map zoom controls">
            <button onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in">＋</button>
            <button onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out">−</button>
            <button onClick={() => mapRef.current?.flyTo({ center: [origin.lon, origin.lat], zoom: 14.2, essential: true })} aria-label="Reset map view">◎</button>
          </div>
          <div className="basemap-switch" role="group" aria-label="Select basemap">
            <button className={basemap === "street" ? "active" : ""} aria-pressed={basemap === "street"} onClick={() => setBasemap("street")}>Street</button>
            <button className={basemap === "sectional" ? "active" : ""} aria-pressed={basemap === "sectional"} title="Sectionals with Terminal Area Charts where available" onClick={() => setBasemap("sectional")}>FAA Charts</button>
          </div>
          <section className="render-toolbar" aria-label="Render area controls">
            <div className="render-toolbar-copy"><small>RENDER AREA</small><strong>{selectionLabel}</strong></div>
            <div className="render-actions">
              <button className={drawingArea ? "active" : ""} aria-pressed={drawingArea} onClick={beginAreaSelection}>{drawingArea ? "Cancel draw" : "Draw area"}</button>
              <button onClick={useCurrentView} disabled={!mapReady || renderProgress.active}>Use view</button>
              <button className="render-primary" onClick={renderSelectedArea} disabled={!selectionIsValid || renderProgress.active}>{renderedBounds ? "Re-render" : "Render"}</button>
            </div>
            {renderedBounds && !renderProgress.active && <p className="render-persisted"><i />Rendered result is fixed until you press Re-render.</p>}
            {renderError && <p className="render-error" role="alert">{renderError}</p>}
          </section>
          {renderProgress.active && <div className="render-progress" role="status" aria-live="polite">
            <div className="render-progress-copy"><span><small>RENDERING SELECTED AREA</small><strong>{renderProgress.label}</strong></span><em>{Math.round(renderProgress.value)}%</em></div>
            <div className="render-progress-track" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, renderProgress.value))}%` }} /></div>
            <p>Buildings and terrain are being screened. The completed overlay will stay on the map until you re-render.</p>
          </div>}
          <div className="legend" aria-label="Map legend"><span><i className="legend-red" />Clearance conflict</span><span><i className="legend-amber" />Rendered area</span><span><i className="legend-blue" />Selection</span><span><i className="legend-building" />Building</span></div>
          <div className="dataset-card"><span className="dataset-icon" aria-hidden="true">▤</span><span><small>{sourceMode === "overture" ? "AUTOMATIC MODEL LAYERS" : "LOCAL BUILDINGS + TERRAIN"}</small><strong>{datasetName}</strong><em>{dataNote}</em><em>{terrainNote}</em></span>{sourceMode === "local" ? <button onClick={activateOverture}>Use Overture</button> : <span className={`data-live ${modelAvailable ? "" : "paused"}`}>{modelAvailable ? "LIVE" : modelBadge}</span>}</div>
          <div className="basemap-badge">BASEMAP · {basemap === "street" ? "CARTO / OPENSTREETMAP" : "FAA SECTIONAL + TAC"}</div>
        </section>
      </section>

      <footer className="legal-bar"><span><b>PLANNING AID ONLY</b> This screen does not determine whether a flight is legal or authorized.</span><button onClick={() => setInfoOpen(true)}>Read limitations</button></footer>
      {importError && <div className="toast error" role="alert"><span>!</span>{importError}<button onClick={() => setImportError("")} aria-label="Dismiss error">×</button></div>}

      {infoOpen && <div className="modal-backdrop">
        <button className="modal-scrim" onClick={() => setInfoOpen(false)} aria-label="Close limitations dialog" />
        <section className="info-modal" role="dialog" aria-modal="true" aria-labelledby="limitations-title">
          <button className="modal-close" onClick={() => setInfoOpen(false)} aria-label="Close">×</button>
          <span className="modal-kicker">MODEL NOTES</span>
          <h2 id="limitations-title">Full envelopes and terrain, with important limits.</h2>
          <p>The aircraft altitude is modeled in feet MSL. Required altitude is the greater of bare-earth surface elevation plus 1,000 feet, or a nearby building’s ground elevation plus its height plus 1,000 feet.</p>
          <p>GeoJSON Polygon and MultiPolygon outer footprints are preserved. The building conflict geometry begins at the closest footprint edge and buffers it by 2,000 feet.</p>
          <p>When more than 500 obstacles are active in the rendered area, nearby envelopes are conservatively grouped for the red overlay so the altitude control stays responsive. The selected-point check still tests the individual building envelopes.</p>
          <p>Terrain tiles are divided into 64×64-pixel cells. Each cell uses its highest DEM pixel, so the surface screen is intentionally conservative. DEM elevations are planning data, not surveyed obstacle or navigation values.</p>
          <p>Building and terrain evaluation use fixed full-detail tiles independent of camera zoom. Each render includes a 2,000-ft halo around the selected box so edge points can be checked; selections spanning more than {MAX_VISIBLE_OVERTURE_TILES} tiles are explicitly not evaluated.</p>
          <p>The rendered result remains fixed while you pan or zoom and changes only when you press Re-render. The FAA evaluates whether an area is “congested” case by case, so the selected box is treated as a conservative study area—not labeled as an official FAA boundary.</p>
          <div className="modal-warning"><b>Small UAS note</b><span>Part 107 generally uses a different 400-foot AGL framework and may require airspace authorization. This prototype models the Part 91 rule named above.</span></div>
          <div className="source-detail">
            <h3>Automatic national source: Overture Maps</h3>
            <p>The map loads Overture’s official global Buildings PMTiles archive for the current release. Polygon/MultiPolygon footprints, building parts, and available height fields feed the clearance model wherever the selected box and its clearance halo fit within the full-detail tile budget.</p>
            <a href="https://docs.overturemaps.org/guides/buildings/" target="_blank" rel="noreferrer">Open Overture Buildings guide ↗</a>
          </div>
          <div className="source-detail">
            <h3>Bare-earth source: Mapzen Terrain Tiles</h3>
            <p>Terrarium elevation tiles are loaded from the AWS Open Data terrain archive. United States terrain in this archive is attributed to USGS 3DEP/NED; elevations are decoded in meters and converted to feet MSL.</p>
            <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noreferrer">Open AWS terrain dataset ↗</a>
          </div>
          <div className="file-help"><h3>Advanced local override</h3><p>GeoJSON: use <code>height_ft</code>, Overture <code>height</code> (meters), <code>height_m</code>, <code>num_floors</code>, or <code>building:levels</code>. CSV: include <code>lat, lon, height_ft, width_ft, depth_ft</code>.</p><div className="file-actions"><button onClick={() => inputRef.current?.click()}>Import local file</button><button onClick={downloadTemplate}>Download CSV template</button>{sourceMode === "local" && <button onClick={activateOverture}>Return to Overture</button>}</div></div>
          <div className="modal-links"><a href="https://www.faa.gov/about/office_org/headquarters_offices/agc/practice_areas/regulations/interpretations/Data/interps/2009/Anderson_2009_Legal_Interpretation.pdf" target="_blank" rel="noreferrer">FAA Anderson interpretation ↗</a><a href="https://www.usgs.gov/3d-elevation-program" target="_blank" rel="noreferrer">USGS 3DEP ↗</a><a href="https://carto.com/basemaps/" target="_blank" rel="noreferrer">Street basemap ↗</a><a href="https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/" target="_blank" rel="noreferrer">FAA chart sources ↗</a></div>
        </section>
      </div>}
    </main>
  );
}
