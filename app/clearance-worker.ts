import buffer from "@turf/buffer";
import intersect from "@turf/intersect";
import { featureCollection, multiPolygon, polygon } from "@turf/helpers";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { union as unionPolygons } from "polyclip-ts";
import type { Geom } from "polyclip-ts";

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
type PrepareMessage = {
  type: "prepare";
  requestId: number;
  altitudeFt: number;
  buildings: Building[];
  terrainCells: TerrainCell[];
  zones: Zone[];
  origin: Origin;
  renderedBounds: RenderBounds;
};
type ComputeMessage = { type: "compute"; requestId: number; altitudeFt: number };
type WorkerRequest = PrepareMessage | ComputeMessage;
type ConflictResult = {
  conflicts: FeatureCollection<Polygon | MultiPolygon>;
  activeObstacles: number;
  flaggedSquareMiles: number;
};

const CLEARANCE_DISTANCE_FT = 2000;
const TERRAIN_CELL_DIVISIONS = 4;
const FEET_PER_LAT_DEGREE = 364_000;
const EARTH_RADIUS_METERS = 6_371_008.8;
const SQUARE_METERS_PER_SQUARE_MILE = 2_589_988.110336;
const RESULT_CACHE_SIZE = 12;

let buildings: Building[] = [];
let terrainCells: TerrainCell[] = [];
let zones: Zone[] = [];
let origin: Origin = { lat: 0, lon: 0 };
let renderedBounds: RenderBounds = { west: 0, east: 0, south: 0, north: 0 };
let zoneFeatures: Array<Feature<Polygon>> = [];
const bufferedBuildingCache = new Map<string, Feature<Polygon | MultiPolygon> | null>();
const resultCache = new Map<number, ConflictResult>();

const feetPerLonDegree = (latitude: number) => 364_000 * Math.cos((latitude * Math.PI) / 180);

function localToLngLat(value: Point): [number, number] {
  return [origin.lon + value.x / feetPerLonDegree(origin.lat), origin.lat - value.y / FEET_PER_LAT_DEGREE];
}

function closedCoordinates(points: Point[]) {
  const closed = points.length && (points[0].x !== points[points.length - 1].x || points[0].y !== points[points.length - 1].y)
    ? [...points, points[0]]
    : points;
  return closed.map(localToLngLat);
}

function buildingFeature(building: Building): Feature<Polygon | MultiPolygon> {
  const properties = {
    id: building.id,
    name: building.name,
    heightFt: building.heightFt,
    groundElevationFt: building.groundElevationFt,
    topElevationFt: buildingTopElevationFt(building),
  };
  return building.envelopes.length > 1
    ? multiPolygon(building.envelopes.map((envelope) => [closedCoordinates(envelope)]), properties)
    : polygon([closedCoordinates(building.envelopes[0])], properties);
}

function zoneFeature(zone: Zone) {
  return polygon([closedCoordinates(zone.points)], { id: zone.id, label: zone.label, source: zone.source });
}

function rectangleEnvelope(x: number, y: number, width: number, depth: number): Point[] {
  return [
    { x: x - width / 2, y: y - depth / 2 },
    { x: x + width / 2, y: y - depth / 2 },
    { x: x + width / 2, y: y + depth / 2 },
    { x: x - width / 2, y: y + depth / 2 },
  ];
}

function buildingTopElevationFt(building: Building) {
  return building.groundElevationFt == null ? null : building.groundElevationFt + building.heightFt;
}

function groupDenseBuildings(activeBuildings: Building[], cellSize = 750): Building[] {
  const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; heightFt: number; groundElevationFt?: number; topElevationFt: number; count: number }>();
  activeBuildings.forEach((building) => {
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
    return {
      id: `group-${key}-${Math.round(group.minX)}-${Math.round(group.minY)}-${Math.round(group.maxX)}-${Math.round(group.maxY)}-${Math.round(group.topElevationFt)}`,
      name: `${group.count} nearby envelopes`,
      x,
      y,
      envelopes: [rectangleEnvelope(x, y, width, depth)],
      heightFt: group.heightFt,
      groundElevationFt: group.groundElevationFt,
      heightSource: "Dense-view group",
    };
  });
}

function terrainCellIntersectsBounds(cell: TerrainCell) {
  return cell.west < renderedBounds.east && cell.east > renderedBounds.west && cell.south < renderedBounds.north && cell.north > renderedBounds.south;
}

function compactTerrainFeatures(activeCells: TerrainCell[]) {
  const rows = new Map<string, TerrainCell[]>();
  activeCells.forEach((cell) => {
    const row = cell.tileY * TERRAIN_CELL_DIVISIONS + cell.cellY;
    const key = `${cell.zoom}:${row}`;
    const values = rows.get(key) || [];
    values.push(cell);
    rows.set(key, values);
  });
  const features: Array<Feature<Polygon>> = [];
  rows.forEach((cells) => {
    cells.sort((a, b) => (a.tileX * TERRAIN_CELL_DIVISIONS + a.cellX) - (b.tileX * TERRAIN_CELL_DIVISIONS + b.cellX));
    let runStart = cells[0];
    let runEnd = cells[0];
    const emitRun = () => {
      const west = Math.max(renderedBounds.west, runStart.west);
      const east = Math.min(renderedBounds.east, runEnd.east);
      const north = Math.min(renderedBounds.north, runStart.north);
      const south = Math.max(renderedBounds.south, runStart.south);
      if (west >= east || south >= north) return;
      features.push(polygon([[
        [west, north],
        [east, north],
        [east, south],
        [west, south],
        [west, north],
      ]]));
    };
    for (let index = 1; index < cells.length; index += 1) {
      const cell = cells[index];
      const previousColumn = runEnd.tileX * TERRAIN_CELL_DIVISIONS + runEnd.cellX;
      const column = cell.tileX * TERRAIN_CELL_DIVISIONS + cell.cellX;
      if (column === previousColumn + 1) {
        runEnd = cell;
        continue;
      }
      emitRun();
      runStart = cell;
      runEnd = cell;
    }
    emitRun();
  });
  return features;
}

