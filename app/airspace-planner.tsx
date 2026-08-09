"use client";

import buffer from "@turf/buffer";
import intersect from "@turf/intersect";
import { featureCollection, multiPolygon, point, polygon } from "@turf/helpers";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
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
};
type Zone = { id: string; label: string; points: Point[]; source: string };
type Check = {
  state: "conflict" | "clear" | "outside" | "unavailable";
  zone?: Zone;
  obstacle?: Building;
  requiredFt?: number;
  marginFt?: number;
  envelopeDistanceFt?: number;
};
type ImportedDataset = { buildings: Building[]; origin: Origin; note: string };
type CoverageStatus = "loading" | "ready" | "zoom-required" | "error";
type Basemap = "street" | "sectional";

const CHICAGO_ORIGIN: Origin = { lat: 41.8819, lon: -87.6324 };
const OVERTURE_FALLBACK_RELEASE = "2026-07-22.0";
const OVERTURE_CATALOG_URL = "https://stac.overturemaps.org/catalog.json";
const FAA_SECTIONAL_TILE_URL = "https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}";
const FAA_TERMINAL_TILE_URL = "https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}";
const OVERTURE_TILE_CACHE_DB = "clearance-overture-tile-cache-v1";
const OVERTURE_TILE_CACHE_STORE = "tiles";
const OVERTURE_TILE_CACHE_META_STORE = "metadata";
const OVERTURE_MEMORY_CACHE_MAX_TILES = 48;
const OVERTURE_MEMORY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const OVERTURE_PERSISTENT_CACHE_MAX_TILES = 256;
const OVERTURE_PERSISTENT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const MAX_VISIBLE_OVERTURE_TILES = 64;
const CLEARANCE_DISTANCE_FT = 2000;
const FEET_PER_LAT_DEGREE = 364_000;
const feetPerLonDegree = (latitude: number) => 364_000 * Math.cos((latitude * Math.PI) / 180);

type OvertureTileCacheMetadata = { key: string; byteLength: number; lastUsed: number };

const overtureMemoryTileCache = new Map<string, ArrayBuffer>();
const overtureTileRequests = new Map<string, Promise<ArrayBuffer | null>>();
let overtureMemoryTileCacheBytes = 0;
let overtureTileCacheDatabase: Promise<IDBDatabase | null> | null = null;

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

function evaluatePoint(value: Point, altitudeFt: number, buildings: Building[], zones: Zone[]): Check {
  const zone = zones.find((candidate) => pointInPolygon(value, candidate.points));
  if (!zone) return { state: "outside" };
  let highest: { building: Building; distance: number } | undefined;
  for (const building of buildings) {
    const distance = distanceToBuilding(value, building);
    if (distance <= 2000 && (!highest || building.heightFt > highest.building.heightFt)) highest = { building, distance };
  }
  const requiredFt = Math.max(1000, (highest?.building.heightFt ?? 0) + 1000);
  const marginFt = altitudeFt - requiredFt;
  return {
    state: marginFt >= 0 ? "clear" : "conflict",
    zone,
    obstacle: highest?.building,
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
  const properties = { id: building.id, name: building.name, heightFt: building.heightFt, heightSource: building.heightSource };
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

function estimateFlaggedSquareMiles(altitudeFt: number, buildings: Building[], zones: Zone[]) {
  if (!zones.length) return 0;
  const xs = zones.flatMap((zone) => zone.points.map((value) => value.x));
  const ys = zones.flatMap((zone) => zone.points.map((value) => value.y));
  const width = Math.max(...xs) - Math.min(...xs);
  const depth = Math.max(...ys) - Math.min(...ys);
  const step = Math.max(300, Math.sqrt((width * depth) / 2500));
  const active = buildings.filter((building) => altitudeFt < building.heightFt + 1000);
  const screened = active.length > 500 ? groupDenseBuildings(active) : active;
  let flagged = 0;
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += step) {
      const sample = { x, y };
      if (!zones.some((zone) => pointInPolygon(sample, zone.points))) continue;
      if (altitudeFt < 1000 || screened.some((building) => distanceToBuilding(sample, building) <= 2000)) flagged += 1;
    }
  }
  return (flagged * step * step) / 27_878_400;
}

