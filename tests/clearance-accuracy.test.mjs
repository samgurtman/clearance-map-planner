import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  pointInGeographicAreas,
  shouldRetainOvertureBuildingPart,
  unsupportedGeographyCoordinates,
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

test("uses only Overture territorial country and U.S. dependency polygons", () => {
  assert.equal(isSupportedUsTerritorialDivision({ country: "US", subtype: "country", is_territorial: true }), true);
  assert.equal(isSupportedUsTerritorialDivision({ country: "PR", subtype: "dependency", is_territorial: "true" }), true);
  assert.equal(isSupportedUsTerritorialDivision({ country: "US", subtype: "region", is_territorial: true }), false);
  assert.equal(isSupportedUsTerritorialDivision({ country: "US", subtype: "country", is_land: true }), false);
  assert.equal(isSupportedUsTerritorialDivision({ country: "CA", subtype: "country", is_territorial: true }), false);
});

test("builds the gray unsupported mask as the inverse of territorial U.S. geometry", () => {
  const areas = [{
    west: -89,
    east: -86,
    south: 41,
    north: 43,
    polygons: [[[[-89, 43], [-86, 43], [-86, 41], [-89, 41], [-89, 43]]]],
  }];
  assert.equal(pointInGeographicAreas(-87.62, 41.9, areas), true);
  assert.equal(boundsWithinGeographicAreas({ west: -87.65, east: -87.60, south: 41.87, north: 41.92 }, areas), true);
  const unsupported = unsupportedGeographyCoordinates(areas);
  const unsupportedArea = { west: -179.999, east: 179.999, south: -85, north: 85, polygons: unsupported };
  assert.equal(pointInGeographicAreas(-79.3832, 43.6532, [unsupportedArea]), true);
  assert.equal(pointInGeographicAreas(-87.62, 41.9, [unsupportedArea]), false);
});

test("clips a model-area rectangle to the supported U.S. geometry", () => {
  const areas = [{
    west: -89,
    east: -86,
    south: 41,
    north: 43,
    polygons: [[[[-89, 43], [-86, 43], [-86, 41], [-89, 41], [-89, 43]]]],
  }];
  const clipped = boundsIntersectionWithGeographicAreas(
    { west: -90, east: -87, south: 42, north: 44 },
    areas,
  );
  assert.deepEqual(clipped, [[[[-89, 42], [-87, 42], [-87, 43], [-89, 43], [-89, 42]]]]);
  assert.equal(boundsWithinGeographicAreas({ west: -90, east: -87, south: 42, north: 44 }, areas), false);
  assert.deepEqual(boundsIntersectionWithGeographicAreas(
    { west: -95, east: -94, south: 42, north: 43 },
    areas,
  ), []);
});

test("preserves holes while clipping a model area", () => {
  const areas = [{
    west: -90,
    east: -86,
    south: 40,
    north: 44,
    polygons: [[
      [[-90, 44], [-86, 44], [-86, 40], [-90, 40], [-90, 44]],
      [[-89, 43], [-87, 43], [-87, 41], [-89, 41], [-89, 43]],
    ]],
  }];
  const bounds = { west: -89.5, east: -86.5, south: 40.5, north: 43.5 };
  const clippedArea = {
    ...bounds,
    polygons: boundsIntersectionWithGeographicAreas(bounds, areas),
  };
  assert.equal(pointInGeographicAreas(-89.25, 43.25, [clippedArea]), true);
  assert.equal(pointInGeographicAreas(-88, 42, [clippedArea]), false);
});

test("the worker buffers terrain from the loaded 2,000-foot halo", async () => {
  const worker = await readFile(new URL("../app/clearance-worker.ts", import.meta.url), "utf8");
  assert.match(worker, /bufferedTerrainConflictFeatures/);
  assert.match(worker, /buffer\(feature, CLEARANCE_DISTANCE_FT/);
  assert.match(worker, /screenedTerrainCells = message\.terrainCells\.filter/);
});