function bufferedConflictFeature(building: Building) {
  const cached = bufferedBuildingCache.get(building.id);
  if (cached !== undefined) return cached;
  const expanded = buffer(buildingFeature(building), CLEARANCE_DISTANCE_FT, { units: "feet", steps: 12 });
  if (!expanded) {
    bufferedBuildingCache.set(building.id, null);
    return null;
  }
  const clippedFeatures: Array<Feature<Polygon | MultiPolygon>> = [];
  zoneFeatures.forEach((studyZone) => {
    const clipped = intersect(featureCollection([expanded, studyZone]));
    if (clipped) clippedFeatures.push(clipped);
  });
  if (!clippedFeatures.length) {
    bufferedBuildingCache.set(building.id, null);
    return null;
  }
  const clipped = dissolveFeatures(clippedFeatures);
  const feature = clipped.features[0] || null;
  bufferedBuildingCache.set(building.id, feature);
  return feature;
}

function dissolveFeatures(features: Array<Feature<Polygon | MultiPolygon>>): FeatureCollection<Polygon | MultiPolygon> {
  if (features.length < 2) return featureCollection(features);
  const geometries = features.map((feature) => feature.geometry.coordinates as Geom);
  const coordinates = unionPolygons(geometries[0], ...geometries.slice(1));
  return coordinates.length
    ? featureCollection([multiPolygon(coordinates, { dissolved: true })])
    : featureCollection([]);
}

function ringArea(coordinates: number[][]) {
  if (coordinates.length < 3) return 0;
  let total = 0;
  for (let index = 0; index < coordinates.length; index += 1) {
    const lower = coordinates[(index + coordinates.length - 1) % coordinates.length];
    const middle = coordinates[index];
    const upper = coordinates[(index + 1) % coordinates.length];
    total += ((upper[0] - lower[0]) * Math.PI / 180) * Math.sin(middle[1] * Math.PI / 180);
  }
  return total * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS / 2;
}

function polygonArea(coordinates: number[][][]) {
  if (!coordinates.length) return 0;
  let area = Math.abs(ringArea(coordinates[0]));
  for (let index = 1; index < coordinates.length; index += 1) area -= Math.abs(ringArea(coordinates[index]));
  return Math.max(0, area);
}

function featureArea(feature: Feature<Polygon | MultiPolygon>) {
  return feature.geometry.type === "Polygon"
    ? polygonArea(feature.geometry.coordinates as number[][][])
    : (feature.geometry.coordinates as number[][][][]).reduce((sum, coordinates) => sum + polygonArea(coordinates), 0);
}

function postProgress(requestId: number, value: number, label: string) {
  self.postMessage({ type: "progress", requestId, value, label });
}

function rememberResult(altitudeFt: number, result: ConflictResult) {
  resultCache.delete(altitudeFt);
  resultCache.set(altitudeFt, result);
  while (resultCache.size > RESULT_CACHE_SIZE) {
    const oldest = resultCache.keys().next().value as number | undefined;
    if (oldest == null) break;
    resultCache.delete(oldest);
  }
}

function computeConflicts(requestId: number, altitudeFt: number): ConflictResult {
  const cached = resultCache.get(altitudeFt);
  if (cached) {
    resultCache.delete(altitudeFt);
    resultCache.set(altitudeFt, cached);
    return cached;
  }

  postProgress(requestId, 0.1, "Selecting active surfaces");
  const activeBuildings = buildings.filter((building) => {
    const topElevationFt = buildingTopElevationFt(building);
    return topElevationFt != null && altitudeFt < topElevationFt + 1000;
  });
  const displayBuildings = activeBuildings.length > 500 ? groupDenseBuildings(activeBuildings) : activeBuildings;
  const activeTerrainCells = terrainCells
    .filter((cell) => terrainCellIntersectsBounds(cell) && altitudeFt < cell.elevationFt + 1000);
  const features: Array<Feature<Polygon | MultiPolygon>> = compactTerrainFeatures(activeTerrainCells);

  postProgress(requestId, 0.35, "Preparing building clearance envelopes");
  displayBuildings.forEach((building) => {
    const feature = bufferedConflictFeature(building);
    if (feature) features.push(feature);
  });

  postProgress(requestId, 0.72, "Dissolving overlap into one shade");
  const conflicts = dissolveFeatures(features);
  const areaSquareMeters = conflicts.features.reduce((sum, feature) => sum + featureArea(feature), 0);
  const result = {
    conflicts,
    activeObstacles: activeBuildings.length,
    flaggedSquareMiles: areaSquareMeters / SQUARE_METERS_PER_SQUARE_MILE,
  };
  rememberResult(altitudeFt, result);
  return result;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const startedAt = performance.now();
  try {
    if (message.type === "prepare") {
      buildings = message.buildings;
      terrainCells = message.terrainCells;
      zones = message.zones;
      origin = message.origin;
      renderedBounds = message.renderedBounds;
      zoneFeatures = zones.map(zoneFeature);
      bufferedBuildingCache.clear();
      resultCache.clear();
    }
    const result = computeConflicts(message.requestId, message.altitudeFt);
    self.postMessage({
      type: "result",
      requestId: message.requestId,
      altitudeFt: message.altitudeFt,
      durationMs: Math.round(performance.now() - startedAt),
      ...result,
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Clearance geometry could not be calculated.",
    });
  }
};
