import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  boundsWithinGeographicAreas,
  conservativeLongitudePaddingDegrees,
  decodeTerrariumElevationMeters,
  destinationLngLatByFeet,
  distanceFromLngLatToPolygonFt,
  ESTIMATED_FLOOR_HEIGHT_FT,
  faaUpperBoundAmslFt,
  highestTerrainElevationWithinRadius,
  pointInGeographicAreas,
  shouldRetainOvertureBuildingPart,
} from "../app/clearance-accuracy.ts";

test("uses the requested commercial-floor estimate and known FAA vertical tolerance", () => {
  assert.equal(ESTIMATED_FLOOR_HEIGHT_FT, 14);
  assert.equal(faaUpperBoundAmslFt(2_195, 125), 2_320);
  assert.equal(faaUpperBoundAmslFt(2_195, null), 2_195);
});

test("rejects corrupt opaque-black Terrarium pixels", () => {
  assert.throws(() => decodeTerrariumElevationMeters(0, 0, 0), /outside the Terrarium range/);
  assert.equal(decodeTerrariumElevationMeters(128, 100, 0), 100);
});

test("selects the highest land terrain within 2,000 feet", () => {
  const cells = [
    { west: -0.001, east: 0.001, south: 39.999, north: 40.001, elevationFt: 500 },
    { west: 0.005, east: 0.006, south: 39.999, north: 40.001, elevationFt: 1_500 },
    { west: 0.01, east: 0.011, south: 39.999, north: 40.001, elevationFt: 3_000 },
    { west: 0.002, east: 0.003, south: 39.999, north: 40.001, elevationFt: 4_000, openWater: true },
  ];
  assert.equal(highestTerrainElevationWithinRadius(0, 40, cells, 2_000), 1_500);
});

test("measures building-envelope distance from the selected point instead of the model-area origin", () => {
  for (const [longitude, latitude] of [[-87.6, 42.2], [-150, 69.3]]) {
    const ring = [
      destinationLngLatByFeet(longitude, latitude, 1_990, 100),
      destinationLngLatByFeet(longitude, latitude, 2_090, 100),
      destinationLngLatByFeet(longitude, latitude, 2_090, -100),
      destinationLngLatByFeet(longitude, latitude, 1_990, -100),
    ];
    const distanceFt = distanceFromLngLatToPolygonFt(longitude, latitude, ring);
    assert.ok(Math.abs(distanceFt - 1_990) < 0.05, `${latitude}° distance was ${distanceFt} ft`);
  }
});

test("uses the limiting latitude for a long model-area clearance halo", () => {
  const longAreaPadding = conservativeLongitudePaddingDegrees(65, 70, 2_000);
  const centerOnlyPadding = conservativeLongitudePaddingDegrees(67.5, 67.5, 2_000);
  assert.ok(longAreaPadding > centerOnlyPadding * 1.1);
});

test("can retain every Overture building part when grouping is disabled", () => {
  assert.equal(shouldRetainOvertureBuildingPart(true, true, false, false), false);
  assert.equal(shouldRetainOvertureBuildingPart(false, true, false, false), true);
  assert.equal(shouldRetainOvertureBuildingPart(true, true, true, false), true);
  assert.equal(shouldRetainOvertureBuildingPart(true, false, false, false), true);
});

test("accepts U.S. locations and rejects unsupported locations", async () => {
  const collection = JSON.parse(await readFile(new URL("../public/data/us-state-boundaries-5m.geojson", import.meta.url), "utf8"));
  const areas = collection.features.map((feature) => {
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const coordinates = polygons.flat(2);
    return {
      west: Math.min(...coordinates.map(([longitude]) => longitude)),
      east: Math.max(...coordinates.map(([longitude]) => longitude)),
      south: Math.min(...coordinates.map(([, latitude]) => latitude)),
      north: Math.max(...coordinates.map(([, latitude]) => latitude)),
      polygons,
    };
  });
  assert.equal(pointInGeographicAreas(-87.6324, 41.8819, areas), true);
  assert.equal(pointInGeographicAreas(144.7937, 13.4443, areas), true);
  assert.equal(pointInGeographicAreas(-79.3832, 43.6532, areas), false);
  assert.equal(boundsWithinGeographicAreas({ west: -87.64, east: -87.62, south: 41.87, north: 41.89 }, areas), true);
  assert.equal(boundsWithinGeographicAreas({ west: -79.39, east: -79.37, south: 43.64, north: 43.66 }, areas), false);
});

test("the unsupported-geography mask covers non-U.S. map space", async () => {
  const collection = JSON.parse(await readFile(new URL("../public/data/us-unsupported-mask-5m.geojson", import.meta.url), "utf8"));
  const feature = collection.features[0];
  const coordinates = feature.geometry.coordinates.flat(2);
  const maskArea = {
    west: Math.min(...coordinates.map(([longitude]) => longitude)),
    east: Math.max(...coordinates.map(([longitude]) => longitude)),
    south: Math.min(...coordinates.map(([, latitude]) => latitude)),
    north: Math.max(...coordinates.map(([, latitude]) => latitude)),
    polygons: feature.geometry.coordinates,
  };
  assert.equal(pointInGeographicAreas(-79.3832, 43.6532, [maskArea]), true);
  assert.equal(pointInGeographicAreas(-87.6324, 41.8819, [maskArea]), false);
});

test("the worker buffers terrain from the loaded 2,000-foot halo", async () => {
  const worker = await readFile(new URL("../app/clearance-worker.ts", import.meta.url), "utf8");
  assert.match(worker, /bufferedTerrainConflictFeatures/);
  assert.match(worker, /buffer\(feature, CLEARANCE_DISTANCE_FT/);
  assert.match(worker, /screenedTerrainCells = message\.terrainCells\.filter/);
});
