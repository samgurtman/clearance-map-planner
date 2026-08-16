import { difference as differencePolygons } from "polyclip-ts";
import type { Geom } from "polyclip-ts";

export const ESTIMATED_FLOOR_HEIGHT_FT = 14;
export const TERRARIUM_MIN_ELEVATION_METERS = -11_000;
export const TERRARIUM_MAX_ELEVATION_METERS = 8_900;

const EARTH_RADIUS_FT = 6_371_008.8 * 3.280839895013123;

function radians(value: number) {
  return value * Math.PI / 180;
}

function degrees(value: number) {
  return value * 180 / Math.PI;
}

function normalizeLongitude(longitude: number) {
  return ((longitude + 540) % 360) - 180;
}

function projectedLngLatFromPointFt(
  pointLongitude: number,
  pointLatitude: number,
  longitude: number,
  latitude: number,
) {
  const pointLatitudeRadians = radians(pointLatitude);
  const latitudeRadians = radians(latitude);
  const longitudeDelta = radians(normalizeLongitude(longitude - pointLongitude));
  const sinLatitudeDelta = Math.sin((latitudeRadians - pointLatitudeRadians) / 2);
  const sinLongitudeDelta = Math.sin(longitudeDelta / 2);
  const haversine = Math.min(1, sinLatitudeDelta * sinLatitudeDelta
    + Math.cos(pointLatitudeRadians) * Math.cos(latitudeRadians) * sinLongitudeDelta * sinLongitudeDelta);
  const angularDistance = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)));
  if (angularDistance <= 1e-14) return { x: 0, y: 0 };
  const bearing = Math.atan2(
    Math.sin(longitudeDelta) * Math.cos(latitudeRadians),
    Math.cos(pointLatitudeRadians) * Math.sin(latitudeRadians)
      - Math.sin(pointLatitudeRadians) * Math.cos(latitudeRadians) * Math.cos(longitudeDelta),
  );
  const distanceFt = angularDistance * EARTH_RADIUS_FT;
  return { x: Math.sin(bearing) * distanceFt, y: Math.cos(bearing) * distanceFt };
}

function distanceFromOriginToSegmentFt(start: { x: number; y: number }, end: { x: number; y: number }) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const squaredLength = dx * dx + dy * dy;
  const interpolation = squaredLength
    ? Math.max(0, Math.min(1, -(start.x * dx + start.y * dy) / squaredLength))
    : 0;
  return Math.hypot(start.x + interpolation * dx, start.y + interpolation * dy);
}

function originInProjectedRing(ring: Array<{ x: number; y: number }>) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous];
    const end = ring[index];
    if (distanceFromOriginToSegmentFt(start, end) <= 1e-6) return true;
    const crosses = (end.y > 0) !== (start.y > 0)
      && 0 < ((start.x - end.x) * -end.y) / (start.y - end.y || 1) + end.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function distanceFromLngLatToPolygonFt(
  longitude: number,
  latitude: number,
  ring: number[][],
) {
  if (ring.length < 3) return Number.POSITIVE_INFINITY;
  const projectedRing = ring.map(([ringLongitude, ringLatitude]) => (
    projectedLngLatFromPointFt(longitude, latitude, ringLongitude, ringLatitude)
  ));
  if (originInProjectedRing(projectedRing)) return 0;
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < projectedRing.length; index += 1) {
    shortest = Math.min(shortest, distanceFromOriginToSegmentFt(
      projectedRing[index],
      projectedRing[(index + 1) % projectedRing.length],
    ));
  }
  return shortest;
}

export function destinationLngLatByFeet(
  longitude: number,
  latitude: number,
  eastFt: number,
  northFt: number,
): [number, number] {
  const distanceFt = Math.hypot(eastFt, northFt);
  if (distanceFt <= 1e-9) return [longitude, latitude];
  const angularDistance = distanceFt / EARTH_RADIUS_FT;
  const bearing = Math.atan2(eastFt, northFt);
  const latitudeRadians = radians(latitude);
  const longitudeRadians = radians(longitude);
  const destinationLatitude = Math.asin(
    Math.sin(latitudeRadians) * Math.cos(angularDistance)
      + Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const destinationLongitude = longitudeRadians + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
    Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(destinationLatitude),
  );
  return [normalizeLongitude(degrees(destinationLongitude)), degrees(destinationLatitude)];
}

export function conservativeLongitudePaddingDegrees(south: number, north: number, distanceFt: number) {
  const limitingLatitude = Math.max(Math.abs(south), Math.abs(north));
  const feetPerDegree = EARTH_RADIUS_FT * Math.cos(radians(limitingLatitude)) * Math.PI / 180;
  return distanceFt / Math.max(1, feetPerDegree);
}

export function decodeTerrariumElevationMeters(red: number, green: number, blue: number) {
  const elevationMeters = (red * 256 + green + blue / 256) - 32768;
  if (elevationMeters < TERRARIUM_MIN_ELEVATION_METERS || elevationMeters > TERRARIUM_MAX_ELEVATION_METERS) {
    throw new Error(`Terrain tile contains an elevation outside the Terrarium range: ${elevationMeters.toFixed(2)} m.`);
  }
  return elevationMeters;
}

