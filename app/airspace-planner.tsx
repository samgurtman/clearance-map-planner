"use client";

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
import clearanceWorkerUrl from "./clearance-worker.ts?worker&url";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {
  boundsIntersectionWithGeographicAreas,
  boundsWithinGeographicAreas,
  conservativeLongitudePaddingDegrees,
  decodeTerrariumElevationMeters,
  destinationLngLatByFeet,
  distanceFromLngLatToPolygonFt,
  ESTIMATED_FLOOR_HEIGHT_FT,
  faaUpperBoundAmslFt,
  highestTerrainElevationWithinRadius,
  isSupportedUsTerritorialDivision,
  pointInGeographicArea,
  pointInGeographicAreas,
  shouldRetainOvertureBuildingPart,
  unsupportedGeographyCoordinates,
} from "./clearance-accuracy";
import type { GeographicArea } from "./clearance-accuracy";

type Point = { x: number; y: number };
type Origin = { lat: number; lon: number };
type Building = Point & {
  id: string;
  name: string;
  envelopes: Point[][];
  heightFt: number;
  heightSource: string;
  heightQuality?: "measured" | "estimated" | "fallback";
  groundElevationFt?: number;
  topElevationFt?: number;
  sourceKind?: "building" | "faa-obstacle";
  verifiedStatus?: "verified" | "unverified";
  accuracyCode?: string;
  horizontalAccuracyFt?: number;
  verticalAccuracyFt?: number;
};
type Zone = { id: string; label: string; polygons: Point[][][]; source: string };
type RenderBounds = { west: number; east: number; south: number; north: number };
type RenderProgress = { active: boolean; value: number; label: string };
type BuildingLoadResult = { buildings: Building[]; origin: Origin; zones: Zone[] };
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
  openWater?: boolean;
};
type Check = {
  state: "conflict" | "clear" | "outside" | "unavailable";
  zone?: Zone;
  obstacle?: Building;
  controllingSource?: "surface" | "obstacle";
  surfaceElevationFt?: number;
  obstacleTopElevationFt?: number;
  requiredFt?: number;
  marginFt?: number;
  envelopeDistanceFt?: number;
  openWater?: boolean;
};
type ImportedDataset = { buildings: Building[]; origin: Origin; note: string };
type CoverageStatus = "idle" | "loading" | "ready" | "zoom-required" | "error";
type TerrainStatus = "idle" | "loading" | "ready" | "zoom-required" | "error";
type Basemap = "street" | "sectional";
type UsMapRegionId = "lower48" | "alaska" | "western-aleutians" | "hawaii" | "caribbean" | "western-pacific" | "american-samoa";
type FaaObstacleStatus = "idle" | "loading" | "ready" | "error";
type UsBoundaryStatus = "loading" | "ready" | "error";
type FaaObstacleRow = [id: string, lat: number, lon: number, type: string, aglFt: number, amslFt: number, verified: string, accuracy: string];
type FaaObstacleManifest = {
  schemaVersion: number;
  source: string;
  sourceUrl: string;
  sourceLastModified: string | null;
  generatedAt: string;
  gridDegrees: number;
  recordCount: number;
  cells: Record<string, number>;
};
type OpenWaterArea = GeographicArea;

const CHICAGO_ORIGIN: Origin = { lat: 41.8819, lon: -87.6324 };
const OVERTURE_FALLBACK_RELEASE = "2026-07-22.0";
const OVERTURE_CATALOG_URL = "https://stac.overturemaps.org/catalog.json";
const FAA_SECTIONAL_TILE_URL = "https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}";
const FAA_TERMINAL_TILE_URL = "https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}";
const TERRAIN_TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const OVERTURE_DIVISION_TILE_ZOOM = 6;
// Relative to the document so repository-scoped GitHub Pages URLs keep the
// bundled FAA shards under the same base path.
const FAA_OBSTACLE_DATA_ROOT = "./data/faa-obstacles";
const TERRAIN_TILE_ZOOM = 14;
const TERRAIN_CELL_DIVISIONS = 4;
const WATER_TILE_ZOOM = 13;
const WATER_CELL_SAMPLE_DIVISIONS = 7;
const WATER_EDGE_GUARD_FT = 250;
const TERRAIN_MEMORY_CACHE_MAX_TILES = 192;
const TERRAIN_FETCH_CONCURRENCY = 8;
const OVERTURE_FETCH_CONCURRENCY = 10;
const OVERTURE_TILE_CACHE_DB = "clearance-overture-tile-cache-v1";
const OVERTURE_TILE_CACHE_STORE = "tiles";
const OVERTURE_TILE_CACHE_META_STORE = "metadata";
const OVERTURE_MEMORY_CACHE_MAX_TILES = 48;
const OVERTURE_MEMORY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const OVERTURE_PERSISTENT_CACHE_MAX_TILES = 512;
const OVERTURE_PERSISTENT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const MIN_TILE_BUDGET = 32;
const MAX_TILE_BUDGET = 1024;
const DEFAULT_TILE_BUDGET = 256;
const CLEARANCE_DISTANCE_FT = 2000;
const ALTITUDE_COMMIT_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
const FAA_MAX_HORIZONTAL_ACCURACY_FT = 6076;
const CLEARANCE_WORKER_TIMEOUT_MS = 75_000;
const FEET_PER_LAT_DEGREE = 364_000;
const feetPerLonDegree = (latitude: number) => 364_000 * Math.cos((latitude * Math.PI) / 180);
const OPEN_WATER_SUBTYPES = new Set(["ocean", "lake", "pond", "reservoir", "river", "stream", "water", "canal"]);
const NON_OPEN_WATER_CLASSES = new Set(["swimming_pool", "wastewater", "sewage", "reflecting_pool", "water_storage", "fishpond"]);
const US_MAP_REGIONS: Record<UsMapRegionId, { label: string; center: [number, number]; zoom: number; bounds: [[number, number], [number, number]] }> = {
  lower48: { label: "Lower 48", center: [-98.5, 39.5], zoom: 4, bounds: [[-126, 23], [-65, 50.5]] },
  alaska: { label: "Alaska", center: [-151, 63.5], zoom: 3.6, bounds: [[-179.99, 50], [-129, 72.5]] },
  "western-aleutians": { label: "Western Aleutians", center: [175.5, 52.5], zoom: 5, bounds: [[169, 50], [179.99, 56]] },
  hawaii: { label: "Hawaii", center: [-157.8, 20.8], zoom: 6.2, bounds: [[-161.5, 18], [-154.5, 23]] },
  caribbean: { label: "Puerto Rico / USVI", center: [-66.2, 18.25], zoom: 7, bounds: [[-68.2, 17.4], [-64.3, 19]] },
  "western-pacific": { label: "Guam / CNMI", center: [145.3, 16.2], zoom: 5.2, bounds: [[143.5, 12.5], [146.5, 21.5]] },
  "american-samoa": { label: "American Samoa", center: [-170.7, -14.25], zoom: 7, bounds: [[-172, -15.5], [-168, -10.5]] },
};

type OvertureTileCacheMetadata = { key: string; byteLength: number; lastUsed: number };
type TerrainTileSummary = { cells: TerrainCell[] };
type ClearanceWorkerResult = {
  conflicts: FeatureCollection<Polygon | MultiPolygon>;
  activeObstacles: number;
  flaggedSquareMiles: number;
  altitudeFt: number;
  durationMs: number;
};

const overtureMemoryTileCache = new Map<string, ArrayBuffer>();
const overtureTileRequests = new Map<string, Promise<ArrayBuffer | null>>();
const terrainMemoryTileCache = new Map<string, TerrainTileSummary>();
const terrainTileRequests = new Map<string, Promise<TerrainTileSummary | null>>();
const faaObstacleCellCache = new Map<string, FaaObstacleRow[]>();
const overturePersistentWriteQueue = new Map<string, ArrayBuffer>();
let overtureMemoryTileCacheBytes = 0;
let overtureTileCacheDatabase: Promise<IDBDatabase | null> | null = null;
let overturePersistentWriteTimer: ReturnType<typeof setTimeout> | null = null;
let faaObstacleManifestRequest: Promise<FaaObstacleManifest> | null = null;

function rememberTerrainTile(key: string, summary: TerrainTileSummary) {
  terrainMemoryTileCache.delete(key);
  terrainMemoryTileCache.set(key, summary);
  while (terrainMemoryTileCache.size > TERRAIN_MEMORY_CACHE_MAX_TILES) {
    const oldestKey = terrainMemoryTileCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    terrainMemoryTileCache.delete(oldestKey);
  }
}

async function decodeTerrainTile(data: ArrayBuffer, zoom: number, x: number, y: number): Promise<TerrainTileSummary> {
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
  const maxima = new Array<number>(TERRAIN_CELL_DIVISIONS * TERRAIN_CELL_DIVISIONS).fill(-Infinity);
  for (let pixelY = 0; pixelY < pixels.height; pixelY += 1) {
    const cellY = Math.min(TERRAIN_CELL_DIVISIONS - 1, Math.floor((pixelY / pixels.height) * TERRAIN_CELL_DIVISIONS));
    for (let pixelX = 0; pixelX < pixels.width; pixelX += 1) {
      const offset = (pixelY * pixels.width + pixelX) * 4;
      if (pixels.data[offset + 3] === 0) continue;
      const elevationMeters = decodeTerrariumElevationMeters(pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2]);
      const cellX = Math.min(TERRAIN_CELL_DIVISIONS - 1, Math.floor((pixelX / pixels.width) * TERRAIN_CELL_DIVISIONS));
      const cellIndex = cellY * TERRAIN_CELL_DIVISIONS + cellX;
      maxima[cellIndex] = Math.max(maxima[cellIndex], elevationMeters);
    }
  }
  const cells: TerrainCell[] = [];
  for (let cellY = 0; cellY < TERRAIN_CELL_DIVISIONS; cellY += 1) {
    for (let cellX = 0; cellX < TERRAIN_CELL_DIVISIONS; cellX += 1) {
      const elevationMeters = maxima[cellY * TERRAIN_CELL_DIVISIONS + cellX];
      if (!Number.isFinite(elevationMeters)) throw new Error("Terrain tile is incomplete or transparent.");
      cells.push({
        id: terrainCellId(zoom, x, y, cellX, cellY),
        zoom,
        tileX: x,
        tileY: y,
        cellX,
        cellY,
        west: longitudeAtTilePosition(x + cellX / TERRAIN_CELL_DIVISIONS, zoom),
        east: longitudeAtTilePosition(x + (cellX + 1) / TERRAIN_CELL_DIVISIONS, zoom),
        north: latitudeAtTilePosition(y + cellY / TERRAIN_CELL_DIVISIONS, zoom),
        south: latitudeAtTilePosition(y + (cellY + 1) / TERRAIN_CELL_DIVISIONS, zoom),
        elevationFt: Math.ceil(elevationMeters * 3.28084),
      });
    }
  }
  return { cells };
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
    const summary = await decodeTerrainTile(await response.arrayBuffer(), zoom, x, y);
    rememberTerrainTile(key, summary);
    return summary;
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

function pointInOpenWaterArea(longitude: number, latitude: number, area: OpenWaterArea) {
  return pointInGeographicArea(longitude, latitude, area);
}

function geographicAreaFromFeature(feature: Feature<Polygon | MultiPolygon>): GeographicArea {
  const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  polygons.forEach((rings) => rings.forEach((ring) => ring.forEach(([longitude, latitude]) => {
    bounds.west = Math.min(bounds.west, longitude);
    bounds.east = Math.max(bounds.east, longitude);
    bounds.south = Math.min(bounds.south, latitude);
    bounds.north = Math.max(bounds.north, latitude);
  })));
  return { ...bounds, polygons };
}

function overtureUsBoundaryTileCoordinates(zoom: number) {
  const coordinates = new Map<string, { x: number; y: number }>();
  const maxTile = (2 ** zoom) - 1;
  Object.values(US_MAP_REGIONS).forEach((region) => {
    const minimumX = Math.max(0, Math.min(maxTile, tileX(region.bounds[0][0], zoom)));
    const maximumX = Math.max(0, Math.min(maxTile, tileX(region.bounds[1][0], zoom)));
    const minimumY = Math.max(0, Math.min(maxTile, tileY(region.bounds[1][1], zoom)));
    const maximumY = Math.max(0, Math.min(maxTile, tileY(region.bounds[0][1], zoom)));
    for (let x = minimumX; x <= maximumX; x += 1) {
      for (let y = minimumY; y <= maximumY; y += 1) coordinates.set(`${x}/${y}`, { x, y });
    }
  });
  return [...coordinates.values()];
}

const openWaterAreaFromFeature = geographicAreaFromFeature;

function isOpenWaterFeature(properties: Record<string, unknown>) {
  const subtype = String(properties.subtype || "").toLowerCase();
  const waterClass = String(properties.class || "").toLowerCase();
  const sourceTags = String(properties.source_tags || "").toLowerCase();
  const intermittent = properties.is_intermittent === true || properties.is_intermittent === "true";
  const artificialSmallWater = sourceTags.includes('"amenity":"fountain"')
    || sourceTags.includes('"leisure":"swimming_pool"')
    || sourceTags.includes('"water":"wastewater"')
    || sourceTags.includes('"man_made":"clarifier"')
    || sourceTags.includes('"playground":"splash_pad"');
  return !intermittent
    && !artificialSmallWater
    && !NON_OPEN_WATER_CLASSES.has(waterClass)
    && OPEN_WATER_SUBTYPES.has(subtype);
}

function terrainCellIsConfidentOpenWater(cell: TerrainCell, waterAreas: OpenWaterArea[]) {
  const latitudeGuard = WATER_EDGE_GUARD_FT / FEET_PER_LAT_DEGREE;
  const longitudeGuard = WATER_EDGE_GUARD_FT / Math.max(1, feetPerLonDegree((cell.north + cell.south) / 2));
  const west = cell.west - longitudeGuard;
  const east = cell.east + longitudeGuard;
  const south = cell.south - latitudeGuard;
  const north = cell.north + latitudeGuard;
  const candidates = waterAreas.filter((area) => area.west <= east && area.east >= west && area.south <= north && area.north >= south);
  if (!candidates.length) return false;
  for (let row = 0; row < WATER_CELL_SAMPLE_DIVISIONS; row += 1) {
    const latitude = south + (north - south) * (row / (WATER_CELL_SAMPLE_DIVISIONS - 1));
    for (let column = 0; column < WATER_CELL_SAMPLE_DIVISIONS; column += 1) {
      const longitude = west + (east - west) * (column / (WATER_CELL_SAMPLE_DIVISIONS - 1));
      if (!candidates.some((area) => pointInOpenWaterArea(longitude, latitude, area))) return false;
    }
  }
  return true;
}