function groupDenseBuildings(buildings: Building[], cellSize = 750): Building[] {
  const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; heightFt: number; count: number }>();
  buildings.forEach((building) => {
    const key = `${Math.floor(building.x / cellSize)}:${Math.floor(building.y / cellSize)}`;
    const points = building.envelopes.flat();
    const current = groups.get(key) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, heightFt: 0, count: 0 };
    points.forEach((value) => {
      current.minX = Math.min(current.minX, value.x);
      current.minY = Math.min(current.minY, value.y);
      current.maxX = Math.max(current.maxX, value.x);
      current.maxY = Math.max(current.maxY, value.y);
    });
    current.heightFt = Math.max(current.heightFt, building.heightFt);
    current.count += 1;
    groups.set(key, current);
  });
  return [...groups.entries()].map(([key, group]) => {
    const width = Math.max(20, group.maxX - group.minX);
    const depth = Math.max(20, group.maxY - group.minY);
    const x = (group.minX + group.maxX) / 2;
    const y = (group.minY + group.maxY) / 2;
    return { id: `group-${key}`, name: `${group.count} nearby envelopes`, x, y, envelopes: [rectangleEnvelope(x, y, width, depth)], heightFt: group.heightFt, heightSource: "Dense-view group" };
  });
}

const emptyFeatures = (): FeatureCollection => featureCollection([]);

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

function viewportStudyZone(map: MapLibreMap, origin: Origin): Zone {
  const bounds = map.getBounds();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  return {
    id: "visible-study-area",
    label: "Visible conservative study area",
    source: "Current viewport; not an FAA designation",
    points: [
      lngLatToLocal(west, north, origin),
      lngLatToLocal(east, north, origin),
      lngLatToLocal(east, south, origin),
      lngLatToLocal(west, south, origin),
    ],
  };
}