export function faaUpperBoundAmslFt(publishedAmslFt: number, knownVerticalToleranceFt: number | null) {
  return publishedAmslFt + (knownVerticalToleranceFt ?? 0);
}

export function shouldRetainOvertureBuildingPart(
  groupBuildingParts: boolean,
  hasLoadedParent: boolean,
  addsHeight: boolean,
  extendsOutsideParent: boolean,
) {
  return !groupBuildingParts || !hasLoadedParent || addsHeight || extendsOutsideParent;
}

export type TerrainCellLike = {
  west: number;
  east: number;
  south: number;
  north: number;
  elevationFt: number;
  openWater?: boolean;
};

export function distanceFromLngLatToCellFt(longitude: number, latitude: number, cell: TerrainCellLike) {
  const nearestLongitude = Math.max(cell.west, Math.min(cell.east, longitude));
  const nearestLatitude = Math.max(cell.south, Math.min(cell.north, latitude));
  const offset = projectedLngLatFromPointFt(
    longitude,
    latitude,
    nearestLongitude,
    nearestLatitude,
  );
  return Math.hypot(offset.x, offset.y);
}

export function highestTerrainElevationWithinRadius(
  longitude: number,
  latitude: number,
  cells: Iterable<TerrainCellLike>,
  radiusFt: number,
) {
  let highest: number | null = null;
  for (const cell of cells) {
    if (cell.openWater || distanceFromLngLatToCellFt(longitude, latitude, cell) > radiusFt) continue;
    highest = highest == null ? cell.elevationFt : Math.max(highest, cell.elevationFt);
  }
  return highest;
}

export type GeographicArea = {
  west: number;
  east: number;
  south: number;
  north: number;
  polygons: number[][][][];
};

const SUPPORTED_US_DIVISION_CODES = new Set(["US", "AS", "GU", "MP", "PR", "UM", "VI"]);

export function isSupportedUsTerritorialDivision(properties: Record<string, unknown>) {
  const country = String(properties.country || "").trim().toUpperCase();
  const subtype = String(properties.subtype || "").trim().toLowerCase();
  const territorial = properties.is_territorial === true
    || properties.is_territorial === "true"
    || properties.is_territorial === 1;
  return territorial
    && SUPPORTED_US_DIVISION_CODES.has(country)
    && (subtype === "country" || subtype === "dependency");
}

export function unsupportedGeographyCoordinates(areas: GeographicArea[]) {
  const world: Geom = [[
    [-179.999, 85],
    [179.999, 85],
    [179.999, -85],
    [-179.999, -85],
    [-179.999, 85],
  ]];
  if (!areas.length) return [world];
  return differencePolygons(world, ...areas.map((area) => area.polygons as Geom));
}

function pointOnCoordinateSegment(longitude: number, latitude: number, start: number[], end: number[]) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const squaredLength = dx * dx + dy * dy;
  if (squaredLength <= 1e-20) return Math.abs(longitude - start[0]) <= 1e-10 && Math.abs(latitude - start[1]) <= 1e-10;
  const cross = (longitude - start[0]) * dy - (latitude - start[1]) * dx;
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (longitude - start[0]) * dx + (latitude - start[1]) * dy;
  return dot >= -1e-10 && dot <= squaredLength + 1e-10;
}

function pointInCoordinateRing(longitude: number, latitude: number, ring: number[][]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous];
    const end = ring[index];
    if (pointOnCoordinateSegment(longitude, latitude, start, end)) return true;
    const crosses = (end[1] > latitude) !== (start[1] > latitude)
      && longitude < ((start[0] - end[0]) * (latitude - end[1])) / (start[1] - end[1] || 1) + end[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInGeographicArea(longitude: number, latitude: number, area: GeographicArea) {
  if (longitude < area.west || longitude > area.east || latitude < area.south || latitude > area.north) return false;
  return area.polygons.some((rings) => {
    if (!rings.length || !pointInCoordinateRing(longitude, latitude, rings[0])) return false;
    return !rings.slice(1).some((hole) => pointInCoordinateRing(longitude, latitude, hole));
  });
}

export function pointInGeographicAreas(longitude: number, latitude: number, areas: GeographicArea[]) {
  return areas.some((area) => pointInGeographicArea(longitude, latitude, area));
}

export function boundsWithinGeographicAreas(
  bounds: { west: number; east: number; south: number; north: number },
  areas: GeographicArea[],
) {
  if (!areas.length || bounds.west >= bounds.east || bounds.south >= bounds.north) return false;
  const candidates = areas.filter((area) => area.west <= bounds.east
    && area.east >= bounds.west
    && area.south <= bounds.north
    && area.north >= bounds.south);
  if (!candidates.length) return false;
  const selection: Geom = [[
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
    [bounds.west, bounds.north],
  ]];
  const uncovered = differencePolygons(selection, ...candidates.map((area) => area.polygons as Geom));
  return uncovered.length === 0;
}