async function loadFaaObstacleManifest() {
  if (!faaObstacleManifestRequest) {
    faaObstacleManifestRequest = fetch(`${FAA_OBSTACLE_DATA_ROOT}/manifest.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`FAA obstacle manifest returned HTTP ${response.status}.`);
        return response.json() as Promise<FaaObstacleManifest>;
      })
      .catch((error) => {
        faaObstacleManifestRequest = null;
        throw error;
      });
  }
  return faaObstacleManifestRequest;
}

async function loadFaaObstacleCell(key: string) {
  const cached = faaObstacleCellCache.get(key);
  if (cached) return cached;
  const response = await fetch(`${FAA_OBSTACLE_DATA_ROOT}/${key}.json`);
  if (!response.ok) throw new Error(`FAA obstacle shard ${key} returned HTTP ${response.status}.`);
  const rows = await response.json() as FaaObstacleRow[];
  faaObstacleCellCache.set(key, rows);
  return rows;
}

async function loadFaaObstacleRows(selection: RenderBounds, onProgress?: (value: number) => void) {
  const faaQueryPaddingFt = CLEARANCE_DISTANCE_FT + FAA_MAX_HORIZONTAL_ACCURACY_FT;
  const latitudePadding = faaQueryPaddingFt / FEET_PER_LAT_DEGREE;
  const longitudePadding = conservativeLongitudePaddingDegrees(selection.south, selection.north, faaQueryPaddingFt);
  const coverage = {
    west: selection.west - longitudePadding,
    east: selection.east + longitudePadding,
    south: selection.south - latitudePadding,
    north: selection.north + latitudePadding,
  };
  const manifest = await loadFaaObstacleManifest();
  const keys: string[] = [];
  const minimumLatitude = Math.floor(coverage.south / manifest.gridDegrees);
  const maximumLatitude = Math.floor(coverage.north / manifest.gridDegrees);
  const minimumLongitude = Math.floor(coverage.west / manifest.gridDegrees);
  const maximumLongitude = Math.floor(coverage.east / manifest.gridDegrees);
  for (let latitude = minimumLatitude; latitude <= maximumLatitude; latitude += 1) {
    for (let longitude = minimumLongitude; longitude <= maximumLongitude; longitude += 1) {
      const key = `${latitude}_${longitude}`;
      if (manifest.cells[key]) keys.push(key);
    }
  }
  if (!keys.length) {
    onProgress?.(1);
    return { manifest, rows: [] as FaaObstacleRow[] };
  }
  let loaded = 0;
  const shards = await mapWithConcurrency(keys, 6, async (key) => {
    const rows = await loadFaaObstacleCell(key);
    loaded += 1;
    onProgress?.(loaded / keys.length);
    return rows;
  });
  const rows = shards.flat().filter((row) => {
    const [, latitude, longitude, , , , , accuracy] = row;
    const horizontalAccuracyFt = faaHorizontalAccuracyFt(accuracy.trim().toUpperCase()[0] || "9") ?? 0;
    const rowPaddingFt = CLEARANCE_DISTANCE_FT + horizontalAccuracyFt;
    const latitudePadding = rowPaddingFt / FEET_PER_LAT_DEGREE;
    const longitudePadding = rowPaddingFt / Math.max(1, feetPerLonDegree(latitude));
    return longitude >= selection.west - longitudePadding
      && longitude <= selection.east + longitudePadding
      && latitude >= selection.south - latitudePadding
      && latitude <= selection.north + latitudePadding;
  });
  return { manifest, rows };
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

async function flushPersistentTileWrites() {
  overturePersistentWriteTimer = null;
  const queued = [...overturePersistentWriteQueue.entries()];
  overturePersistentWriteQueue.clear();
  if (!queued.length) return;
  const database = await openOvertureTileCache();
  if (!database) return;
  const stored = await new Promise<boolean>((resolve) => {
    try {
      const transaction = database.transaction([OVERTURE_TILE_CACHE_STORE, OVERTURE_TILE_CACHE_META_STORE], "readwrite");
      const tiles = transaction.objectStore(OVERTURE_TILE_CACHE_STORE);
      const metadata = transaction.objectStore(OVERTURE_TILE_CACHE_META_STORE);
      const lastUsed = Date.now();
      queued.forEach(([key, data]) => {
        tiles.put(data, key);
        metadata.put({ key, byteLength: data.byteLength, lastUsed });
      });
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  if (stored) await prunePersistentTileCache(database);
}

function queuePersistentTileWrite(key: string, data: ArrayBuffer) {
  if (data.byteLength > OVERTURE_PERSISTENT_CACHE_MAX_BYTES) return;
  overturePersistentWriteQueue.set(key, data);
  if (overturePersistentWriteTimer) clearTimeout(overturePersistentWriteTimer);
  overturePersistentWriteTimer = setTimeout(() => void flushPersistentTileWrites(), 750);
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
    queuePersistentTileWrite(key, downloadedTile);
    return downloadedTile;
  })();
  overtureTileRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (overtureTileRequests.get(key) === request) overtureTileRequests.delete(key);
  }
}

function geographicRectangleEnvelope(
  longitude: number,
  latitude: number,
  widthFt: number,
  depthFt: number,
  origin: Origin,
) {
  return [
    destinationLngLatByFeet(longitude, latitude, -widthFt / 2, depthFt / 2),
    destinationLngLatByFeet(longitude, latitude, widthFt / 2, depthFt / 2),
    destinationLngLatByFeet(longitude, latitude, widthFt / 2, -depthFt / 2),
    destinationLngLatByFeet(longitude, latitude, -widthFt / 2, -depthFt / 2),
  ].map(([envelopeLongitude, envelopeLatitude]) => lngLatToLocal(envelopeLongitude, envelopeLatitude, origin));
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

function faaHorizontalAccuracyFt(code: string) {
  return ({ "1": 20, "2": 50, "3": 100, "4": 250, "5": 500, "6": 1000, "7": 3038, "8": 6076 } as Record<string, number>)[code] ?? null;
}

function faaVerticalAccuracyFt(code: string) {
  return ({ A: 3, B: 10, C: 20, D: 50, E: 125, F: 250, G: 500, H: 1000 } as Record<string, number>)[code] ?? null;
}

function faaObstaclesFromRows(rows: FaaObstacleRow[], origin: Origin): Building[] {
  return rows.map(([id, latitude, longitude, obstacleType, aglFt, amslFt, verified, rawAccuracy]) => {
    const accuracy = rawAccuracy.trim().toUpperCase();
    const horizontalAccuracyFt = faaHorizontalAccuracyFt(accuracy[0] || "9");
    const verticalAccuracyFt = faaVerticalAccuracyFt(accuracy[1] || "I");
    const modeledTopElevationFt = faaUpperBoundAmslFt(amslFt, verticalAccuracyFt);
    const center = lngLatToLocal(longitude, latitude, origin);
    const verifiedStatus = verified.toUpperCase() === "O" ? "verified" : "unverified";
    const envelopeSizeFt = Math.max(20, (horizontalAccuracyFt ?? 0) * 2);
    return {
      id: `faa:${id}`,
      name: `FAA ${obstacleType.toLowerCase()} ${id}${verifiedStatus === "unverified" ? " (unverified)" : ""}`,
      ...center,
      envelopes: [geographicRectangleEnvelope(longitude, latitude, envelopeSizeFt, envelopeSizeFt, origin)],
      heightFt: aglFt + (verticalAccuracyFt ?? 0),
      groundElevationFt: amslFt - aglFt,
      topElevationFt: modeledTopElevationFt,
      heightSource: verticalAccuracyFt == null ? "FAA DDOF published AMSL" : "FAA DDOF published AMSL + known vertical tolerance",
      sourceKind: "faa-obstacle",
      verifiedStatus,
      accuracyCode: accuracy,
      horizontalAccuracyFt: horizontalAccuracyFt ?? undefined,
      verticalAccuracyFt: verticalAccuracyFt ?? undefined,
    };
  });
}

function pointOnSegment(value: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const squaredLength = dx * dx + dy * dy;
  if (squaredLength <= 1e-12) return Math.hypot(value.x - start.x, value.y - start.y) <= 1e-6;
  const cross = (value.x - start.x) * dy - (value.y - start.y) * dx;
  if (Math.abs(cross) > 1e-6 * Math.sqrt(squaredLength)) return false;
  const dot = (value.x - start.x) * dx + (value.y - start.y) * dy;
  return dot >= -1e-6 && dot <= squaredLength + 1e-6;
}

function pointInPolygon(value: Point, points: Point[]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    if (pointOnSegment(value, a, b)) return true;
    const crosses = a.y > value.y !== b.y > value.y && value.x < ((b.x - a.x) * (value.y - a.y)) / (b.y - a.y || 1) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInZone(value: Point, zone: Zone) {
  return zone.polygons.some((rings) => rings.length > 0
    && pointInPolygon(value, rings[0])
    && !rings.slice(1).some((hole) => pointInPolygon(value, hole)));
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

function distanceToBuilding(longitude: number, latitude: number, building: Building, origin: Origin) {
  return Math.min(...building.envelopes.map((envelope) => distanceFromLngLatToPolygonFt(
    longitude,
    latitude,
    envelope.map((pointValue) => localToLngLat(pointValue, origin)),
  )));
}

function buildingTopElevationFt(building: Building) {
  if (building.topElevationFt != null) return building.topElevationFt;
  return building.groundElevationFt == null ? null : building.groundElevationFt + building.heightFt;
}

function evaluatePointRequirement(
  value: Point,
  selectedLngLat: [number, number],
  buildings: Building[],
  zones: Zone[],
  origin: Origin,
  surfaceElevationFt: number | null,
  openWater: boolean,
): Check {
  const zone = zones.find((candidate) => pointInZone(value, candidate));
  if (!zone) return { state: "outside" };
  if (surfaceElevationFt == null && !openWater) return { state: "unavailable", zone };
  let highest: { building: Building; distance: number } | undefined;
  for (const building of buildings) {
    const topElevationFt = buildingTopElevationFt(building);
    if (topElevationFt == null) continue;
    const distance = distanceToBuilding(selectedLngLat[0], selectedLngLat[1], building, origin);
    if (distance <= CLEARANCE_DISTANCE_FT && (!highest || topElevationFt > (buildingTopElevationFt(highest.building) ?? -Infinity))) highest = { building, distance };
  }
  const surfaceRequiredFt = surfaceElevationFt == null ? -Infinity : surfaceElevationFt + 1000;
  const obstacleTopElevationFt = highest ? buildingTopElevationFt(highest.building) ?? undefined : undefined;
  const buildingRequiredFt = obstacleTopElevationFt == null ? -Infinity : obstacleTopElevationFt + 1000;
  if (!Number.isFinite(surfaceRequiredFt) && !Number.isFinite(buildingRequiredFt)) return { state: "clear", zone, openWater: true };
  const controllingSource = buildingRequiredFt > surfaceRequiredFt ? "obstacle" : "surface";
  const requiredFt = Math.ceil(Math.max(surfaceRequiredFt, buildingRequiredFt));
  return {
    state: "clear",
    zone,
    obstacle: highest?.building,
    controllingSource,
    surfaceElevationFt,
    obstacleTopElevationFt,
    requiredFt,
    envelopeDistanceFt: highest?.distance,
    openWater,
  };
}

function applyAltitudeToCheck(requirement: Check, altitudeFt: number): Check {
  if (requirement.state === "outside" || requirement.state === "unavailable" || requirement.requiredFt == null) return requirement;
  const marginFt = altitudeFt - requirement.requiredFt;
  return { ...requirement, state: marginFt >= 0 ? "clear" : "conflict", marginFt };
}

function closedCoordinates(points: Point[], origin: Origin) {
  const closed = points.length && (points[0].x !== points[points.length - 1].x || points[0].y !== points[points.length - 1].y)
    ? [...points, points[0]]
    : points;
  return closed.map((value) => localToLngLat(value, origin));
}

function buildingFeature(building: Building, origin: Origin): Feature<Polygon | MultiPolygon> {
  const properties = { id: building.id, name: building.name, heightFt: building.heightFt, groundElevationFt: building.groundElevationFt, topElevationFt: buildingTopElevationFt(building), heightSource: building.heightSource, sourceKind: building.sourceKind };
  if (building.envelopes.length > 1) {
    return multiPolygon(building.envelopes.map((envelope) => [closedCoordinates(envelope, origin)]), properties);
  }
  return polygon([closedCoordinates(building.envelopes[0], origin)], properties);
}

function zoneFeature(zone: Zone, origin: Origin): Feature<Polygon | MultiPolygon> {
  const coordinates = zone.polygons.map((rings) => rings.map((ring) => closedCoordinates(ring, origin)));
  const properties = { id: zone.id, label: zone.label, source: zone.source };
  return coordinates.length > 1
    ? multiPolygon(coordinates, properties)
    : polygon(coordinates[0], properties);
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
    polygons: [[[{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]]],
  };
}

function propertyName(properties: Record<string, unknown>, fallback: string) {
  if (typeof properties["@name"] === "string" && properties["@name"]) return String(properties["@name"]);
  if (typeof properties.name === "string") return properties.name;
  const names = properties.names as { primary?: string; common?: Record<string, string> } | undefined;
  return names?.primary || names?.common?.en || fallback;
}

function finiteProperty(value: unknown) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function propertyHeight(properties: Record<string, unknown>) {
  if (finiteProperty(properties.height_ft)) return { feet: Number(properties.height_ft), source: "height_ft", quality: "measured" as const };
  if (finiteProperty(properties.height_m)) return { feet: Number(properties.height_m) * 3.28084, source: "height_m", quality: "measured" as const };
  if (finiteProperty(properties.height)) return { feet: Number(properties.height) * 3.28084, source: "height (meters)", quality: "measured" as const };
  if (finiteProperty(properties.num_floors)) return { feet: Number(properties.num_floors) * ESTIMATED_FLOOR_HEIGHT_FT, source: `${ESTIMATED_FLOOR_HEIGHT_FT} ft × num_floors estimate`, quality: "estimated" as const };
  if (finiteProperty(properties["building:levels"])) return { feet: Number(properties["building:levels"]) * ESTIMATED_FLOOR_HEIGHT_FT, source: `${ESTIMATED_FLOOR_HEIGHT_FT} ft × building:levels estimate`, quality: "estimated" as const };
  return { feet: 30, source: "30 ft fallback", quality: "fallback" as const };
}

function propertyTopHeight(properties: Record<string, unknown>) {
  const height = propertyHeight(properties);
  if (finiteProperty(properties.min_height) && Number(properties.min_height) > 0) {
    const minimumHeightFt = Number(properties.min_height) * 3.28084;
    return { ...height, feet: height.feet + minimumHeightFt, source: `${height.source} + min_height`, quality: height.quality === "fallback" ? "estimated" as const : height.quality };
  }
  if (finiteProperty(properties.min_floor) && Number(properties.min_floor) > 0) {
    const minimumHeightFt = Number(properties.min_floor) * ESTIMATED_FLOOR_HEIGHT_FT;
    return { ...height, feet: height.feet + minimumHeightFt, source: `${height.source} + min_floor estimate`, quality: height.quality === "fallback" ? "estimated" as const : height.quality };
  }
  return height;
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
      envelopes: [geographicRectangleEnvelope(lons[index], lats[index], width, depth, origin)],
      heightFt,
      heightSource: "height_ft",
      heightQuality: "measured" as const,
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
    const height = propertyTopHeight(properties);
    const center = lngLatToLocal(item.lon, item.lat, origin);
    let envelopes = item.rings.map((ring) => ring.map(([lon, lat]) => lngLatToLocal(lon, lat, origin)));
    if (envelopes.length === 1 && envelopes[0].length === 1) envelopes = [geographicRectangleEnvelope(item.lon, item.lat, Number(properties.width_ft) || 180, Number(properties.depth_ft) || 180, origin)];
    envelopes = envelopes.map((envelope) => envelope.length > 2 && envelope[0].x === envelope[envelope.length - 1].x && envelope[0].y === envelope[envelope.length - 1].y ? envelope.slice(0, -1) : envelope);
    return {
      id: String(properties.id || item.feature.id || `geo-${item.index}`),
      name: propertyName(properties, `Imported building ${item.index + 1}`),
      ...center,
      envelopes,
      heightFt: Math.round(height.feet),
      heightSource: height.source,
      heightQuality: height.quality,
    };
  });
  return { buildings, origin, note: "GeoJSON envelopes preserved · Overture height fields supported" };
}

const emptyFeatures = (): FeatureCollection => featureCollection([]);

function ringsFromOvertureFeature(feature: Feature<Polygon | MultiPolygon>): number[][][] {
  if (feature.geometry.type === "Polygon") return [(feature.geometry.coordinates as number[][][])[0]];
  if (feature.geometry.type === "MultiPolygon") return (feature.geometry.coordinates as number[][][][]).map((candidate) => candidate[0]);
  return [];
}

type OvertureBuildingRecord = {
  building: Building;
  entityId: string;
  parentBuildingId?: string;
  sourceLayer: "building" | "building_part";
};

type OvertureBuildingReduction = {
  buildings: Building[];
  retainedFeatureKeys: Set<string>;
  parentCount: number;
  totalPartCount: number;
  retainedPartCount: number;
};

function partExtendsOutsideParent(part: Building, parent: Building) {
  return part.envelopes.some((partEnvelope) => partEnvelope.some((partPoint) => !parent.envelopes.some((parentEnvelope) => (
    pointInPolygon(partPoint, parentEnvelope) || distanceToEnvelope(partPoint, parentEnvelope) <= 5
  ))));
}

function overtureBuildingsFromFeatures(
  features: Array<Feature<Polygon | MultiPolygon>>,
  origin: Origin,
): OvertureBuildingReduction {
  const records = new Map<string, OvertureBuildingRecord>();
  features.forEach((feature, index) => {
    const properties = (feature.properties || {}) as Record<string, unknown>;
    const sourceLayer = properties.__sourceLayer === "building_part" ? "building_part" : "building";
    const rings = ringsFromOvertureFeature(feature);
    if (!rings.length) return;
    const entityId = String(properties.id || feature.id || index);
    const key = `${sourceLayer}:${entityId}`;
    const envelopes = rings
      .map((ring) => ring.map(([lon, lat]) => lngLatToLocal(Number(lon), Number(lat), origin)))
      .map((envelope) => envelope.length > 2 && envelope[0].x === envelope[envelope.length - 1].x && envelope[0].y === envelope[envelope.length - 1].y ? envelope.slice(0, -1) : envelope)
      .filter((envelope) => envelope.length >= 3);
    if (!envelopes.length) return;
    const existing = records.get(key);
    if (existing) {
      existing.building.envelopes.push(...envelopes);
      return;
    }
    const points = envelopes.flat();
    const height = propertyTopHeight(properties);
    records.set(key, {
      entityId,
      parentBuildingId: sourceLayer === "building_part" && properties.building_id ? String(properties.building_id) : undefined,
      sourceLayer,
      building: {
        id: key,
        name: propertyName(properties, sourceLayer === "building_part" ? "Building part" : "Building"),
        x: points.reduce((sum, value) => sum + value.x, 0) / points.length,
        y: points.reduce((sum, value) => sum + value.y, 0) / points.length,
        envelopes,
        heightFt: Math.round(height.feet),
        heightSource: height.source,
        heightQuality: height.quality,
        sourceKind: "building",
      },
    });
  });
  const values = [...records.values()];
  const parentsById = new Map(values
    .filter((record) => record.sourceLayer === "building")
    .map((record) => [record.entityId, record]));
  const retained: OvertureBuildingRecord[] = [];
  values.forEach((record) => {
    if (record.sourceLayer === "building") {
      retained.push(record);
      return;
    }
    const parent = record.parentBuildingId ? parentsById.get(record.parentBuildingId) : undefined;
    if (!parent) {
      retained.push(record);
      return;
    }
    const partAddsHeight = record.building.heightQuality !== "fallback"
      && (parent.building.heightQuality === "fallback" || record.building.heightFt > parent.building.heightFt + 1);
    const extendsOutsideParent = partExtendsOutsideParent(record.building, parent.building);
    if (shouldRetainOvertureBuildingPart(
      true,
      partAddsHeight,
      extendsOutsideParent,
    )) retained.push(record);
  });
  const totalPartCount = values.filter((record) => record.sourceLayer === "building_part").length;
  const retainedPartCount = retained.filter((record) => record.sourceLayer === "building_part").length;
  return {
    buildings: retained.map((record) => record.building),
    retainedFeatureKeys: new Set(retained.map((record) => `${record.sourceLayer}:${record.entityId}`)),
    parentCount: values.length - totalPartCount,
    totalPartCount,
    retainedPartCount,
  };
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

function terrainCellAtLngLat(lon: number, lat: number, terrainIndex: Map<string, TerrainCell>) {
  const xPosition = tileXPosition(lon, TERRAIN_TILE_ZOOM);
  const yPosition = tileYPosition(lat, TERRAIN_TILE_ZOOM);
  const tileColumn = Math.floor(xPosition);
  const tileRow = Math.floor(yPosition);
  const cellColumn = Math.max(0, Math.min(TERRAIN_CELL_DIVISIONS - 1, Math.floor((xPosition - tileColumn) * TERRAIN_CELL_DIVISIONS)));
  const cellRow = Math.max(0, Math.min(TERRAIN_CELL_DIVISIONS - 1, Math.floor((yPosition - tileRow) * TERRAIN_CELL_DIVISIONS)));
  return terrainIndex.get(terrainCellId(TERRAIN_TILE_ZOOM, tileColumn, tileRow, cellColumn, cellRow)) ?? null;
}

function terrainElevationAtLngLat(lon: number, lat: number, terrainIndex: Map<string, TerrainCell>) {
  return terrainCellAtLngLat(lon, lat, terrainIndex)?.elevationFt ?? null;
}

function addGroundElevations(buildings: Building[], origin: Origin, terrainIndex: Map<string, TerrainCell>) {
  return buildings.map((building) => {
    if (building.topElevationFt != null) return building;
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

function geographicStudyZone(polygons: number[][][][], origin: Origin): Zone {
  return {
    id: "rendered-study-area",
    label: "Selected U.S. study area",
    source: "User-selected bounds clipped to the supported U.S. boundary; not an FAA designation",
    polygons: polygons.map((rings) => rings.map((ring) => ring.map(([longitude, latitude]) => (
      lngLatToLocal(longitude, latitude, origin)
    )))),
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

function representativePointForStudyArea(polygons: number[][][][], bounds: RenderBounds): [number, number] {
  const center: [number, number] = [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2];
  const area: GeographicArea = { ...bounds, polygons };
  if (pointInGeographicArea(center[0], center[1], area)) return center;
  return polygons[0]?.[0]?.[0] as [number, number] || center;
}

function boundsForGeographicPolygons(polygons: number[][][][]): RenderBounds {
  const bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  polygons.forEach((rings) => rings.forEach((ring) => ring.forEach(([longitude, latitude]) => {
    bounds.west = Math.min(bounds.west, longitude);
    bounds.east = Math.max(bounds.east, longitude);
    bounds.south = Math.min(bounds.south, latitude);
    bounds.north = Math.max(bounds.north, latitude);
  })));
  return bounds;
}

function boundsForZone(zone: Zone, origin: Origin): RenderBounds {
  const coordinates = zone.polygons.flatMap((rings) => rings.flatMap((ring) => ring)).map((value) => localToLngLat(value, origin));
  return {
    west: Math.min(...coordinates.map(([lon]) => lon)),
    east: Math.max(...coordinates.map(([lon]) => lon)),
    south: Math.min(...coordinates.map(([, lat]) => lat)),
    north: Math.max(...coordinates.map(([, lat]) => lat)),
  };
}

function mapRegionForLocation(longitude: number, latitude: number) {
  return (Object.entries(US_MAP_REGIONS) as Array<[UsMapRegionId, (typeof US_MAP_REGIONS)[UsMapRegionId]]>)
    .find(([, region]) => longitude >= region.bounds[0][0]
      && longitude <= region.bounds[1][0]
      && latitude >= region.bounds[0][1]
      && latitude <= region.bounds[1][1])?.[0] ?? null;
}

function buildingsWithinGeographicAreas(buildings: Building[], origin: Origin, areas: GeographicArea[]) {
  return buildings.every((building) => {
    const samples = [{ x: building.x, y: building.y }, ...building.envelopes.flat()];
    return samples.every((sample) => {
      const [longitude, latitude] = localToLngLat(sample, origin);
      return pointInGeographicAreas(longitude, latitude, areas);
    });
  });
}

export function AirspacePlanner() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renderAreaRef = useRef<(bounds: RenderBounds) => Promise<boolean>>(async () => false);
  const computeOverlayRef = useRef<(altitudeFt: number) => Promise<boolean>>(async () => false);
  const invalidateModelRef = useRef<() => void>(() => undefined);
  const workerModelReadyRef = useRef(false);
  const renderedAltitudeRef = useRef<number | null>(null);
  const tileBudgetRef = useRef(DEFAULT_TILE_BUDGET);
  const groupDenseOverlaysRef = useRef(true);
  const drawingAreaRef = useRef(false);
  const selectionStartRef = useRef<[number, number] | null>(null);
  const coverageBoundsRef = useRef<{ west: number; east: number; south: number; north: number } | null>(null);
  const terrainCoverageBoundsRef = useRef<{ west: number; east: number; south: number; north: number } | null>(null);
  const loadedTileKeyRef = useRef<string | null>(null);
  const loadedViewportKeyRef = useRef<string | null>(null);
  const pendingTileKeyRef = useRef<string | null>(null);
  const loadedTerrainTileKeyRef = useRef<string | null>(null);
  const pendingTerrainTileKeyRef = useRef<string | null>(null);
  const loadedBuildingsDataRef = useRef<Building[]>([]);
  const loadedTerrainCellsDataRef = useRef<TerrainCell[]>([]);
  const loadedOriginDataRef = useRef<Origin>(CHICAGO_ORIGIN);
  const liveDataRef = useRef({ altitudeFt: 1800, buildings: [] as Building[], zones: [] as Zone[], origin: CHICAGO_ORIGIN, sourceMode: "overture" as "overture" | "local" });
  const [altitudeFt, setAltitudeFt] = useState(1800);
  const [committedAltitudeFt, setCommittedAltitudeFt] = useState(1800);
  const [tileBudget, setTileBudget] = useState(DEFAULT_TILE_BUDGET);
  const [groupDenseOverlays, setGroupDenseOverlays] = useState(true);
  const [renderedDenseOverlayGrouping, setRenderedDenseOverlayGrouping] = useState<boolean | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [origin, setOrigin] = useState<Origin>(CHICAGO_ORIGIN);
  const [datasetName, setDatasetName] = useState("Overture Maps · automatic");
  const [dataNote, setDataNote] = useState("Select an area, then render building coverage");
  const [coverageStatus, setCoverageStatus] = useState<CoverageStatus>("idle");
  const [terrainCells, setTerrainCells] = useState<TerrainCell[]>([]);
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus>("idle");
  const [terrainNote, setTerrainNote] = useState("Surface elevations and open-water masking render only for the selected area");
  const [faaObstacleStatus, setFaaObstacleStatus] = useState<FaaObstacleStatus>("idle");
  const [faaObstacleNote, setFaaObstacleNote] = useState("FAA obstacles render only for the selected area");
  const [faaObstacleCount, setFaaObstacleCount] = useState(0);
  const [faaObstacleSnapshot, setFaaObstacleSnapshot] = useState<string | null>(null);
  const [sourceMode, setSourceMode] = useState<"overture" | "local">("overture");
  const [overtureRelease, setOvertureRelease] = useState(OVERTURE_FALLBACK_RELEASE);
  const [selectedLngLat, setSelectedLngLat] = useState<[number, number]>(localToLngLat({ x: 80, y: 160 }, CHICAGO_ORIGIN));
  const [importError, setImportError] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [usBoundaryAreas, setUsBoundaryAreas] = useState<GeographicArea[]>([]);
  const [usBoundaryStatus, setUsBoundaryStatus] = useState<UsBoundaryStatus>("loading");
  const [basemapError, setBasemapError] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>("street");
  const [mapRegion, setMapRegion] = useState<UsMapRegionId>("lower48");
  const [selectedBounds, setSelectedBounds] = useState<RenderBounds | null>(null);
  const [renderedBounds, setRenderedBounds] = useState<RenderBounds | null>(null);
  const [drawingArea, setDrawingArea] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress>({ active: false, value: 0, label: "Ready" });
  const [renderError, setRenderError] = useState("");
  const [conflictsGeoJson, setConflictsGeoJson] = useState<FeatureCollection<Polygon | MultiPolygon>>(() => featureCollection([]));
  const [activeObstacles, setActiveObstacles] = useState(0);
  const [flaggedSquareMiles, setFlaggedSquareMiles] = useState(0);
  const [overlayUpdating, setOverlayUpdating] = useState(false);

  useEffect(() => {
    liveDataRef.current = { altitudeFt: committedAltitudeFt, buildings, zones, origin, sourceMode };
  }, [committedAltitudeFt, buildings, zones, origin, sourceMode]);

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
  const selectedTerrainCell = useMemo(() => terrainCellAtLngLat(selectedLngLat[0], selectedLngLat[1], terrainIndex), [selectedLngLat, terrainIndex]);
  const selectedOverOpenWater = selectedTerrainCell?.openWater === true;
  const selectedSurfaceElevationFt = useMemo(
    () => highestTerrainElevationWithinRadius(selectedLngLat[0], selectedLngLat[1], terrainCells, CLEARANCE_DISTANCE_FT),
    [selectedLngLat, terrainCells],
  );
  const buildingCoverageAvailable = sourceMode === "local" || coverageStatus === "ready";
  const modelAvailable = Boolean(renderedBounds) && buildingCoverageAvailable && terrainStatus === "ready" && faaObstacleStatus === "ready";
  const pointRequirement = useMemo<Check>(
    () => modelAvailable ? evaluatePointRequirement(selected, selectedLngLat, modeledBuildings, zones, origin, selectedSurfaceElevationFt, selectedOverOpenWater) : { state: "unavailable" },
    [modelAvailable, selected, selectedLngLat, modeledBuildings, zones, origin, selectedSurfaceElevationFt, selectedOverOpenWater],
  );
  const check = useMemo(() => applyAltitudeToCheck(pointRequirement, altitudeFt), [pointRequirement, altitudeFt]);
  const buildingsGeoJson = useMemo(
    () => sourceMode === "local" ? featureCollection(modeledBuildings.filter((building) => building.sourceKind !== "faa-obstacle").map((building) => buildingFeature(building, origin))) : emptyFeatures(),
    [modeledBuildings, origin, sourceMode],
  );
  const faaObstaclesGeoJson = useMemo(
    () => featureCollection(modeledBuildings
      .filter((building) => building.sourceKind === "faa-obstacle")
      .map((obstacle) => point(localToLngLat(obstacle, origin), {
        id: obstacle.id,
        name: obstacle.name,
        heightFt: obstacle.heightFt,
        topElevationFt: buildingTopElevationFt(obstacle),
        verifiedStatus: obstacle.verifiedStatus,
      }))),
    [modeledBuildings, origin],
  );
  const zonesGeoJson = useMemo(() => featureCollection(zones.map((zone) => zoneFeature(zone, origin))), [zones, origin]);
  const selectedStudyGeometry = useMemo(
    () => selectedBounds ? boundsIntersectionWithGeographicAreas(selectedBounds, usBoundaryAreas) : [],
    [selectedBounds, usBoundaryAreas],
  );
  const selectionGeoJson = useMemo(
    () => selectedStudyGeometry.length
      ? featureCollection([multiPolygon(selectedStudyGeometry, { state: "selection" })])
      : emptyFeatures(),
    [selectedStudyGeometry],
  );
  const selectedGeoJson = useMemo(() => featureCollection([point(localToLngLat(selected, origin), { state: check.state })]), [selected, origin, check.state]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    let disposed = false;
    let loadSerial = 0;
    let terrainLoadSerial = 0;
    let areaRenderSerial = 0;
    let workerRequestSerial = 0;
    let latestWorkerRequestId = 0;
    let overlayUpdateSerial = 0;
    let queuedOverlayAltitude: number | null = null;
    let overlayComputePromise: Promise<boolean> | null = null;
    let worker: Worker | null = null;
    const workerRequests = new Map<number, {
      resolve: (result: ClearanceWorkerResult) => void;
      reject: (error: Error) => void;
      onProgress?: (value: number, label: string) => void;
      timeoutId: number;
    }>();

    const rejectWorkerRequests = (error: Error) => {
      const requests = [...workerRequests.values()];
      workerRequests.clear();
      requests.forEach(({ reject, timeoutId }) => {
        window.clearTimeout(timeoutId);
        reject(error);
      });
    };

    const stopWorker = (error: Error) => {
      const activeWorker = worker;
      worker = null;
      activeWorker?.terminate();
      workerModelReadyRef.current = false;
      rejectWorkerRequests(error);
    };

    const handleWorkerMessage = (event: MessageEvent<Record<string, unknown>>) => {
      const requestId = Number(event.data.requestId);
      const request = workerRequests.get(requestId);
      if (!request) return;
      if (event.data.type === "progress") {
        request.onProgress?.(Number(event.data.value), String(event.data.label || "Calculating clearance overlay"));
        return;
      }
      workerRequests.delete(requestId);
      window.clearTimeout(request.timeoutId);
      if (event.data.type === "error") {
        request.reject(new Error(String(event.data.message || "Clearance geometry could not be calculated.")));
        return;
      }
      request.resolve(event.data as unknown as ClearanceWorkerResult);
    };

    const ensureWorker = () => {
      if (worker) return worker;
      const nextWorker = new Worker(clearanceWorkerUrl, { type: "module" });
      nextWorker.onmessage = handleWorkerMessage;
      nextWorker.onerror = () => {
        if (worker !== nextWorker) return;
        stopWorker(new Error("The clearance worker stopped unexpectedly."));
      };
      nextWorker.onmessageerror = () => {
        if (worker !== nextWorker) return;
        stopWorker(new Error("The clearance worker returned an unreadable result."));
      };
      worker = nextWorker;
      return nextWorker;
    };

    const requestWorker = (
      message: Record<string, unknown>,
      onProgress?: (value: number, label: string) => void,
    ) => {
      const requestId = ++workerRequestSerial;
      latestWorkerRequestId = requestId;
      return new Promise<ClearanceWorkerResult>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          if (!workerRequests.has(requestId)) return;
          stopWorker(new Error("The clearance calculation exceeded the time limit."));
        }, CLEARANCE_WORKER_TIMEOUT_MS);
        workerRequests.set(requestId, { resolve, reject, onProgress, timeoutId });
        ensureWorker().postMessage({ ...message, requestId });
      }).then((result) => ({ result, requestId }));
    };

    const applyWorkerResult = (result: ClearanceWorkerResult) => {
      setConflictsGeoJson(result.conflicts);
      setActiveObstacles(result.activeObstacles);
      setFlaggedSquareMiles(result.flaggedSquareMiles);
      renderedAltitudeRef.current = result.altitudeFt;
    };

    invalidateModelRef.current = () => {
      areaRenderSerial += 1;
      overlayUpdateSerial += 1;
      queuedOverlayAltitude = null;
      latestWorkerRequestId = ++workerRequestSerial;
      workerModelReadyRef.current = false;
      renderedAltitudeRef.current = null;
      setOverlayUpdating(false);
    };

    computeOverlayRef.current = async (nextAltitudeFt: number) => {
      if (!workerModelReadyRef.current || disposed) return false;
      queuedOverlayAltitude = nextAltitudeFt;
      setOverlayUpdating(true);
      if (overlayComputePromise) return overlayComputePromise;
      const updateId = overlayUpdateSerial;
      const pending = (async () => {
        let applied = false;
        try {
          while (!disposed && workerModelReadyRef.current && queuedOverlayAltitude != null) {
            const targetAltitude = queuedOverlayAltitude;
            queuedOverlayAltitude = null;
            const { result, requestId } = await requestWorker({ type: "compute", altitudeFt: targetAltitude });
            if (disposed || updateId !== overlayUpdateSerial || requestId !== latestWorkerRequestId) return false;
            if (queuedOverlayAltitude != null || targetAltitude !== liveDataRef.current.altitudeFt) continue;
            applyWorkerResult(result);
            applied = true;
          }
          return applied;
        } catch (error) {
          console.error("Clearance overlay update failed", error);
          if (!disposed && updateId === overlayUpdateSerial) {
            workerModelReadyRef.current = false;
            renderedAltitudeRef.current = null;
            setRenderedBounds(null);
            setConflictsGeoJson(featureCollection([]));
            setActiveObstacles(0);
            setFlaggedSquareMiles(0);
            setRenderError("The clearance overlay update stopped. Press Render to retry this area.");
          }
          return false;
        }
      })();
      overlayComputePromise = pending;
      try {
        return await pending;
      } finally {
        if (overlayComputePromise === pending) overlayComputePromise = null;
        if (!disposed && updateId === overlayUpdateSerial) setOverlayUpdating(false);
      }
    };

    const catalogPromise = fetch(OVERTURE_CATALOG_URL)
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null);
    Promise.all([
      import("maplibre-gl"),
      import("pmtiles"),
      import("@mapbox/vector-tile"),
      import("pbf"),
    ]).then(([maplibregl, { PMTiles }, { VectorTile }, { PbfReader }]) => {
      if (disposed || !mapContainerRef.current) return;
      maplibregl.setWorkerUrl(maplibreWorkerUrl);
      let supportedUsAreas: GeographicArea[] = [];
      let unsupportedUsGeoJson: FeatureCollection<Polygon | MultiPolygon> = featureCollection([]);
      let release = OVERTURE_FALLBACK_RELEASE;
      let archive = new PMTiles(`https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}/buildings.pmtiles`);
      let waterArchive = new PMTiles(`https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}/base.pmtiles`);
      let fullTileZoom = 14;
      setOvertureRelease(release);
      setDatasetName(`Overture Maps · ${release}`);
      void catalogPromise.then((catalog) => {
        if (!disposed && typeof catalog?.latest === "string" && catalog.latest !== release) {
          release = catalog.latest;
          archive = new PMTiles(`https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}/buildings.pmtiles`);
          waterArchive = new PMTiles(`https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}/base.pmtiles`);
          setOvertureRelease(release);
          setDatasetName(`Overture Maps · ${release}`);
          void archive.getHeader().then((header) => {
            fullTileZoom = header.maxZoom;
          }).catch(() => undefined);
        }
      });
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
        minZoom: 3,
        maxZoom: 24,
        maxBounds: US_MAP_REGIONS.lower48.bounds,
        pitch: 0,
        bearing: 0,
        attributionControl: { customAttribution: '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank">Terrain © Mapzen · USGS 3DEP</a>' },
      });
      mapRef.current = map;

      void (async () => {
        if (disposed) return;
        const boundaryRelease = OVERTURE_FALLBACK_RELEASE;
        const divisionsArchive = new PMTiles(`https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${boundaryRelease}/divisions.pmtiles`);
        const coordinates = overtureUsBoundaryTileCoordinates(OVERTURE_DIVISION_TILE_ZOOM);
        const tiles = await mapWithConcurrency(coordinates, OVERTURE_FETCH_CONCURRENCY, async ({ x, y }) => ({
          x,
          y,
          tile: await loadCachedOvertureTile(
            `divisions:${boundaryRelease}:${OVERTURE_DIVISION_TILE_ZOOM}/${x}/${y}`,
            async () => (await divisionsArchive.getZxy(OVERTURE_DIVISION_TILE_ZOOM, x, y))?.data || null,
          ),
        }));
        if (disposed) return;
        const areas: GeographicArea[] = [];
        tiles.forEach(({ x, y, tile }) => {
          if (!tile) return;
          const vectorTile = new VectorTile(new PbfReader(new Uint8Array(tile)));
          const layer = vectorTile.layers.division_area;
          if (!layer) return;
          for (let index = 0; index < layer.length; index += 1) {
            const vectorFeature = layer.feature(index);
            const properties = (vectorFeature.properties || {}) as Record<string, unknown>;
            if (!isSupportedUsTerritorialDivision(properties)) continue;
            const geojson = vectorFeature.toGeoJSON(x, y, OVERTURE_DIVISION_TILE_ZOOM);
            if (geojson.geometry.type !== "Polygon" && geojson.geometry.type !== "MultiPolygon") continue;
            areas.push(geographicAreaFromFeature(geojson as Feature<Polygon | MultiPolygon>));
          }
        });
        if (!areas.length) throw new Error("Overture returned no supported U.S. territorial polygons.");
        supportedUsAreas = areas;
        unsupportedUsGeoJson = featureCollection([
          multiPolygon(unsupportedGeographyCoordinates(areas), { classification: "outside-supported-us-boundary" }),
        ]);
        setUsBoundaryAreas(areas);
        setUsBoundaryStatus("ready");
        (map.getSource("unsupported-geography") as GeoJSONSource | undefined)?.setData(unsupportedUsGeoJson);
      })().catch((error) => {
        console.error("U.S. territorial boundary loading failed", error);
        if (disposed) return;
        setUsBoundaryStatus("error");
        setRenderError("The U.S. country boundary could not be loaded. Reload to try again.");
      });

      const loadVisibleTerrainTiles = async (selection: RenderBounds, onProgress?: (value: number) => void) => {
        const requestRelease = release;
        const requestWaterArchive = waterArchive;
        const clearanceLatPadding = CLEARANCE_DISTANCE_FT / FEET_PER_LAT_DEGREE;
        const clearanceLonPadding = conservativeLongitudePaddingDegrees(selection.south, selection.north, CLEARANCE_DISTANCE_FT);
        const requiredCoverage = {
          west: selection.west - clearanceLonPadding,
          east: selection.east + clearanceLonPadding,
          south: selection.south - clearanceLatPadding,
          north: selection.north + clearanceLatPadding,
        };
        const previousCoverage = terrainCoverageBoundsRef.current;
        const alreadyCovered = Boolean(loadedTerrainTileKeyRef.current?.startsWith(`${requestRelease}:`)
          && previousCoverage
          && requiredCoverage.west >= previousCoverage.west
          && requiredCoverage.east <= previousCoverage.east
          && requiredCoverage.south >= previousCoverage.south
          && requiredCoverage.north <= previousCoverage.north);
        const clearTerrain = () => {
          terrainLoadSerial += 1;
          terrainCoverageBoundsRef.current = null;
          loadedTerrainTileKeyRef.current = null;
          pendingTerrainTileKeyRef.current = null;
          loadedTerrainCellsDataRef.current = [];
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
          return loadedTerrainCellsDataRef.current;
        }
        const maxTile = (2 ** TERRAIN_TILE_ZOOM) - 1;
        const minX = Math.max(0, Math.min(maxTile, tileX(requiredCoverage.west, TERRAIN_TILE_ZOOM)));
        const maxX = Math.max(0, Math.min(maxTile, tileX(requiredCoverage.east, TERRAIN_TILE_ZOOM)));
        const minY = Math.max(0, Math.min(maxTile, tileY(requiredCoverage.north, TERRAIN_TILE_ZOOM)));
        const maxY = Math.max(0, Math.min(maxTile, tileY(requiredCoverage.south, TERRAIN_TILE_ZOOM)));
        const visibleTileCount = (maxX - minX + 1) * (maxY - minY + 1);
        const activeTileBudget = tileBudgetRef.current;
        if (visibleTileCount <= 0 || visibleTileCount > activeTileBudget) {
          clearTerrain();
          setTerrainStatus("zoom-required");
          setTerrainNote(`Selected area spans ${visibleTileCount.toLocaleString()} elevation tiles · select an area using ${activeTileBudget} or fewer`);
          return null;
        }
        const coordinates: Array<{ x: number; y: number }> = [];
        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) coordinates.push({ x, y });
        }
        const maxWaterTile = (2 ** WATER_TILE_ZOOM) - 1;
        const minimumWaterX = Math.max(0, Math.min(maxWaterTile, tileX(requiredCoverage.west, WATER_TILE_ZOOM)));
        const maximumWaterX = Math.max(0, Math.min(maxWaterTile, tileX(requiredCoverage.east, WATER_TILE_ZOOM)));
        const minimumWaterY = Math.max(0, Math.min(maxWaterTile, tileY(requiredCoverage.north, WATER_TILE_ZOOM)));
        const maximumWaterY = Math.max(0, Math.min(maxWaterTile, tileY(requiredCoverage.south, WATER_TILE_ZOOM)));
        const waterCoordinates: Array<{ x: number; y: number }> = [];
        for (let x = minimumWaterX; x <= maximumWaterX; x += 1) {
          for (let y = minimumWaterY; y <= maximumWaterY; y += 1) waterCoordinates.push({ x, y });
        }
        const tileKey = `${requestRelease}:${coordinates.map(({ x, y }) => `${TERRAIN_TILE_ZOOM}/${x}/${y}`).join("|")}`;
        if (loadedTerrainTileKeyRef.current === tileKey) {
          terrainCoverageBoundsRef.current = {
            west: Math.min(previousCoverage?.west ?? requiredCoverage.west, requiredCoverage.west),
            east: Math.max(previousCoverage?.east ?? requiredCoverage.east, requiredCoverage.east),
            south: Math.min(previousCoverage?.south ?? requiredCoverage.south, requiredCoverage.south),
            north: Math.max(previousCoverage?.north ?? requiredCoverage.north, requiredCoverage.north),
          };
          setTerrainStatus("ready");
          onProgress?.(1);
          return loadedTerrainCellsDataRef.current;
        }
        if (pendingTerrainTileKeyRef.current === tileKey) return null;
        const requestId = ++terrainLoadSerial;
        pendingTerrainTileKeyRef.current = tileKey;
        setTerrainStatus("loading");
        setTerrainNote(`Loading ${coordinates.length} bare-earth elevation tile${coordinates.length === 1 ? "" : "s"} and open-water coverage…`);
        try {
          let fetched = 0;
          const totalRequests = coordinates.length + waterCoordinates.length;
          const reportFetch = () => {
            fetched += 1;
            onProgress?.(0.8 * (fetched / totalRequests));
          };
          const [loaded, waterTiles] = await Promise.all([
            mapWithConcurrency(coordinates, TERRAIN_FETCH_CONCURRENCY, async ({ x, y }) => {
              const summary = await loadTerrainTile(TERRAIN_TILE_ZOOM, x, y);
              reportFetch();
              return summary;
            }),
            mapWithConcurrency(waterCoordinates, OVERTURE_FETCH_CONCURRENCY, async ({ x, y }) => {
              const tile = await loadCachedOvertureTile(
                `base:${requestRelease}:${WATER_TILE_ZOOM}/${x}/${y}`,
                async () => (await requestWaterArchive.getZxy(WATER_TILE_ZOOM, x, y))?.data || null,
              );
              reportFetch();
              return { x, y, tile };
            }),
          ]);
          if (disposed || requestId !== terrainLoadSerial) return null;
          if (loaded.some((summary) => !summary)) throw new Error("One or more terrain tiles were unavailable.");
          const waterAreas: OpenWaterArea[] = [];
          for (let tileIndex = 0; tileIndex < waterTiles.length; tileIndex += 1) {
            const { x, y, tile } = waterTiles[tileIndex];
            if (tile) {
              const vectorTile = new VectorTile(new PbfReader(new Uint8Array(tile)));
              const layer = vectorTile.layers.water;
              if (layer) {
                for (let featureIndex = 0; featureIndex < layer.length; featureIndex += 1) {
                  const vectorFeature = layer.feature(featureIndex);
                  const geojson = vectorFeature.toGeoJSON(x, y, WATER_TILE_ZOOM);
                  if (!isOpenWaterFeature((geojson.properties || {}) as Record<string, unknown>)) continue;
                  if (geojson.geometry.type !== "Polygon" && geojson.geometry.type !== "MultiPolygon") continue;
                  waterAreas.push(openWaterAreaFromFeature(geojson as Feature<Polygon | MultiPolygon>));
                }
              }
            }
            onProgress?.(0.8 + 0.1 * ((tileIndex + 1) / Math.max(1, waterTiles.length)));
          }
          if (requestRelease !== release) {
            pendingTerrainTileKeyRef.current = null;
            return loadVisibleTerrainTiles(selection, onProgress);
          }
          let openWaterCellCount = 0;
          const cells = (loaded as TerrainTileSummary[]).flatMap((summary) => summary.cells).map((cell) => {
            const openWater = terrainCellIsConfidentOpenWater(cell, waterAreas);
            if (openWater) openWaterCellCount += 1;
            return openWater ? { ...cell, openWater: true } : cell;
          });
          onProgress?.(0.98);
          if (disposed || requestId !== terrainLoadSerial) return null;
          setTerrainCells(cells);
          loadedTerrainCellsDataRef.current = cells;
          loadedTerrainTileKeyRef.current = tileKey;
          pendingTerrainTileKeyRef.current = null;
          terrainCoverageBoundsRef.current = requiredCoverage;
          setTerrainStatus("ready");
          setTerrainNote(`${(cells.length - openWaterCellCount).toLocaleString()} land/shoreline surface cells · ${openWaterCellCount.toLocaleString()} confident open-water cells excluded · ${coordinates.length} z${TERRAIN_TILE_ZOOM} elevation tile${coordinates.length === 1 ? "" : "s"}`);
          onProgress?.(1);
          return cells;
        } catch (error) {
          console.error("Terrain tile load failed", error);
          if (!disposed && requestId === terrainLoadSerial) {
            clearTerrain();
            setTerrainStatus("error");
            setTerrainNote("Bare-earth elevation tiles could not be reached. Reload to try again.");
          }
          return null;
        }
      };

      const loadVisibleBuildingTiles = async (
        selection: RenderBounds,
        studyPolygons: number[][][][],
        onProgress?: (value: number) => void,
      ) => {
        if (liveDataRef.current.sourceMode !== "overture" || !map.getSource("overture-buildings")) return null;
        const requestRelease = release;
        const requestArchive = archive;
        const buildingModeKey = "parent-plus-necessary-parts";
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
        const clearanceLonPadding = conservativeLongitudePaddingDegrees(selection.south, selection.north, CLEARANCE_DISTANCE_FT);
        const requiredCoverage = {
          west: selection.west - clearanceLonPadding,
          east: selection.east + clearanceLonPadding,
          south: selection.south - clearanceLatPadding,
          north: selection.north + clearanceLatPadding,
        };
        const previousCoverage = coverageBoundsRef.current;
        const viewportAlreadyCovered = Boolean(loadedTileKeyRef.current?.startsWith(`${requestRelease}:${buildingModeKey}:`)
          && previousCoverage
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
          loadedOriginDataRef.current = nextOrigin;
          loadedBuildingsDataRef.current = [];
          setBuildings([]);
          setZones([geographicStudyZone(studyPolygons, nextOrigin)]);
        };
        if (viewportAlreadyCovered && loadedTileKeyRef.current) {
          const cancelledRefresh = Boolean(pendingTileKeyRef.current);
          if (cancelledRefresh) {
            loadSerial += 1;
            pendingTileKeyRef.current = null;
          }
          const stableOrigin = loadedOriginDataRef.current;
          const nextZones = [geographicStudyZone(studyPolygons, stableOrigin)];
          setZones(nextZones);
          loadedViewportKeyRef.current = viewportKey;
          setCoverageStatus("ready");
          if (cancelledRefresh) setDataNote("Using already-loaded full-detail coverage · no tile reload needed");
          onProgress?.(1);
          return { buildings: loadedBuildingsDataRef.current, origin: stableOrigin, zones: nextZones } satisfies BuildingLoadResult;
        }
        const zoom = fullTileZoom;
        const maxTile = (2 ** zoom) - 1;
        const minX = Math.max(0, Math.min(maxTile, tileX(requiredCoverage.west, zoom)));
        const maxX = Math.max(0, Math.min(maxTile, tileX(requiredCoverage.east, zoom)));
        const minY = Math.max(0, Math.min(maxTile, tileY(requiredCoverage.north, zoom)));
        const maxY = Math.max(0, Math.min(maxTile, tileY(requiredCoverage.south, zoom)));
        const visibleTileCount = (maxX - minX + 1) * (maxY - minY + 1);
        const activeTileBudget = tileBudgetRef.current;
        if (visibleTileCount <= 0 || visibleTileCount > activeTileBudget) {
          clearCoverage();
          setCoverageStatus("zoom-required");
          setDataNote(`Selected area plus the 2,000-ft clearance halo spans ${visibleTileCount.toLocaleString()} full-detail tiles · select an area using ${activeTileBudget} or fewer`);
          return null;
        }
        const coordinates: Array<{ x: number; y: number }> = [];
        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) coordinates.push({ x, y });
        }
        const tileKey = `${requestRelease}:${buildingModeKey}:${coordinates.map(({ x, y }) => `${zoom}/${x}/${y}`).join("|")}`;
        if (loadedTileKeyRef.current === tileKey) {
          if (loadedViewportKeyRef.current !== viewportKey) {
            const stableOrigin = liveDataRef.current.origin;
            const nextZones = [geographicStudyZone(studyPolygons, stableOrigin)];
            setZones(nextZones);
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
          const stableOrigin = loadedOriginDataRef.current;
          return { buildings: loadedBuildingsDataRef.current, origin: stableOrigin, zones: [geographicStudyZone(studyPolygons, stableOrigin)] } satisfies BuildingLoadResult;
        }
        if (pendingTileKeyRef.current === tileKey) return null;
        const requestId = ++loadSerial;
        pendingTileKeyRef.current = tileKey;
        setCoverageStatus("loading");
        setDataNote(`Loading ${coordinates.length} selected-area Overture tile${coordinates.length === 1 ? "" : "s"}…`);
        try {
          let fetched = 0;
          const tiles = await mapWithConcurrency(coordinates, OVERTURE_FETCH_CONCURRENCY, async ({ x, y }) => {
            const tile = await loadCachedOvertureTile(
              `${requestRelease}:${zoom}/${x}/${y}`,
              async () => (await requestArchive.getZxy(zoom, x, y))?.data || null,
            );
            fetched += 1;
            onProgress?.(0.45 * (fetched / coordinates.length));
            return { x, y, tile };
          });
          if (disposed || requestId !== loadSerial) return null;
          const decoded: Array<Feature<Polygon | MultiPolygon>> = [];
          let lastYieldAt = performance.now();
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
                if (isUnderground) continue;
                const height = propertyTopHeight(raw);
                geojson.properties = {
                  id: raw.id || vectorFeature.id || `${zoom}/${x}/${y}/${sourceLayer}/${index}`,
                  building_id: raw.building_id,
                  name: raw.name,
                  "@name": raw["@name"],
                  names: raw.names,
                  height: raw.height,
                  height_m: raw.height_m,
                  height_ft: raw.height_ft,
                  num_floors: raw.num_floors,
                  "building:levels": raw["building:levels"],
                  min_height: raw.min_height,
                  min_floor: raw.min_floor,
                  __sourceLayer: sourceLayer,
                  __renderHeightM: height.feet / 3.28084,
                };
                decoded.push(geojson as Feature<Polygon | MultiPolygon>);
              }
            });
            if (performance.now() - lastYieldAt >= 10) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              lastYieldAt = performance.now();
            }
            onProgress?.(0.45 + 0.55 * ((tileIndex + 1) / tiles.length));
            if (disposed || requestId !== loadSerial) return null;
          }
          if (requestRelease !== release) {
            pendingTileKeyRef.current = null;
            return loadVisibleBuildingTiles(selection, studyPolygons, onProgress);
          }
          const reduction = overtureBuildingsFromFeatures(decoded, nextOrigin);
          const nextBuildings = reduction.buildings;
          const measured = nextBuildings.filter((building) => building.heightQuality !== "fallback").length;
          const retainedDecoded = decoded.filter((feature) => {
            const properties = feature.properties as Record<string, unknown>;
            return reduction.retainedFeatureKeys.has(`${String(properties.__sourceLayer)}:${String(properties.id)}`);
          });
          retainedDecoded.forEach((feature) => {
            const properties = feature.properties as Record<string, unknown>;
            feature.properties = {
              id: properties.id,
              __sourceLayer: properties.__sourceLayer,
              __renderHeightM: properties.__renderHeightM,
            };
          });
          source.setData(featureCollection(retainedDecoded));
          setOrigin(nextOrigin);
          loadedOriginDataRef.current = nextOrigin;
          loadedBuildingsDataRef.current = nextBuildings;
          setBuildings(nextBuildings);
          const nextZones = [geographicStudyZone(studyPolygons, nextOrigin)];
          setZones(nextZones);
          loadedTileKeyRef.current = tileKey;
          loadedViewportKeyRef.current = viewportKey;
          pendingTileKeyRef.current = null;
          coverageBoundsRef.current = requiredCoverage;
          setCoverageStatus("ready");
          setDatasetName(`Overture Maps · ${requestRelease}`);
          setDataNote(`${reduction.parentCount.toLocaleString()} parent envelopes + ${reduction.retainedPartCount.toLocaleString()} of ${reduction.totalPartCount.toLocaleString()} necessary parts · ${measured.toLocaleString()} with height/floor data · ${coordinates.length} full-detail z${zoom} tile${coordinates.length === 1 ? "" : "s"}`);
          onProgress?.(1);
          return { buildings: nextBuildings, origin: nextOrigin, zones: nextZones } satisfies BuildingLoadResult;
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
          return null;
        }
      };

      const loadVisibleFaaObstacles = async (selection: RenderBounds, onProgress?: (value: number) => void) => {
        setFaaObstacleStatus("loading");
        setFaaObstacleNote("Loading the official FAA Daily Digital Obstacle File snapshot…");
        try {
          const result = await loadFaaObstacleRows(selection, onProgress);
          if (disposed) return null;
          setFaaObstacleStatus("ready");
          setFaaObstacleCount(result.rows.length);
          setFaaObstacleSnapshot(result.manifest.sourceLastModified);
          setFaaObstacleNote(`${result.rows.length.toLocaleString()} FAA obstacle${result.rows.length === 1 ? "" : "s"} in the selected area, accuracy margin, and clearance halo · ${result.manifest.sourceLastModified || "current bundled"} DDOF snapshot`);
          onProgress?.(1);
          return result.rows;
        } catch (error) {
          console.error("FAA obstacle data load failed", error);
          if (!disposed) {
            setFaaObstacleStatus("error");
            setFaaObstacleCount(0);
            setFaaObstacleNote("FAA obstacle coverage could not be loaded, so no clearance conclusion is shown.");
          }
          return null;
        }
      };

      renderAreaRef.current = async (selection: RenderBounds) => {
        if (!supportedUsAreas.length) {
          setRenderError("The U.S. country boundary is still loading. Try again in a moment.");
          return false;
        }
        const studyPolygons = boundsIntersectionWithGeographicAreas(selection, supportedUsAreas);
        if (!studyPolygons.length) {
          setRenderError("The Model Area does not overlap the supported U.S. territorial boundary.");
          return false;
        }
        const studyBounds = boundsForGeographicPolygons(studyPolygons);
        const renderId = ++areaRenderSerial;
        overlayUpdateSerial += 1;
        queuedOverlayAltitude = null;
        latestWorkerRequestId = ++workerRequestSerial;
        workerModelReadyRef.current = false;
        renderedAltitudeRef.current = null;
        setOverlayUpdating(false);
        setRenderError("");
        setRenderedBounds(null);
        setConflictsGeoJson(featureCollection([]));
        setActiveObstacles(0);
        setFlaggedSquareMiles(0);
        setTerrainStatus("loading");
        setTerrainNote("Waiting to render surface elevations…");
        setFaaObstacleStatus("loading");
        setFaaObstacleNote("Waiting to render FAA obstacle coverage…");
        setFaaObstacleCount(0);
        setRenderProgress({ active: true, value: 2, label: "Preparing selected area" });
        let buildingProgress = liveDataRef.current.sourceMode === "local" ? 1 : 0;
        let terrainProgress = 0;
        let faaProgress = 0;
        let lastProgressAt = 0;
        let lastProgressValue = -1;
        const reportLoadingProgress = (force = false) => {
          if (disposed || renderId !== areaRenderSerial) return;
          const now = performance.now();
          const value = Math.round(2 + ((buildingProgress + terrainProgress + faaProgress) / 3) * 68);
          if (!force && value === lastProgressValue && now - lastProgressAt < 100) return;
          if (!force && now - lastProgressAt < 80) return;
          lastProgressAt = now;
          lastProgressValue = value;
          const label = buildingProgress < 1 && (terrainProgress < 1 || faaProgress < 1)
            ? "Loading buildings, FAA obstacles, surface elevation, and water coverage"
            : buildingProgress < 1
              ? "Decoding building envelopes"
              : faaProgress < 1
                ? "Loading FAA obstacle records"
                : terrainProgress < 1
                ? "Screening surface elevations"
                : "Model layers ready";
          setRenderProgress({ active: true, value, label });
        };
        const stableOrigin = liveDataRef.current.origin;
        const localZones = [geographicStudyZone(studyPolygons, stableOrigin)];
        const buildingPromise: Promise<BuildingLoadResult | null> = liveDataRef.current.sourceMode === "overture"
          ? loadVisibleBuildingTiles(studyBounds, studyPolygons, (value) => {
            buildingProgress = value;
            reportLoadingProgress();
          })
          : Promise.resolve({ buildings: loadedBuildingsDataRef.current, origin: stableOrigin, zones: localZones });
        if (liveDataRef.current.sourceMode === "local") {
          setZones(localZones);
          setCoverageStatus("ready");
        }
        const terrainPromise = loadVisibleTerrainTiles(studyBounds, (value) => {
          terrainProgress = value;
          reportLoadingProgress();
        });
        const faaObstaclePromise = loadVisibleFaaObstacles(studyBounds, (value) => {
          faaProgress = value;
          reportLoadingProgress();
        });
        const [buildingResult, terrainResult, faaObstacleRows] = await Promise.all([buildingPromise, terrainPromise, faaObstaclePromise]);
        reportLoadingProgress(true);
        if (!buildingResult || disposed || renderId !== areaRenderSerial) {
          if (!disposed && renderId === areaRenderSerial) {
            setRenderError("The selected building coverage could not be rendered.");
            setRenderProgress({ active: false, value: 0, label: "Render failed" });
          }
          return false;
        }
        if (!terrainResult || disposed || renderId !== areaRenderSerial) {
          if (!disposed && renderId === areaRenderSerial) {
            setRenderError("The selected surface coverage could not be rendered.");
            setRenderProgress({ active: false, value: 0, label: "Render failed" });
          }
          return false;
        }
        if (!faaObstacleRows || disposed || renderId !== areaRenderSerial) {
          if (!disposed && renderId === areaRenderSerial) {
            setRenderError("The selected FAA obstacle coverage could not be rendered.");
            setRenderProgress({ active: false, value: 0, label: "Render failed" });
          }
          return false;
        }
        const nextTerrainIndex = new Map(terrainResult.map((cell) => [cell.id, cell]));
        const faaObstacles = faaObstaclesFromRows(faaObstacleRows, buildingResult.origin);
        const nextModeledBuildings = addGroundElevations([...buildingResult.buildings, ...faaObstacles], buildingResult.origin, nextTerrainIndex);
        loadedOriginDataRef.current = buildingResult.origin;
        setBuildings(nextModeledBuildings);
        setOrigin(buildingResult.origin);
        setZones(buildingResult.zones);
        setRenderProgress({ active: true, value: 72, label: "Preparing clearance geometry" });
        try {
          const { result, requestId } = await requestWorker({
            type: "prepare",
            altitudeFt: liveDataRef.current.altitudeFt,
            buildings: nextModeledBuildings,
            terrainCells: terrainResult,
            zones: buildingResult.zones,
            origin: buildingResult.origin,
            renderedBounds: studyBounds,
            groupDenseOverlays: groupDenseOverlaysRef.current,
          }, (value, label) => {
            if (renderId === areaRenderSerial) setRenderProgress({ active: true, value: Math.round(72 + value * 27), label });
          });
          if (disposed || renderId !== areaRenderSerial || requestId !== latestWorkerRequestId) return false;
          applyWorkerResult(result);
          workerModelReadyRef.current = true;
        } catch (error) {
          console.error("Clearance model preparation failed", error);
          if (!disposed && renderId === areaRenderSerial) {
            setRenderError("The selected clearance geometry could not be prepared.");
            setRenderProgress({ active: false, value: 0, label: "Render failed" });
          }
          return false;
        }
        setRenderedBounds(studyBounds);
        setRenderedDenseOverlayGrouping(groupDenseOverlaysRef.current);
        setSelectedLngLat(representativePointForStudyArea(studyPolygons, studyBounds));
        setRenderProgress({ active: true, value: 100, label: "Render complete" });
        setTimeout(() => {
          if (!disposed && renderId === areaRenderSerial) setRenderProgress({ active: false, value: 100, label: "Render complete" });
        }, 700);
        return true;
      };

      map.on("style.load", () => {
        setBasemapError(false);
        requestAnimationFrame(() => {
          try {
            void archive.getHeader().then((header) => {
              fullTileZoom = header.maxZoom;
            }).catch(() => undefined);
            const beforeId = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
            map.addSource("unsupported-geography", {
              type: "geojson",
              data: unsupportedUsGeoJson,
              attribution: '<a href="https://docs.overturemaps.org/schema/reference/divisions/division_area/" target="_blank">© Overture Maps Foundation</a>',
            });
            map.addSource("overture-buildings", { type: "geojson", data: emptyFeatures(), maxzoom: 14, tolerance: 0.5, attribution: '<a href="https://docs.overturemaps.org/attribution" target="_blank">© Overture Maps Foundation</a>' });
            map.addSource("clearance-zones", { type: "geojson", data: emptyFeatures() });
            map.addSource("clearance-conflicts", { type: "geojson", data: emptyFeatures(), maxzoom: 14, tolerance: 0.25 });
            map.addSource("clearance-buildings", { type: "geojson", data: emptyFeatures(), maxzoom: 14, tolerance: 0.5 });
            map.addSource("faa-obstacles", { type: "geojson", data: emptyFeatures() });
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
            map.addLayer({ id: "faa-obstacle-points", type: "circle", source: "faa-obstacles", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 15, 4.5, 20, 7], "circle-color": ["match", ["get", "verifiedStatus"], "unverified", "#f0a13b", "#72231d"], "circle-stroke-color": "#fffdf7", "circle-stroke-width": 1.25, "circle-opacity": 0.95 } }, beforeId);
            map.addLayer({ id: "unsupported-geography-fill", type: "fill", source: "unsupported-geography", paint: { "fill-color": "#72787a", "fill-opacity": 0.92 } }, beforeId);
            map.addLayer({ id: "unsupported-geography-line", type: "line", source: "unsupported-geography", paint: { "line-color": "#51585b", "line-width": 1, "line-opacity": 0.82 } }, beforeId);
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
        if (!supportedUsAreas.length) {
          setRenderError("The U.S. country boundary is still loading. Try again in a moment.");
          return;
        }
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
        const selection = normalizedBounds(selectionStartRef.current, [event.lngLat.lng, event.lngLat.lat]);
        setSelectedBounds(selection);
        if (!boundsIntersectionWithGeographicAreas(selection, supportedUsAreas).length) {
          setRenderError("The Model Area does not overlap the supported U.S. boundary.");
        } else {
          setRenderError("");
        }
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
        if (!pointInGeographicAreas(event.lngLat.lng, event.lngLat.lat, supportedUsAreas)) {
          setRenderError("Selected-point checks are limited to supported U.S. locations.");
          return;
        }
        setRenderError("");
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
      computeOverlayRef.current = async () => false;
      invalidateModelRef.current = () => undefined;
      workerModelReadyRef.current = false;
      renderedAltitudeRef.current = null;
      rejectWorkerRequests(new Error("Clearance worker was stopped."));
      worker?.terminate();
      drawingAreaRef.current = false;
      selectionStartRef.current = null;
      loadedTileKeyRef.current = null;
      loadedViewportKeyRef.current = null;
      pendingTileKeyRef.current = null;
      terrainCoverageBoundsRef.current = null;
      loadedTerrainTileKeyRef.current = null;
      pendingTerrainTileKeyRef.current = null;
      loadedBuildingsDataRef.current = [];
      loadedTerrainCellsDataRef.current = [];
      loadedOriginDataRef.current = CHICAGO_ORIGIN;
      workerModelReadyRef.current = false;
      terrainCoverageBoundsRef.current = null;
      loadedTerrainTileKeyRef.current = null;
      pendingTerrainTileKeyRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!modelAvailable || !workerModelReadyRef.current) return;
    if (renderedAltitudeRef.current === committedAltitudeFt) return;
    void computeOverlayRef.current(committedAltitudeFt);
  }, [committedAltitudeFt, modelAvailable]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    (mapRef.current.getSource("clearance-zones") as GeoJSONSource)?.setData(zonesGeoJson);
  }, [mapReady, zonesGeoJson]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    (mapRef.current.getSource("clearance-conflicts") as GeoJSONSource)?.setData(conflictsGeoJson);
  }, [mapReady, conflictsGeoJson]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    (mapRef.current.getSource("clearance-buildings") as GeoJSONSource)?.setData(buildingsGeoJson);
  }, [mapReady, buildingsGeoJson]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    (mapRef.current.getSource("faa-obstacles") as GeoJSONSource)?.setData(faaObstaclesGeoJson);
  }, [mapReady, faaObstaclesGeoJson]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    (mapRef.current.getSource("clearance-selected") as GeoJSONSource)?.setData(selectedGeoJson);
  }, [mapReady, selectedGeoJson]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    (mapRef.current.getSource("clearance-selection") as GeoJSONSource)?.setData(selectionGeoJson);
  }, [mapReady, selectionGeoJson]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    ["clearance-building-fill", "clearance-building-line"].forEach((id) => {
      if (mapRef.current?.getLayer(id)) mapRef.current.setLayoutProperty(id, "visibility", sourceMode === "local" ? "visible" : "none");
    });
    ["overture-building-fill", "overture-building-part-fill", "overture-building-line"].forEach((id) => {
      if (mapRef.current?.getLayer(id)) mapRef.current.setLayoutProperty(id, "visibility", sourceMode === "overture" ? "visible" : "none");
    });
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
      if (!usBoundaryAreas.length) throw new Error("The U.S. boundary guard is still loading. Try the import again in a moment.");
      if (!buildingsWithinGeographicAreas(imported.buildings, imported.origin, usBoundaryAreas)) {
        throw new Error("Imported buildings must be inside the supported U.S. territorial boundary.");
      }
      const importedRegion = mapRegionForLocation(imported.origin.lon, imported.origin.lat);
      if (!importedRegion) throw new Error("The imported location is outside the supported U.S. map regions.");
      setSourceMode("local");
      invalidateModelRef.current();
      coverageBoundsRef.current = null;
      loadedTileKeyRef.current = null;
      loadedViewportKeyRef.current = null;
      pendingTileKeyRef.current = null;
      terrainCoverageBoundsRef.current = null;
      loadedTerrainTileKeyRef.current = null;
      pendingTerrainTileKeyRef.current = null;
      loadedBuildingsDataRef.current = imported.buildings;
      loadedTerrainCellsDataRef.current = [];
      loadedOriginDataRef.current = imported.origin;
      const importedZone = makeConservativeZone(imported.buildings, "Imported conservative study area");
      setCoverageStatus("idle");
      setBuildings(imported.buildings);
      setOrigin(imported.origin);
      setZones([]);
      setSelectedBounds(boundsForZone(importedZone, imported.origin));
      setRenderedBounds(null);
      setConflictsGeoJson(featureCollection([]));
      setActiveObstacles(0);
      setFlaggedSquareMiles(0);
      setDatasetName(file.name);
      setDataNote(`${imported.buildings.length.toLocaleString()} buildings · ${imported.note} · press Render`);
      setSelectedLngLat([imported.origin.lon, imported.origin.lat]);
      setMapRegion(importedRegion);
      setTerrainCells([]);
      setTerrainStatus("idle");
      setTerrainNote("Surface elevations and open-water masking render only after you press Render");
      setFaaObstacleStatus("idle");
      setFaaObstacleCount(0);
      setFaaObstacleNote("FAA obstacles render only after you press Render");
      setRenderError("");
      mapRef.current?.setMaxBounds(US_MAP_REGIONS[importedRegion].bounds);
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
    invalidateModelRef.current();
    coverageBoundsRef.current = null;
    loadedTileKeyRef.current = null;
    loadedViewportKeyRef.current = null;
    pendingTileKeyRef.current = null;
    terrainCoverageBoundsRef.current = null;
    loadedTerrainTileKeyRef.current = null;
    pendingTerrainTileKeyRef.current = null;
    loadedBuildingsDataRef.current = [];
    loadedTerrainCellsDataRef.current = [];
    loadedOriginDataRef.current = nextOrigin;
    workerModelReadyRef.current = false;
    setCoverageStatus("idle");
    setDatasetName(`Overture Maps · ${overtureRelease}`);
    setBuildings([]);
    setOrigin(nextOrigin);
    setZones([]);
    setSelectedBounds(mapRef.current ? mapViewportBounds(mapRef.current) : null);
    setRenderedBounds(null);
    setConflictsGeoJson(featureCollection([]));
    setActiveObstacles(0);
    setFlaggedSquareMiles(0);
    setDataNote("Area selected · press Render to load building coverage");
    setSelectedLngLat([nextOrigin.lon, nextOrigin.lat]);
    setTerrainCells([]);
    setTerrainStatus("idle");
    setTerrainNote("Surface elevations and open-water masking render only after you press Render");
    setFaaObstacleStatus("idle");
    setFaaObstacleCount(0);
    setFaaObstacleNote("FAA obstacles render only after you press Render");
    setImportError("");
    setRenderError("");
    mapRef.current?.triggerRepaint();
  }

  function beginAreaSelection() {
    if (!mapReady || renderProgress.active) return;
    if (usBoundaryStatus !== "ready") {
      setRenderError(usBoundaryStatus === "error"
        ? "The U.S. country boundary is unavailable. Reload to try again."
        : "The U.S. country boundary is still loading. Try again in a moment.");
      return;
    }
    setRenderError("");
    setDrawingArea((current) => !current);
    selectionStartRef.current = null;
  }

  function commitFlightAltitude(value: number) {
    const constrained = Math.max(1000, Math.min(18000, Math.round(value / 100) * 100));
    setAltitudeFt(constrained);
    setCommittedAltitudeFt(constrained);
  }

  function useCurrentView() {
    if (!mapRef.current || renderProgress.active) return;
    if (usBoundaryStatus !== "ready") {
      setRenderError(usBoundaryStatus === "error"
        ? "The U.S. country boundary is unavailable. Reload to try again."
        : "The U.S. country boundary is still loading. Try again in a moment.");
      return;
    }
    const viewBounds = mapViewportBounds(mapRef.current);
    if (!boundsIntersectionWithGeographicAreas(viewBounds, usBoundaryAreas).length) {
      setRenderError("The current view does not overlap the supported U.S. boundary. Move the map to a supported U.S. location.");
      return;
    }
    setDrawingArea(false);
    selectionStartRef.current = null;
    setSelectedBounds(viewBounds);
    setRenderError("");
  }

  async function renderSelectedArea() {
    if (!selectedBounds || renderProgress.active) return;
    if (usBoundaryStatus !== "ready") {
      setRenderError(usBoundaryStatus === "error"
        ? "The U.S. country boundary is unavailable. Reload to try again."
        : "The U.S. country boundary is still loading. Try again in a moment.");
      return;
    }
    if (!boundsIntersectionWithGeographicAreas(selectedBounds, usBoundaryAreas).length) {
      setRenderError("The Model Area does not overlap the supported U.S. territorial boundary.");
      return;
    }
    setDrawingArea(false);
    selectionStartRef.current = null;
    await renderAreaRef.current(selectedBounds);
  }

  function changeMapRegion(nextRegion: UsMapRegionId) {
    const region = US_MAP_REGIONS[nextRegion];
    setMapRegion(nextRegion);
    setSourceMode("overture");
    invalidateModelRef.current();
    coverageBoundsRef.current = null;
    loadedTileKeyRef.current = null;
    loadedViewportKeyRef.current = null;
    pendingTileKeyRef.current = null;
    terrainCoverageBoundsRef.current = null;
    loadedTerrainTileKeyRef.current = null;
    pendingTerrainTileKeyRef.current = null;
    loadedBuildingsDataRef.current = [];
    loadedTerrainCellsDataRef.current = [];
    loadedOriginDataRef.current = { lon: region.center[0], lat: region.center[1] };
    setCoverageStatus("idle");
    setDatasetName(`Overture Maps · ${overtureRelease}`);
    setBuildings([]);
    setTerrainCells([]);
    setZones([]);
    setOrigin({ lon: region.center[0], lat: region.center[1] });
    setRenderedBounds(null);
    setConflictsGeoJson(featureCollection([]));
    setActiveObstacles(0);
    setFlaggedSquareMiles(0);
    setTerrainStatus("idle");
    setFaaObstacleStatus("idle");
    setFaaObstacleCount(0);
    setDataNote("Select an area, then render building coverage");
    setTerrainNote("Surface elevations and open-water masking render only for the selected area");
    setFaaObstacleNote("FAA obstacles render only for the selected area");
    setSelectedLngLat(region.center);
    setDrawingArea(false);
    selectionStartRef.current = null;
    setSelectedBounds(null);
    setRenderError("");
    mapRef.current?.setMaxBounds(region.bounds);
    mapRef.current?.flyTo({ center: region.center, zoom: region.zoom, essential: true });
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
      ? check.openWater && check.requiredFt == null ? "No modeled surface minimum" : "Modeled clearance met"
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
  const faaObstacleCoverageLabel = faaObstacleStatus === "idle"
    ? "FAA obstacles · Awaiting render"
    : faaObstacleStatus === "loading"
      ? "FAA obstacles · Loading"
      : faaObstacleStatus === "error"
        ? "FAA obstacles · Unavailable"
        : `FAA obstacles · ${faaObstacleCount.toLocaleString()} loaded`;
  const modelDataLabel = !buildingCoverageAvailable
    ? sourceMode === "overture" ? overtureCoverageLabel : "Local buildings · Ready"
    : terrainStatus !== "ready" ? terrainCoverageLabel : faaObstacleCoverageLabel;
  const modelBadge = !renderedBounds && !renderProgress.active && coverageStatus === "idle" && terrainStatus === "idle"
    ? "RENDER"
    : !buildingCoverageAvailable
      ? coverageStatus === "loading" ? "LOADING" : coverageStatus === "error" ? "ERROR" : "NARROW AREA"
      : terrainStatus === "loading" ? "TERRAIN" : terrainStatus === "error" ? "ERROR" : terrainStatus === "idle" ? "RENDER" : terrainStatus === "zoom-required" ? "NARROW AREA" : faaObstacleStatus === "loading" ? "FAA DATA" : faaObstacleStatus === "error" ? "ERROR" : "RENDER";
  const unavailableMessage = modelAvailable && selectedSurfaceElevationFt == null
    ? "No decoded surface elevation is available at the selected point, so no clearance conclusion is shown."
    : !renderedBounds && coverageStatus === "idle" && terrainStatus === "idle"
      ? "Select an area on the map and press Render. The completed clearance result will remain fixed while you pan or zoom."
    : coverageStatus === "zoom-required"
    ? `The selected area and its 2,000-ft clearance halo exceed the ${tileBudget}-tile full-detail budget. Increase the budget or select a smaller area.`
    : terrainStatus === "zoom-required"
      ? `Surface coverage exceeds the ${tileBudget}-tile elevation budget. Increase the budget or select a smaller area.`
      : terrainStatus === "loading"
        ? "Bare-earth surface elevations must load before clearance can be evaluated."
      : terrainStatus === "error"
          ? "Surface elevation coverage is unavailable, so no clearance conclusion is shown."
          : faaObstacleStatus === "loading"
            ? "FAA obstacle coverage must finish loading before clearance can be evaluated."
            : faaObstacleStatus === "error"
              ? "FAA obstacle coverage is unavailable, so no clearance conclusion is shown."
              : "Building, FAA obstacle, and surface coverage must finish rendering before clearance can be evaluated.";
  const selectionOverlapsUs = selectedStudyGeometry.length > 0;
  const selectionIsClipped = Boolean(selectionOverlapsUs
    && selectedBounds
    && !boundsWithinGeographicAreas(selectedBounds, usBoundaryAreas));
  const selectionIsValid = Boolean(selectedBounds
    && selectedBounds.east - selectedBounds.west > 0.000001
    && selectedBounds.north - selectedBounds.south > 0.000001
    && selectionOverlapsUs);
  const denseOverlaySettingPending = Boolean(renderedBounds
    && renderedDenseOverlayGrouping !== groupDenseOverlays);
  const selectionLabel = usBoundaryStatus === "loading"
    ? "Loading U.S. territorial boundary…"
    : usBoundaryStatus === "error"
      ? "U.S. territorial boundary unavailable"
    : drawingArea
    ? "Drag across the map to draw a box"
    : selectedBounds && !selectionOverlapsUs
      ? "Selection does not overlap the supported U.S. boundary"
    : selectionIsClipped
      ? renderedBounds ? "U.S. portion ready · current result stays until re-render" : "U.S. portion selected · ready to render"
    : selectedBounds
      ? renderedBounds ? "New area ready · current result stays until re-render" : "Area selected · ready to render"
      : "Draw a box or use the current view";
  const modelStatusClass = sourceMode === "local" ? "local" : overlayUpdating ? "processing" : modelAvailable ? "" : "paused";

  return (
    <main className="app-shell">
      <aside className="legal-bar" aria-label="Planning aid disclaimer">
        <span><b>PLANNING AID ONLY</b> This model will never be fully accurate or complete and cannot determine whether a flight is legal or authorized.</span>
        <button onClick={() => setInfoOpen(true)}>Read limitations</button>
      </aside>

      <header className="topbar">
        <button className="brand" onClick={activateOverture} aria-label="Clearance home and use automatic Overture buildings"><span className="brand-mark" aria-hidden="true"><i /></span><span>CLEARANCE</span></button>
        <div className="rule-chip"><span>RULESET</span> FAA §91.119(b)</div>
        <div className="topbar-actions">
          <div className={`overture-status ${modelStatusClass}`}><span className="status-dot" /><span><small>MODEL DATA</small>{overlayUpdating ? "Updating clearance overlay" : modelDataLabel}</span></div>
          <button className="icon-button" onClick={() => setInfoOpen(true)} aria-label="About this planning aid">?</button>
          <input ref={inputRef} className="visually-hidden" type="file" accept=".csv,.geojson,.json,application/geo+json,text/csv" onChange={handleImport} />
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <div className="eyebrow-row"><span className="eyebrow">FLIGHT ALTITUDE</span><span className={`live-label ${overlayUpdating ? "processing" : modelAvailable ? "" : "paused"}`}><i /> {overlayUpdating ? "UPDATING MODEL" : "ENVELOPE MODEL"}</span></div>
          <div className="altitude-readout"><strong>{altitudeFt.toLocaleString()}</strong><span>FT<br />MSL</span></div>
          <label className="slider-wrap"><span className="visually-hidden">Flight altitude in feet above mean sea level; clearance geometry updates when adjustment finishes</span><input
            type="range"
            min="1000"
            max="18000"
            step="100"
            value={altitudeFt}
            onChange={(event) => setAltitudeFt(Number(event.target.value))}
            onPointerUp={(event) => commitFlightAltitude(Number(event.currentTarget.value))}
            onPointerCancel={(event) => commitFlightAltitude(Number(event.currentTarget.value))}
            onKeyUp={(event) => {
              if (ALTITUDE_COMMIT_KEYS.has(event.key)) commitFlightAltitude(Number(event.currentTarget.value));
            }}
            onBlur={(event) => commitFlightAltitude(Number(event.currentTarget.value))}
          /><span className="range-labels"><b>1,000</b><b>18,000 FT MSL</b></span></label>
          <div className="preset-row" aria-label="Altitude presets">{[2000, 5000, 10000, 15000].map((preset) => <button key={preset} className={altitudeFt === preset ? "active" : ""} onClick={() => commitFlightAltitude(preset)}>{preset.toLocaleString()}</button>)}</div>

          <div className="rule-block">
            <div className="rule-heading"><span className="rule-number">§</span><span><small>MODELED STANDARD</small>91.119(b) clearance</span></div>
            <div className="rule-metrics"><div><strong>1,000</strong><span>FT ABOVE</span></div><i /><div><strong>2,000</strong><span>FT FROM ENVELOPE</span></div></div>
            <p>Altitude is MSL. The model requires 1,000 ft above land/shoreline terrain, building tops, and FAA-listed obstacles within 2,000 ft horizontally. Confident open water has no surface-elevation minimum.</p>
          </div>

          <div className={`point-check ${check.state}`} aria-live="polite">
            <div className="point-check-title"><span className="check-symbol">{check.state === "conflict" ? "!" : check.state === "clear" ? "✓" : check.state === "unavailable" ? "?" : "·"}</span><span><small>SELECTED POINT</small>{statusTitle}</span></div>
            {check.state === "unavailable" ? <p>{unavailableMessage}</p> : check.state !== "outside" ? <dl>
              <div><dt>Required altitude</dt><dd>{check.requiredFt == null && check.openWater ? "None from water surface" : `${check.requiredFt?.toLocaleString()} ft MSL`}</dd></div>
              {check.requiredFt != null && <div><dt>{(check.marginFt ?? 0) < 0 ? "Shortfall" : "Margin"}</dt><dd>{Math.abs(check.marginFt ?? 0).toLocaleString()} ft</dd></div>}
              <div><dt>Highest terrain within 2,000 ft</dt><dd>{check.surfaceElevationFt == null ? check.openWater ? "Open water · no nearby land terrain" : "Unavailable" : `${check.surfaceElevationFt.toLocaleString()} ft MSL`}</dd></div>
              <div><dt>Controlling surface</dt><dd>{check.controllingSource === "obstacle" ? check.obstacle?.name ?? "Obstacle" : check.surfaceElevationFt != null ? "Nearby bare earth" : "No modeled water-surface minimum"}</dd></div>
              {check.obstacleTopElevationFt != null && <div><dt>{check.obstacle?.sourceKind === "faa-obstacle" ? "FAA modeled obstacle top" : "Highest obstacle top"}</dt><dd>{check.obstacleTopElevationFt.toLocaleString()} ft MSL</dd></div>}
              {check.obstacle?.sourceKind === "faa-obstacle" && <div><dt>FAA accuracy code</dt><dd>{check.obstacle.accuracyCode || "Unknown"} · H {check.obstacle.horizontalAccuracyFt == null ? "unknown" : `±${check.obstacle.horizontalAccuracyFt.toLocaleString()} ft`} · V {check.obstacle.verticalAccuracyFt == null ? "unknown" : `±${check.obstacle.verticalAccuracyFt.toLocaleString()} ft`}</dd></div>}
              {check.obstacle && <div><dt>Distance to modeled envelope</dt><dd>{Math.round(check.envelopeDistanceFt ?? 0).toLocaleString()} ft</dd></div>}
            </dl> : <p>Click inside a dashed amber study polygon to run the clearance screen.</p>}
          </div>

          <div className="screen-summary"><span><small>RED AREA</small><strong>{modelAvailable ? `${flaggedSquareMiles.toFixed(2)} mi²` : "—"}</strong></span><span><small>ACTIVE OBSTACLES</small><strong>{modelAvailable ? activeObstacles : "—"}</strong></span></div>

          <div className="panel-footer">
            <button aria-expanded={detailsOpen} aria-controls="model-details" onClick={() => setDetailsOpen((current) => !current)}>{detailsOpen ? "Hide" : "Show"} model details <span>{detailsOpen ? "−" : "+"}</span></button>
            {detailsOpen && <div className="model-details" id="model-details">
              <div className="model-layers-card"><span className="dataset-icon" aria-hidden="true">▤</span><span><small>{sourceMode === "overture" ? "AUTOMATIC MODEL LAYERS" : "LOCAL BUILDINGS + TERRAIN"}</small><strong>{datasetName}</strong><em>{dataNote}</em><em>{terrainNote}</em><em>{faaObstacleNote}</em></span>{sourceMode === "local" ? <button onClick={activateOverture}>Use Overture</button> : <span className={`data-live ${modelAvailable ? "" : "paused"}`}>{overlayUpdating ? "UPDATING" : modelAvailable ? "LIVE" : modelBadge}</span>}</div>
              <label className="dense-overlay-option" htmlFor="group-dense-overlays" aria-label="Group dense red clearance overlays">
                <input
                  id="group-dense-overlays"
                  type="checkbox"
                  checked={groupDenseOverlays}
                  disabled={renderProgress.active}
                  onChange={(event) => {
                    const nextValue = event.target.checked;
                    groupDenseOverlaysRef.current = nextValue;
                    setGroupDenseOverlays(nextValue);
                  }}
                />
                <span><strong>Group dense red overlays</strong><small>{groupDenseOverlays ? "ON · group nearby envelopes above 500 active obstacles" : "OFF · preserve every active obstacle envelope"}{denseOverlaySettingPending ? " · Re-render to apply" : ""}</small></span>
              </label>
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
              <a className="national-source water-source" href="https://docs.overturemaps.org/schema/reference/base/water/" target="_blank" rel="noreferrer">
                <span className="source-kicker">OPEN-WATER MASK · AUTOMATIC</span>
                <strong>Overture Maps Water <b>↗</b></strong>
                <span>PMTiles z{WATER_TILE_ZOOM} · permanent ocean and inland-water polygons · guarded shoreline classification</span>
              </a>
              <a className="national-source" href="https://docs.overturemaps.org/schema/reference/divisions/division_area/" target="_blank" rel="noreferrer">
                <span className="source-kicker">SUPPORTED U.S. BOUNDARY · AUTOMATIC</span>
                <strong>Overture Maps Divisions <b>↗</b></strong>
                <span>PMTiles z{OVERTURE_DIVISION_TILE_ZOOM} · territorial country and U.S. dependency polygons · {usBoundaryStatus.toUpperCase()}</span>
              </a>
              <a className="national-source faa-source" href="https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/DailyDOF/" target="_blank" rel="noreferrer">
                <span className="source-kicker">KNOWN AVIATION OBSTACLES · FAA SNAPSHOT</span>
                <strong>FAA Daily DOF <b>↗</b></strong>
                <span>{faaObstacleSnapshot || "Bundled current"} · verified and unverified records · published AMSL plus known vertical tolerance</span>
              </a>
            </div>}
          </div>

          <section className="tile-budget-panel" aria-label="Tile budget controls">
            <label className="tile-budget-control">
              <span><small>FULL-DETAIL TILE BUDGET</small><strong>{tileBudget}</strong></span>
              <input
                type="range"
                min={MIN_TILE_BUDGET}
                max={MAX_TILE_BUDGET}
                step="32"
                value={tileBudget}
                disabled={renderProgress.active}
                onChange={(event) => {
                  const nextBudget = Number(event.target.value);
                  tileBudgetRef.current = nextBudget;
                  setTileBudget(nextBudget);
                }}
                aria-label="Full-detail building and elevation tile budget"
              />
              <em><b>{MIN_TILE_BUDGET}</b><b>{MAX_TILE_BUDGET.toLocaleString()}</b></em>
            </label>
          </section>
        </aside>

        <section className="map-panel" aria-label="Interactive two-dimensional United States clearance map">
          <div ref={mapContainerRef} className={`map-container ${drawingArea ? "drawing-area" : ""}`} aria-label={`Interactive U.S.-only basemap at ${altitudeFt} feet MSL. Draw a selection box to render a clearance model, or click to check a point in the rendered area.`} />
          {!mapReady && !basemapError && <div className="basemap-loading"><i />Loading basemap…</div>}
          {basemapError && !mapReady && <div className="basemap-loading error">Basemap unavailable. Check your connection.</div>}
          <div className="map-controls" aria-label="Map zoom controls">
            <button onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in">＋</button>
            <button onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out">−</button>
            <button onClick={() => mapRef.current?.flyTo({ center: [origin.lon, origin.lat], zoom: 14.2, essential: true })} aria-label="Reset map view">◎</button>
          </div>
          <div className="basemap-switch" role="group" aria-label="Select basemap">
            <button className={basemap === "street" ? "active" : ""} aria-pressed={basemap === "street"} onClick={() => setBasemap("street")}>Street</button>
            <button className={basemap === "sectional" ? "active" : ""} aria-pressed={basemap === "sectional"} title="Sectionals with Terminal Area Charts where available" onClick={() => setBasemap("sectional")}>FAA Charts</button>
          </div>
          <label className="region-switch"><span>Region</span><select value={mapRegion} onChange={(event) => changeMapRegion(event.target.value as UsMapRegionId)} aria-label="Select United States map region">{(Object.entries(US_MAP_REGIONS) as Array<[UsMapRegionId, (typeof US_MAP_REGIONS)[UsMapRegionId]]>).map(([id, region]) => <option key={id} value={id}>{region.label}</option>)}</select></label>
          <section className="model-area-toolbar" aria-label="Model area controls">
            <div className="model-area-copy" aria-live="polite"><small>MODEL AREA · U.S. ONLY</small><strong className={renderError ? "error" : ""} role={renderError ? "alert" : undefined}>{renderError || selectionLabel}</strong></div>
            <div className="render-actions">
              <button className={drawingArea ? "active" : ""} aria-pressed={drawingArea} onClick={beginAreaSelection}>{drawingArea ? "Cancel draw" : "Draw area"}</button>
              <button onClick={useCurrentView} disabled={!mapReady || renderProgress.active}>Use view</button>
              <button className="render-primary" onClick={renderSelectedArea} disabled={!selectionIsValid || renderProgress.active}>{renderedBounds ? "Re-render" : "Render"}</button>
            </div>
            {renderedBounds && !renderProgress.active && <p className="render-persisted"><i />Rendered result is fixed until you press Re-render.</p>}
          </section>
          {(renderProgress.active || overlayUpdating) && <div className="map-processing-overlay" role="status" aria-live="polite" aria-busy="true">
            <div className="render-progress">
              <div className="render-progress-copy">
                <span><small>{renderProgress.active ? "RENDERING SELECTED AREA" : "UPDATING CLEARANCE"}</small><strong>{renderProgress.active ? renderProgress.label : "Updating red boundaries"}</strong></span>
                {renderProgress.active ? <em>{Math.round(renderProgress.value)}%</em> : <span className="render-progress-spinner" aria-hidden="true" />}
              </div>
              <div className={`render-progress-track ${renderProgress.active ? "" : "indeterminate"}`} aria-hidden="true"><i style={renderProgress.active ? { width: `${Math.max(0, Math.min(100, renderProgress.value))}%` } : undefined} /></div>
              <p>{renderProgress.active
                ? "Buildings, FAA obstacles, terrain, and open-water coverage are being screened. The completed overlay will stay on the map until you re-render."
                : "Recalculating obstacle and terrain conflicts for the selected altitude. The map will be available when the boundaries are ready."}</p>
            </div>
          </div>}
          <div className="legend" aria-label="Map legend"><span><i className="legend-red" />Clearance conflict</span><span><i className="legend-amber" />Rendered area</span><span><i className="legend-blue" />Selection</span><span><i className="legend-building" />Building</span><span><i className="legend-faa" />FAA obstacle</span><span><i className="legend-unsupported" />Outside supported U.S.</span></div>
          <div className="basemap-badge">BASEMAP · {basemap === "street" ? "CARTO / OPENSTREETMAP" : "FAA SECTIONAL + TAC"}</div>
        </section>
      </section>

      {importError && <div className="toast error" role="alert"><span>!</span>{importError}<button onClick={() => setImportError("")} aria-label="Dismiss error">×</button></div>}

      {infoOpen && <div className="modal-backdrop">
        <button className="modal-scrim" onClick={() => setInfoOpen(false)} aria-label="Close limitations dialog" />
        <section className="info-modal" role="dialog" aria-modal="true" aria-labelledby="limitations-title">
          <button className="modal-close" onClick={() => setInfoOpen(false)} aria-label="Close">×</button>
          <span className="modal-kicker">MODEL NOTES</span>
          <h2 id="limitations-title">A conservative screen—not a complete or authoritative answer.</h2>
          <p><b>This model will never be fully accurate or complete.</b> It cannot establish legality, authorization, obstacle clearance, or safe flight. Always use current official aeronautical sources and independent preflight judgment.</p>
          <p>The aircraft altitude is modeled in feet MSL. Required altitude uses the highest modeled land or shoreline terrain, building top, or FAA-listed obstacle top within 2,000 feet, plus 1,000 feet. Confident open water creates no surface minimum by itself, but nearby land terrain remains active.</p>
          <p>GeoJSON Polygon and MultiPolygon outer footprints are preserved. The building conflict geometry begins at the closest footprint edge and buffers it by 2,000 feet.</p>
          <p>Overture parent buildings marked <code>has_parts</code> remain as the complete outer envelope. Parts are linked through <code>building_id</code> and retained when they add a higher modeled top, extend outside the parent, or have no loaded parent. Floating-part tops include <code>min_height</code> or estimated <code>min_floor</code>.</p>
          <p>FAA Daily DOF records are points, not surveyed footprints. Known vertical tolerance is added to the published AMSL value before clearance is calculated. Known horizontal tolerance widens the point envelope before the 2,000-ft buffer is applied. Unknown horizontal accuracy keeps the 20-foot minimum point envelope, while unknown vertical accuracy remains unadjusted and explicitly unknown.</p>
          <p>The FAA file includes both verified and unverified obstacles. Both are modeled; unverified values are explicitly unreliable, and the FAA states that the file does not contain every obstruction that may be encountered.</p>
          <p>When the dense-overlay option is enabled and more than 500 obstacles are active, nearby envelopes are conservatively grouped for the red overlay so the altitude control stays responsive. Turning the option off preserves every active obstacle envelope in the red geometry. The selected-point check always tests individual building envelopes.</p>
          <p>Terrain tiles are divided into 64×64-pixel cells. Each land or shoreline cell uses its highest DEM pixel, and terrain conflicts expand 2,000 feet horizontally just like obstacle envelopes. Invalid, out-of-range, or incomplete Terrarium tiles stop the model instead of producing a clearance result. Open water uses guarded z{WATER_TILE_ZOOM} Overture geometry; uncertain and intermittent-water cells remain terrain.</p>
          <p>Over open water, §91.119(c) does not prescribe a fixed height above the water surface, but it still restricts proximity to people, vessels, vehicles, and structures, and §91.119(a) still applies. This model preserves building and FAA-obstacle screening but does not know real-time vessel, vehicle, or person locations.</p>
          <p>Building and terrain evaluation use fixed full-detail tiles independent of camera zoom. The altitude readout follows the slider while it moves, but red clearance geometry recalculates only when the slider adjustment finishes. Building floor counts use a conservative {ESTIMATED_FLOOR_HEIGHT_FT}-foot-per-floor estimate, while buildings with no height information retain the 30-foot fallback. Each render includes a 2,000-ft halo around the U.S.-clipped Model Area; the selectable tile budget is currently {tileBudget} tiles.</p>
          <p>Mapping, imports, selected-point checks, and Model Areas use Overture Maps territorial country and U.S. dependency polygons. A selection may cross the boundary, but only its U.S. intersection is displayed and evaluated; the remainder stays gray. Unlike state shoreline polygons, the mask includes Overture’s best approximation of maritime jurisdiction, including the U.S. portions of the Great Lakes.</p>
          <p>The rendered result remains fixed while you pan or zoom and changes only when you press Re-render. The FAA evaluates whether an area is “congested” case by case, so the selected box is treated as a conservative study area—not labeled as an official FAA boundary.</p>
          <div className="modal-warning"><b>Small UAS note</b><span>Part 107 generally uses a different 400-foot AGL framework and may require airspace authorization. This prototype models the Part 91 rule named above.</span></div>
          <div className="source-detail">
            <h3>Automatic national source: Overture Maps</h3>
            <p>The map loads Overture’s official global Buildings PMTiles archive for the current release. Polygon/MultiPolygon parent footprints are preserved, while redundant part geometry is removed only after evaluating its parent relationship, footprint extent, and modeled top height.</p>
            <a href="https://docs.overturemaps.org/guides/buildings/" target="_blank" rel="noreferrer">Open Overture Buildings guide ↗</a>
          </div>
          <div className="source-detail">
            <h3>Bare-earth source: Mapzen Terrain Tiles</h3>
            <p>Terrarium elevation tiles are loaded from the AWS Open Data terrain archive. United States terrain in this archive is attributed to USGS 3DEP/NED; elevations are decoded in meters and converted to feet MSL.</p>
            <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noreferrer">Open AWS terrain dataset ↗</a>
          </div>
          <div className="source-detail">
            <h3>Open-water source: Overture Maps Base</h3>
            <p>Permanent polygon features classified as ocean, lake, pond, reservoir, river, stream, water, or canal are used to identify confident open-water terrain cells. Human-made pools, wastewater, intermittent water, and uncertain shoreline cells are not excluded.</p>
            <a href="https://docs.overturemaps.org/schema/reference/base/water/" target="_blank" rel="noreferrer">Open Overture water schema ↗</a>
          </div>
          <div className="source-detail">
            <h3>Known obstacle source: FAA Daily DOF</h3>
            <p>The bundled {faaObstacleSnapshot || "current"} snapshot contains the FAA’s known obstacles of interest to aviation, split into geographic shards so only the selected area and its halo load in the browser. The source is refreshed with <code>pnpm data:faa</code>.</p>
            <a href="https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/DailyDOF/" target="_blank" rel="noreferrer">Open FAA Daily DOF ↗</a>
          </div>
          <div className="file-help"><h3>Advanced local override</h3><p>GeoJSON: use <code>height_ft</code>, Overture <code>height</code> (meters), <code>height_m</code>, <code>num_floors</code>, or <code>building:levels</code>. Floating features may also provide <code>min_height</code> or <code>min_floor</code>. CSV: include <code>lat, lon, height_ft, width_ft, depth_ft</code>.</p><div className="file-actions"><button onClick={() => inputRef.current?.click()}>Import local file</button><button onClick={downloadTemplate}>Download CSV template</button>{sourceMode === "local" && <button onClick={activateOverture}>Return to Overture</button>}</div></div>
          <div className="modal-links"><a href="https://www.faa.gov/about/office_org/field_offices/fsdo/anf" target="_blank" rel="noreferrer">FAA §91.119 overview ↗</a><a href="https://www.faa.gov/about/office_org/headquarters_offices/agc/practice_areas/regulations/interpretations/Data/interps/2009/Anderson_2009_Legal_Interpretation.pdf" target="_blank" rel="noreferrer">FAA Anderson interpretation ↗</a><a href="https://www.usgs.gov/3d-elevation-program" target="_blank" rel="noreferrer">USGS 3DEP ↗</a><a href="https://docs.overturemaps.org/schema/reference/divisions/division_area/" target="_blank" rel="noreferrer">Overture territorial boundary ↗</a><a href="https://carto.com/basemaps/" target="_blank" rel="noreferrer">Street basemap ↗</a><a href="https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/" target="_blank" rel="noreferrer">FAA chart sources ↗</a></div>
        </section>
      </div>}
    </main>
  );
}
