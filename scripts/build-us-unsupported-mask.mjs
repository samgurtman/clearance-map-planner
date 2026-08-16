import { readFile, writeFile } from "node:fs/promises";
import { difference, union } from "polyclip-ts";

const sourceUrl = new URL("../public/data/us-state-boundaries-5m.geojson", import.meta.url);
const outputUrl = new URL("../public/data/us-unsupported-mask-5m.geojson", import.meta.url);
const collection = JSON.parse(await readFile(sourceUrl, "utf8"));
const supportedPolygons = collection.features.flatMap((feature) => {
  if (feature.geometry?.type === "Polygon") return [feature.geometry.coordinates];
  if (feature.geometry?.type === "MultiPolygon") return feature.geometry.coordinates;
  return [];
});

if (!supportedPolygons.length) throw new Error("The U.S. boundary source contains no polygon geometry.");

const supportedGeometry = union(...supportedPolygons);
const worldGeometry = [[[
  [-179.999, 85],
  [179.999, 85],
  [179.999, -85],
  [-179.999, -85],
  [-179.999, 85],
]]];
const unsupportedGeometry = difference(worldGeometry, supportedGeometry);
const mask = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { classification: "outside-supported-us-boundary" },
    geometry: { type: "MultiPolygon", coordinates: unsupportedGeometry },
  }],
};

await writeFile(outputUrl, `${JSON.stringify(mask)}\n`);
console.log(`Wrote ${outputUrl.pathname}`);