export function AirspacePlanner() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const overtureReloadRef = useRef<() => void>(() => {});
  const coverageBoundsRef = useRef<{ west: number; east: number; south: number; north: number } | null>(null);
  const loadedTileKeyRef = useRef<string | null>(null);
  const loadedViewportKeyRef = useRef<string | null>(null);
  const pendingTileKeyRef = useRef<string | null>(null);
  const liveDataRef = useRef({ altitudeFt: 1800, buildings: [] as Building[], zones: [] as Zone[], origin: CHICAGO_ORIGIN, sourceMode: "overture" as "overture" | "local" });
  const [altitudeFt, setAltitudeFt] = useState(1800);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [origin, setOrigin] = useState<Origin>(CHICAGO_ORIGIN);
  const [datasetName, setDatasetName] = useState("Overture Maps · automatic");
  const [dataNote, setDataNote] = useState("Loading visible building tiles…");
  const [coverageStatus, setCoverageStatus] = useState<CoverageStatus>("loading");
  const [sourceMode, setSourceMode] = useState<"overture" | "local">("overture");
  const [overtureRelease, setOvertureRelease] = useState(OVERTURE_FALLBACK_RELEASE);
  const [selectedLngLat, setSelectedLngLat] = useState<[number, number]>(localToLngLat({ x: 80, y: 160 }, CHICAGO_ORIGIN));
  const [importError, setImportError] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [basemapError, setBasemapError] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>("street");

  useEffect(() => {
    liveDataRef.current = { altitudeFt, buildings, zones, origin, sourceMode };
  }, [altitudeFt, buildings, zones, origin, sourceMode]);

  const selected = useMemo(() => lngLatToLocal(selectedLngLat[0], selectedLngLat[1], origin), [selectedLngLat, origin]);
  const modelAvailable = sourceMode === "local" || coverageStatus === "ready";
  const check = useMemo<Check>(
    () => modelAvailable ? evaluatePoint(selected, altitudeFt, buildings, zones) : { state: "unavailable" },
    [modelAvailable, selected, altitudeFt, buildings, zones],
  );
  const activeObstacles = useMemo(() => buildings.filter((building) => altitudeFt < building.heightFt + 1000).length, [altitudeFt, buildings]);
  const flaggedSquareMiles = useMemo(() => estimateFlaggedSquareMiles(altitudeFt, buildings, zones), [altitudeFt, buildings, zones]);
  const buildingsGeoJson = useMemo(
    () => sourceMode === "local" ? featureCollection(buildings.map((building) => buildingFeature(building, origin))) : emptyFeatures(),
    [buildings, origin, sourceMode],
  );
  const zonesGeoJson = useMemo(() => featureCollection(zones.map((zone) => zoneFeature(zone, origin))), [zones, origin]);
  const selectedGeoJson = useMemo(() => featureCollection([point(localToLngLat(selected, origin), { state: check.state })]), [selected, origin, check.state]);
  const conflictsGeoJson = useMemo(() => {
    if (!modelAvailable) return emptyFeatures();
    if (altitudeFt < 1000) return featureCollection(zones.map((zone) => zoneFeature(zone, origin)));
    const features: Array<Feature<Polygon | MultiPolygon>> = [];
    const active = buildings.filter((building) => altitudeFt < building.heightFt + 1000);
    const displayBuildings = active.length > 500 ? groupDenseBuildings(active) : active;
    displayBuildings.forEach((building) => {
      const expanded = buffer(buildingFeature(building, origin), 2000, { units: "feet", steps: 12 });
      if (!expanded) return;
      zones.forEach((zone) => {
        const clipped = intersect(featureCollection([expanded, zoneFeature(zone, origin)]));
        if (clipped) {
          clipped.properties = { building: building.name, heightFt: building.heightFt, requiredFt: building.heightFt + 1000 };
          features.push(clipped);
        }
      });
    });
    return featureCollection(features);
  }, [modelAvailable, altitudeFt, buildings, zones, origin]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    let disposed = false;
    let loadSerial = 0;
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
        attributionControl: {},
      });
      mapRef.current = map;

      const loadVisibleBuildingTiles = async () => {
        if (liveDataRef.current.sourceMode !== "overture" || !map.getSource("overture-buildings")) return;
        const center = map.getCenter();
        const nextOrigin = { lat: center.lat, lon: center.lng };
        const source = map.getSource("overture-buildings") as GeoJSONSource;
        const viewportBounds = map.getBounds();
        const viewportKey = [
          viewportBounds.getWest(),
          viewportBounds.getSouth(),
          viewportBounds.getEast(),
          viewportBounds.getNorth(),
        ].map((value) => value.toFixed(6)).join(":");
        const previousCoverage = coverageBoundsRef.current;
        const viewportAlreadyCovered = Boolean(previousCoverage
          && viewportBounds.getWest() >= previousCoverage.west
          && viewportBounds.getEast() <= previousCoverage.east
          && viewportBounds.getSouth() >= previousCoverage.south
          && viewportBounds.getNorth() <= previousCoverage.north);
        const clearCoverage = () => {
          loadSerial += 1;
          coverageBoundsRef.current = null;
          loadedTileKeyRef.current = null;
          loadedViewportKeyRef.current = null;
          pendingTileKeyRef.current = null;
          source.setData(emptyFeatures());
          setOrigin(nextOrigin);
          setBuildings([]);
          setZones([viewportStudyZone(map, nextOrigin)]);
        };
        const zoom = fullTileZoom;
        const maxTile = (2 ** zoom) - 1;
        const clearanceLatPadding = CLEARANCE_DISTANCE_FT / FEET_PER_LAT_DEGREE;
        const clearanceLonPadding = CLEARANCE_DISTANCE_FT / Math.max(1, feetPerLonDegree(center.lat));
        const minX = Math.max(0, Math.min(maxTile, tileX(viewportBounds.getWest() - clearanceLonPadding, zoom)));
        const maxX = Math.max(0, Math.min(maxTile, tileX(viewportBounds.getEast() + clearanceLonPadding, zoom)));
        const minY = Math.max(0, Math.min(maxTile, tileY(viewportBounds.getNorth() + clearanceLatPadding, zoom)));
        const maxY = Math.max(0, Math.min(maxTile, tileY(viewportBounds.getSouth() - clearanceLatPadding, zoom)));
        const visibleTileCount = (maxX - minX + 1) * (maxY - minY + 1);
        if (visibleTileCount <= 0 || visibleTileCount > MAX_VISIBLE_OVERTURE_TILES) {
          clearCoverage();
          setCoverageStatus("zoom-required");
          setDataNote(`Visible area plus the 2,000-ft clearance halo spans ${visibleTileCount.toLocaleString()} full-detail tiles · narrow the view to ${MAX_VISIBLE_OVERTURE_TILES} or fewer`);
          return;
        }
        const coordinates: Array<{ x: number; y: number }> = [];
        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) coordinates.push({ x, y });
        }
        const tileKey = `${release}:${coordinates.map(({ x, y }) => `${zoom}/${x}/${y}`).join("|")}`;
        if (loadedTileKeyRef.current === tileKey) {
          if (loadedViewportKeyRef.current !== viewportKey) {
            const stableOrigin = liveDataRef.current.origin;
            setZones([viewportStudyZone(map, stableOrigin)]);
            coverageBoundsRef.current = {
              west: viewportBounds.getWest(),
              east: viewportBounds.getEast(),
              south: viewportBounds.getSouth(),
              north: viewportBounds.getNorth(),
            };
            loadedViewportKeyRef.current = viewportKey;
          }
          setCoverageStatus("ready");
          return;
        }
        if (pendingTileKeyRef.current === tileKey) return;
        const requestId = ++loadSerial;
        pendingTileKeyRef.current = tileKey;
        setCoverageStatus(viewportAlreadyCovered ? "ready" : "loading");
        setDataNote(`Loading ${coordinates.length} visible Overture tile${coordinates.length === 1 ? "" : "s"}…`);
        try {
          const tiles = await Promise.all(coordinates.map(async ({ x, y }) => ({
            x,
            y,
            tile: await loadCachedOvertureTile(
              `${release}:${zoom}/${x}/${y}`,
              async () => (await archive.getZxy(zoom, x, y))?.data || null,
            ),
          })));
          if (disposed || requestId !== loadSerial) return;
          const decoded: Array<Feature<Polygon | MultiPolygon>> = [];
          for (const { x, y, tile } of tiles) {
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
            if (disposed || requestId !== loadSerial) return;
          }
          const nextBuildings = overtureBuildingsFromFeatures(decoded, nextOrigin);
          const measured = nextBuildings.filter((building) => building.heightSource !== "30 ft fallback").length;
          source.setData(featureCollection(decoded));
          setOrigin(nextOrigin);
          setBuildings(nextBuildings);
          setZones([viewportStudyZone(map, nextOrigin)]);
          loadedTileKeyRef.current = tileKey;
          loadedViewportKeyRef.current = viewportKey;
          pendingTileKeyRef.current = null;
          coverageBoundsRef.current = {
            west: viewportBounds.getWest(),
            east: viewportBounds.getEast(),
            south: viewportBounds.getSouth(),
            north: viewportBounds.getNorth(),
          };
          setCoverageStatus("ready");
          setDatasetName(`Overture Maps · ${release}`);
          setDataNote(`${nextBuildings.length.toLocaleString()} visible envelopes · ${measured.toLocaleString()} with height/floor data · ${coordinates.length} full-detail z${zoom} tile${coordinates.length === 1 ? "" : "s"}`);
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
        }
      };
      overtureReloadRef.current = () => { void loadVisibleBuildingTiles(); };

      map.on("style.load", () => {
        setMapReady(true);
        setBasemapError(false);
        setCoverageStatus("loading");
        setDataNote("Connecting to Overture building archive…");
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
            map.addLayer({ id: "clearance-zone-fill", type: "fill", source: "clearance-zones", paint: { "fill-color": "#c08a2c", "fill-opacity": 0.07 } }, beforeId);
            map.addLayer({ id: "clearance-zone-line", type: "line", source: "clearance-zones", paint: { "line-color": "#8f6b28", "line-width": 1.25, "line-dasharray": [3, 2] } }, beforeId);
            map.addLayer({ id: "clearance-conflict-fill", type: "fill", source: "clearance-conflicts", paint: { "fill-color": "#df3d33", "fill-opacity": 0.25 } }, beforeId);
            map.addLayer({ id: "clearance-conflict-line", type: "line", source: "clearance-conflicts", paint: { "line-color": "#bd3028", "line-width": 1 } }, beforeId);
            map.addLayer({ id: "overture-building-fill", type: "fill", source: "overture-buildings", filter: ["==", ["get", "__sourceLayer"], "building"], paint: { "fill-color": ["step", ["get", "__renderHeightM"], "#89908e", 107, "#4e585c", 244, "#182229"], "fill-opacity": 0.84 } }, beforeId);
            map.addLayer({ id: "overture-building-part-fill", type: "fill", source: "overture-buildings", filter: ["==", ["get", "__sourceLayer"], "building_part"], paint: { "fill-color": ["step", ["get", "__renderHeightM"], "#7f8886", 107, "#465156", 244, "#111b21"], "fill-opacity": 0.9 } }, beforeId);
            map.addLayer({ id: "overture-building-line", type: "line", source: "overture-buildings", filter: ["==", ["get", "__sourceLayer"], "building"], paint: { "line-color": "#ffffff", "line-width": 0.65, "line-opacity": 0.72 } }, beforeId);
            map.addLayer({ id: "clearance-building-fill", type: "fill", source: "clearance-buildings", paint: { "fill-color": ["step", ["get", "heightFt"], "#89908e", 350, "#4e585c", 800, "#182229"], "fill-opacity": 0.9 } }, beforeId);
            map.addLayer({ id: "clearance-building-line", type: "line", source: "clearance-buildings", paint: { "line-color": "#ffffff", "line-width": 0.65, "line-opacity": 0.72 } }, beforeId);
            map.addLayer({ id: "clearance-selected-outer", type: "circle", source: "clearance-selected", paint: { "circle-radius": 10, "circle-color": "#fffdf7", "circle-stroke-width": 4, "circle-stroke-color": ["match", ["get", "state"], "conflict", "#d82f29", "clear", "#176b59", "unavailable", "#c08a2c", "#182229"] } });
            map.addLayer({ id: "clearance-selected-inner", type: "circle", source: "clearance-selected", paint: { "circle-radius": 3, "circle-color": ["match", ["get", "state"], "conflict", "#d82f29", "clear", "#176b59", "unavailable", "#c08a2c", "#182229"] } });
            void loadVisibleBuildingTiles();
          } catch (error) {
            console.error("Clearance map layer setup failed", error);
            setCoverageStatus("error");
            setDataNote("Overture building archive could not be reached. Reload to try again.");
          }
        });
      });
      map.on("moveend", () => { void loadVisibleBuildingTiles(); });
      map.on("click", (event) => {
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
      overtureReloadRef.current = () => {};
      loadedTileKeyRef.current = null;
      loadedViewportKeyRef.current = null;
      pendingTileKeyRef.current = null;
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
    ["clearance-building-fill", "clearance-building-line"].forEach((id) => {
      if (mapRef.current?.getLayer(id)) mapRef.current.setLayoutProperty(id, "visibility", sourceMode === "local" ? "visible" : "none");
    });
    ["overture-building-fill", "overture-building-part-fill", "overture-building-line"].forEach((id) => {
      if (mapRef.current?.getLayer(id)) mapRef.current.setLayoutProperty(id, "visibility", sourceMode === "overture" ? "visible" : "none");
    });
  }, [mapReady, zonesGeoJson, conflictsGeoJson, buildingsGeoJson, selectedGeoJson, sourceMode]);

  useEffect(() => {
    if (mapReady && sourceMode === "overture") overtureReloadRef.current();
  }, [mapReady, sourceMode]);

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
      setCoverageStatus("ready");
      setBuildings(imported.buildings);
      setOrigin(imported.origin);
      setZones([makeConservativeZone(imported.buildings, "Imported conservative study area")]);
      setDatasetName(file.name);
      setDataNote(`${imported.buildings.length.toLocaleString()} buildings · ${imported.note}`);
      setSelectedLngLat([imported.origin.lon, imported.origin.lat]);
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
    setCoverageStatus("loading");
    setBuildings([]);
    setOrigin(nextOrigin);
    setZones(mapRef.current ? [viewportStudyZone(mapRef.current, nextOrigin)] : []);
    setDatasetName(`Overture Maps · ${overtureRelease}`);
    setDataNote("Loading visible building tiles…");
    setSelectedLngLat([nextOrigin.lon, nextOrigin.lat]);
    setImportError("");
    mapRef.current?.triggerRepaint();
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
  const overtureCoverageLabel = coverageStatus === "loading"
    ? "Overture Maps · Loading coverage"
    : coverageStatus === "error"
      ? "Overture Maps · Coverage unavailable"
      : coverageStatus === "ready"
        ? "Overture Maps · Coverage loaded"
        : "Overture Maps · View too wide";
  const coverageBadge = coverageStatus === "loading" ? "LOADING" : coverageStatus === "error" ? "ERROR" : "NARROW VIEW";

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={activateOverture} aria-label="Clearance home and use automatic Overture buildings"><span className="brand-mark" aria-hidden="true"><i /></span><span>CLEARANCE</span></button>
        <div className="rule-chip"><span>RULESET</span> FAA §91.119(b)</div>
        <div className="topbar-actions">
          <div className={`overture-status ${sourceMode === "local" ? "local" : modelAvailable ? "" : "paused"}`}><span className="status-dot" /><span><small>BUILDING DATA</small>{sourceMode === "overture" ? overtureCoverageLabel : "Local override · Overture paused"}</span></div>
          <button className="icon-button" onClick={() => setInfoOpen(true)} aria-label="About this planning aid">?</button>
          <input ref={inputRef} className="visually-hidden" type="file" accept=".csv,.geojson,.json,application/geo+json,text/csv" onChange={handleImport} />
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <div className="eyebrow-row"><span className="eyebrow">FLIGHT ALTITUDE</span><span className={`live-label ${modelAvailable ? "" : "paused"}`}><i /> ENVELOPE MODEL</span></div>
          <div className="altitude-readout"><strong>{altitudeFt.toLocaleString()}</strong><span>FT<br />AGL</span></div>
          <label className="slider-wrap"><span className="visually-hidden">Flight altitude in feet above ground level</span><input type="range" min="500" max="3000" step="50" value={altitudeFt} onChange={(event) => setAltitudeFt(Number(event.target.value))} /><span className="range-labels"><b>500</b><b>3,000 FT</b></span></label>
          <div className="preset-row" aria-label="Altitude presets">{[1000, 1500, 2000, 2500].map((preset) => <button key={preset} className={altitudeFt === preset ? "active" : ""} onClick={() => setAltitudeFt(preset)}>{preset.toLocaleString()}</button>)}</div>

          <div className="rule-block">
            <div className="rule-heading"><span className="rule-number">§</span><span><small>MODELED STANDARD</small>91.119(b) clearance</span></div>
            <div className="rule-metrics"><div><strong>1,000</strong><span>FT ABOVE</span></div><i /><div><strong>2,000</strong><span>FT FROM ENVELOPE</span></div></div>
            <p>The horizontal distance is measured from the nearest point on each complete building footprint—not its center.</p>
          </div>

          <div className={`point-check ${check.state}`} aria-live="polite">
            <div className="point-check-title"><span className="check-symbol">{check.state === "conflict" ? "!" : check.state === "clear" ? "✓" : check.state === "unavailable" ? "?" : "·"}</span><span><small>SELECTED POINT</small>{statusTitle}</span></div>
            {check.state === "unavailable" ? <p>{coverageStatus === "zoom-required" ? `The visible area and its 2,000-ft clearance halo exceed the ${MAX_VISIBLE_OVERTURE_TILES}-tile full-detail budget. Narrow the view to evaluate clearance.` : "Overture building coverage must load before clearance can be evaluated."}</p> : check.state !== "outside" ? <dl>
              <div><dt>Required altitude</dt><dd>{check.requiredFt?.toLocaleString()} ft</dd></div>
              <div><dt>{(check.marginFt ?? 0) < 0 ? "Shortfall" : "Margin"}</dt><dd>{Math.abs(check.marginFt ?? 0).toLocaleString()} ft</dd></div>
              <div><dt>Highest within 2,000 ft</dt><dd>{check.obstacle?.name ?? "Ground baseline"}</dd></div>
              {check.obstacle && <div><dt>Distance to envelope</dt><dd>{Math.round(check.envelopeDistanceFt ?? 0).toLocaleString()} ft</dd></div>}
            </dl> : <p>Click inside a dashed amber study polygon to run the clearance screen.</p>}
          </div>

          <div className="screen-summary"><span><small>RED AREA</small><strong>{modelAvailable ? `${flaggedSquareMiles.toFixed(2)} mi²` : "—"}</strong></span><span><small>ACTIVE OBSTACLES</small><strong>{modelAvailable ? activeObstacles : "—"}</strong></span></div>

          <a className="national-source" href="https://docs.overturemaps.org/guides/buildings/" target="_blank" rel="noreferrer">
            <span className="source-kicker">AUTOMATIC NATIONAL LAYER · LIVE</span>
            <strong>Overture Maps Buildings <b>↗</b></strong>
            <span>PMTiles {overtureRelease} · footprints, heights, and building parts</span>
          </a>

          <div className="panel-footer">
            <button onClick={() => setDetailsOpen((current) => !current)}>{detailsOpen ? "Hide" : "Show"} model details <span>{detailsOpen ? "−" : "+"}</span></button>
            {detailsOpen && <div className="model-details"><p>Red geometry is a true 2,000-ft buffer around each active footprint, clipped to the study polygon.</p><p>Terrain, airspace, temporary restrictions, weather, routes, takeoff/landing exceptions, and §91.119(a)/(c)/(d) are not modeled.</p></div>}
          </div>
        </aside>

        <section className="map-panel" aria-label="Interactive two-dimensional clearance map">
          <div ref={mapContainerRef} className="map-container" aria-label={`Interactive basemap at ${altitudeFt} feet AGL. Red areas do not meet the modeled clearance. Click to check a point.`} />
          {!mapReady && !basemapError && <div className="basemap-loading"><i />Loading basemap…</div>}
          {basemapError && !mapReady && <div className="basemap-loading error">Basemap unavailable. Check your connection.</div>}
          <div className="map-titlebar"><div><span className="location-pin" aria-hidden="true" /><strong>{sourceMode === "overture" ? "Overture building envelopes" : datasetName}</strong><small>{origin.lat.toFixed(4)}° N, {Math.abs(origin.lon).toFixed(4)}° W</small></div><span className="map-mode">2D · AGL</span></div>
          <div className="map-controls" aria-label="Map zoom controls">
            <button onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in">＋</button>
            <button onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out">−</button>
            <button onClick={() => mapRef.current?.flyTo({ center: [origin.lon, origin.lat], zoom: 14.2, essential: true })} aria-label="Reset map view">◎</button>
          </div>
          <div className="basemap-switch" role="group" aria-label="Select basemap">
            <button className={basemap === "street" ? "active" : ""} aria-pressed={basemap === "street"} onClick={() => setBasemap("street")}>Street</button>
            <button className={basemap === "sectional" ? "active" : ""} aria-pressed={basemap === "sectional"} title="Sectionals with Terminal Area Charts where available" onClick={() => setBasemap("sectional")}>FAA Charts</button>
          </div>
          <div className="legend" aria-label="Map legend"><span><i className="legend-red" />Envelope conflict</span><span><i className="legend-amber" />Study polygon</span><span><i className="legend-building" />Building envelope</span></div>
          <div className="dataset-card"><span className="dataset-icon" aria-hidden="true">▤</span><span><small>{sourceMode === "overture" ? "AUTOMATIC BUILDING LAYER" : "LOCAL OVERRIDE"}</small><strong>{datasetName}</strong><em>{dataNote}</em></span>{sourceMode === "local" ? <button onClick={activateOverture}>Use Overture</button> : <span className={`data-live ${modelAvailable ? "" : "paused"}`}>{modelAvailable ? "LIVE" : coverageBadge}</span>}</div>
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
          <h2 id="limitations-title">Full envelopes, with important limits.</h2>
          <p>GeoJSON Polygon and MultiPolygon outer footprints are preserved. The red geometry begins at the closest footprint edge, buffers it by 2,000 feet, and compares the selected altitude with the building height plus 1,000 feet.</p>
          <p>When more than 500 obstacles are active in one view, nearby envelopes are conservatively grouped for the red overlay so the altitude control stays responsive. The selected-point check still tests the individual building envelopes.</p>
          <p>Overture buildings and clearance evaluation always use the archive’s maximum-detail tiles, independent of camera zoom. The loader includes a 2,000-ft halo around the view so edge points can be checked; coverage spanning more than {MAX_VISIBLE_OVERTURE_TILES} full-detail tiles is explicitly not evaluated.</p>
          <p>The FAA evaluates whether an area is “congested” case by case. The visible map extent is treated as a conservative study area—not labeled as an official FAA boundary.</p>
          <div className="modal-warning"><b>Small UAS note</b><span>Part 107 generally uses a different 400-foot AGL framework and may require airspace authorization. This prototype models the Part 91 rule named above.</span></div>
          <div className="source-detail">
            <h3>Automatic national source: Overture Maps</h3>
            <p>The map loads Overture’s official global Buildings PMTiles archive for the current release. Polygon/MultiPolygon footprints, building parts, and available height fields feed the clearance model wherever the visible extent and its clearance halo fit within the full-detail tile budget.</p>
            <a href="https://docs.overturemaps.org/guides/buildings/" target="_blank" rel="noreferrer">Open Overture Buildings guide ↗</a>
          </div>
          <div className="file-help"><h3>Advanced local override</h3><p>GeoJSON: use <code>height_ft</code>, Overture <code>height</code> (meters), <code>height_m</code>, <code>num_floors</code>, or <code>building:levels</code>. CSV: include <code>lat, lon, height_ft, width_ft, depth_ft</code>.</p><div className="file-actions"><button onClick={() => inputRef.current?.click()}>Import local file</button><button onClick={downloadTemplate}>Download CSV template</button>{sourceMode === "local" && <button onClick={activateOverture}>Return to Overture</button>}</div></div>
          <div className="modal-links"><a href="https://www.faa.gov/about/office_org/headquarters_offices/agc/practice_areas/regulations/interpretations/Data/interps/2009/Anderson_2009_Legal_Interpretation.pdf" target="_blank" rel="noreferrer">FAA Anderson interpretation ↗</a><a href="https://carto.com/basemaps/" target="_blank" rel="noreferrer">Street basemap ↗</a><a href="https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/" target="_blank" rel="noreferrer">FAA chart sources ↗</a></div>
        </section>
      </div>}
    </main>
  );
}
