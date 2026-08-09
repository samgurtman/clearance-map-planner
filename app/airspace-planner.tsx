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
  state: "conflict" | "clear" | "outside";
  zone?: Zone;
  obstacle?: Building;
  requiredFt?: number;
  marginFt?: number;
  envelopeDistanceFt?: number;
};
type ImportedDataset = { buildings: Building[]; origin: Origin; note: string };

const CHICAGO_ORIGIN: Origin = { lat: 41.8819, lon: -87.6324 };
const FEET_PER_LAT_DEGREE = 364_000;
const feetPerLonDegree = (latitude: number) => 364_000 * Math.cos((latitude * Math.PI) / 180);

const SAMPLE_ZONES: Zone[] = [
  {
    id: "loop",
    label: "Loop / Near South Side",
    source: "Sample planning polygon",
    points: [
      { x: -3600, y: -2650 }, { x: 2700, y: -2700 }, { x: 3300, y: -250 },
      { x: 2450, y: 2850 }, { x: -3300, y: 2800 }, { x: -4050, y: 250 },
    ],
  },
  {
    id: "river-north",
    label: "River North",
    source: "Sample planning polygon",
    points: [
      { x: -3450, y: -4300 }, { x: 2500, y: -4300 },
      { x: 2750, y: -2850 }, { x: -3600, y: -2700 },
    ],
  },
  {
    id: "west-loop",
    label: "West Loop",
    source: "Sample planning polygon",
    points: [
      { x: -6150, y: -2300 }, { x: -3700, y: -2250 },
      { x: -3250, y: 2300 }, { x: -6100, y: 2450 },
    ],
  },
];

function seeded(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function rectangleEnvelope(x: number, y: number, width: number, depth: number): Point[] {
  return [
    { x: x - width / 2, y: y - depth / 2 },
    { x: x + width / 2, y: y - depth / 2 },
    { x: x + width / 2, y: y + depth / 2 },
    { x: x - width / 2, y: y + depth / 2 },
  ];
}

function sampleBuilding(
  id: string,
  name: string,
  x: number,
  y: number,
  width: number,
  depth: number,
  heightFt: number,
): Building {
  return { id, name, x, y, envelopes: [rectangleEnvelope(x, y, width, depth)], heightFt, heightSource: "Sample height" };
}

function makeSampleBuildings(): Building[] {
  const buildings: Building[] = [];
  let index = 0;
  for (let gx = -7; gx <= 4; gx += 1) {
    for (let gy = -5; gy <= 4; gy += 1) {
      const blockX = gx * 720;
      const blockY = gy * 720;
      const distance = Math.hypot(blockX + 200, blockY + 300);
      const downtownFactor = Math.max(0, 1 - distance / 5600);
      const slots = seeded(index + 14) > 0.32 ? 4 : 3;
      for (let slot = 0; slot < slots; slot += 1) {
        const col = slot % 2;
        const row = Math.floor(slot / 2);
        const jitter = seeded(index * 8 + slot + 2);
        const x = blockX + (col ? 155 : -145) + (jitter - 0.5) * 55;
        const y = blockY + (row ? 150 : -150) + (seeded(index + slot + 80) - 0.5) * 55;
        const width = 150 + seeded(index + slot + 33) * 145;
        const depth = 130 + seeded(index + slot + 91) * 150;
        const heightFt = Math.round(45 + downtownFactor * downtownFactor * (170 + seeded(index + slot + 55) * 640));
        buildings.push(sampleBuilding(`b-${index}-${slot}`, `Building ${index + 1}${String.fromCharCode(65 + slot)}`, x, y, width, depth, heightFt));
      }
      index += 1;
    }
  }
  buildings.push(
    sampleBuilding("willis", "Willis Tower", -970, 690, 330, 280, 1451),
    sampleBuilding("aon", "Aon Center", 890, -410, 270, 260, 1136),
    sampleBuilding("trump", "Trump International", 390, -1390, 240, 230, 1170),
    sampleBuilding("hancock", "875 N Michigan", 1480, -3380, 290, 290, 1128),
  );
  return buildings;
}

const SAMPLE_BUILDINGS = makeSampleBuildings();

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
  const nearby = buildings
    .map((building) => ({ building, distance: distanceToBuilding(value, building) }))
    .filter((entry) => entry.distance <= 2000)
    .sort((a, b) => b.building.heightFt - a.building.heightFt);
  const highest = nearby[0];
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
  const step = 300;
  let flagged = 0;
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += step) {
      if (evaluatePoint({ x, y }, altitudeFt, buildings, zones).state === "conflict") flagged += 1;
    }
  }
  return (flagged * step * step) / 27_878_400;
}

const emptyFeatures = (): FeatureCollection => featureCollection([]);

export function AirspacePlanner() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const liveDataRef = useRef({ altitudeFt: 1800, buildings: SAMPLE_BUILDINGS, zones: SAMPLE_ZONES, origin: CHICAGO_ORIGIN });
  const [altitudeFt, setAltitudeFt] = useState(1800);
  const [buildings, setBuildings] = useState<Building[]>(SAMPLE_BUILDINGS);
  const [zones, setZones] = useState<Zone[]>(SAMPLE_ZONES);
  const [origin, setOrigin] = useState<Origin>(CHICAGO_ORIGIN);
  const [datasetName, setDatasetName] = useState("Downtown Chicago · sample");
  const [dataNote, setDataNote] = useState(`${SAMPLE_BUILDINGS.length} envelope records · 3 study polygons`);
  const [selected, setSelected] = useState<Point>({ x: 80, y: 160 });
  const [importError, setImportError] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [basemapError, setBasemapError] = useState(false);

  liveDataRef.current = { altitudeFt, buildings, zones, origin };

  const check = useMemo(() => evaluatePoint(selected, altitudeFt, buildings, zones), [selected, altitudeFt, buildings, zones]);
  const activeObstacles = useMemo(() => buildings.filter((building) => altitudeFt < building.heightFt + 1000).length, [altitudeFt, buildings]);
  const flaggedSquareMiles = useMemo(() => estimateFlaggedSquareMiles(altitudeFt, buildings, zones), [altitudeFt, buildings, zones]);
  const buildingsGeoJson = useMemo(() => featureCollection(buildings.map((building) => buildingFeature(building, origin))), [buildings, origin]);
  const zonesGeoJson = useMemo(() => featureCollection(zones.map((zone) => zoneFeature(zone, origin))), [zones, origin]);
  const selectedGeoJson = useMemo(() => featureCollection([point(localToLngLat(selected, origin), { state: check.state })]), [selected, origin, check.state]);
  const conflictsGeoJson = useMemo(() => {
    if (altitudeFt < 1000) return featureCollection(zones.map((zone) => zoneFeature(zone, origin)));
    const features: Array<Feature<Polygon | MultiPolygon>> = [];
    buildings.forEach((building) => {
      if (altitudeFt >= building.heightFt + 1000) return;
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
  }, [altitudeFt, buildings, zones, origin]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    let disposed = false;
    import("maplibre-gl").then(({ default: maplibregl }) => {
      if (disposed || !mapContainerRef.current) return;
      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: "https://tiles.openfreemap.org/styles/positron",
        center: [CHICAGO_ORIGIN.lon, CHICAGO_ORIGIN.lat],
        zoom: 14.2,
        pitch: 0,
        bearing: 0,
        attributionControl: true,
      });
      mapRef.current = map;
      map.on("load", () => {
        const beforeId = map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
        map.addSource("clearance-zones", { type: "geojson", data: emptyFeatures() });
        map.addSource("clearance-conflicts", { type: "geojson", data: emptyFeatures() });
        map.addSource("clearance-buildings", { type: "geojson", data: emptyFeatures() });
        map.addSource("clearance-selected", { type: "geojson", data: emptyFeatures() });
        map.addLayer({ id: "clearance-zone-fill", type: "fill", source: "clearance-zones", paint: { "fill-color": "#c08a2c", "fill-opacity": 0.07 } }, beforeId);
        map.addLayer({ id: "clearance-zone-line", type: "line", source: "clearance-zones", paint: { "line-color": "#8f6b28", "line-width": 1.25, "line-dasharray": [3, 2] } }, beforeId);
        map.addLayer({ id: "clearance-conflict-fill", type: "fill", source: "clearance-conflicts", paint: { "fill-color": "#df3d33", "fill-opacity": 0.25 } }, beforeId);
        map.addLayer({ id: "clearance-conflict-line", type: "line", source: "clearance-conflicts", paint: { "line-color": "#bd3028", "line-width": 1 } }, beforeId);
        map.addLayer({ id: "clearance-building-fill", type: "fill", source: "clearance-buildings", paint: { "fill-color": ["step", ["get", "heightFt"], "#89908e", 350, "#4e585c", 800, "#182229"], "fill-opacity": 0.9 } }, beforeId);
        map.addLayer({ id: "clearance-building-line", type: "line", source: "clearance-buildings", paint: { "line-color": "#ffffff", "line-width": 0.65, "line-opacity": 0.72 } }, beforeId);
        map.addLayer({ id: "clearance-selected-outer", type: "circle", source: "clearance-selected", paint: { "circle-radius": 10, "circle-color": "#fffdf7", "circle-stroke-width": 4, "circle-stroke-color": ["match", ["get", "state"], "conflict", "#d82f29", "clear", "#176b59", "#182229"] } });
        map.addLayer({ id: "clearance-selected-inner", type: "circle", source: "clearance-selected", paint: { "circle-radius": 3, "circle-color": ["match", ["get", "state"], "conflict", "#d82f29", "clear", "#176b59", "#182229"] } });
        setMapReady(true);
      });
      map.on("click", (event) => {
        const current = liveDataRef.current;
        setSelected(lngLatToLocal(event.lngLat.lng, event.lngLat.lat, current.origin));
      });
      map.on("error", () => {
        if (!map.loaded()) setBasemapError(true);
      });
    });
    return () => {
      disposed = true;
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
  }, [mapReady, zonesGeoJson, conflictsGeoJson, buildingsGeoJson, selectedGeoJson]);

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportError("");
    try {
      const text = await file.text();
      const imported = file.name.toLowerCase().endsWith(".csv") ? parseCsv(text) : parseGeoJson(text);
      if (!imported.buildings.length) throw new Error("No usable building records were found.");
      setBuildings(imported.buildings);
      setOrigin(imported.origin);
      setZones([makeConservativeZone(imported.buildings, "Imported conservative study area")]);
      setDatasetName(file.name);
      setDataNote(`${imported.buildings.length.toLocaleString()} buildings · ${imported.note}`);
      setSelected({ x: 0, y: 0 });
      mapRef.current?.flyTo({ center: [imported.origin.lon, imported.origin.lat], zoom: 15, essential: true });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "This file could not be read.");
    } finally {
      event.target.value = "";
    }
  }

  function resetSample() {
    setBuildings(SAMPLE_BUILDINGS);
    setOrigin(CHICAGO_ORIGIN);
    setZones(SAMPLE_ZONES);
    setDatasetName("Downtown Chicago · sample");
    setDataNote(`${SAMPLE_BUILDINGS.length} envelope records · 3 study polygons`);
    setSelected({ x: 80, y: 160 });
    setImportError("");
    mapRef.current?.flyTo({ center: [CHICAGO_ORIGIN.lon, CHICAGO_ORIGIN.lat], zoom: 14.2, essential: true });
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

  const statusTitle = check.state === "conflict" ? "Modeled clearance not met" : check.state === "clear" ? "Modeled clearance met" : "Outside study polygons";

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={resetSample} aria-label="Clearance home and reset sample"><span className="brand-mark" aria-hidden="true"><i /></span><span>CLEARANCE</span></button>
        <div className="rule-chip"><span>RULESET</span> FAA §91.119(b)</div>
        <div className="topbar-actions">
          <button className="data-source" onClick={() => inputRef.current?.click()}><span className="status-dot" /><span><small>ACTIVE DATASET</small>{datasetName}</span></button>
          <button className="import-button" onClick={() => inputRef.current?.click()}><span aria-hidden="true">↥</span> Import data</button>
          <button className="icon-button" onClick={() => setInfoOpen(true)} aria-label="About this planning aid">?</button>
          <input ref={inputRef} className="visually-hidden" type="file" accept=".csv,.geojson,.json,application/geo+json,text/csv" onChange={handleImport} />
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <div className="eyebrow-row"><span className="eyebrow">FLIGHT ALTITUDE</span><span className="live-label"><i /> ENVELOPE MODEL</span></div>
          <div className="altitude-readout"><strong>{altitudeFt.toLocaleString()}</strong><span>FT<br />AGL</span></div>
          <label className="slider-wrap"><span className="visually-hidden">Flight altitude in feet above ground level</span><input type="range" min="500" max="3000" step="50" value={altitudeFt} onChange={(event) => setAltitudeFt(Number(event.target.value))} /><span className="range-labels"><b>500</b><b>3,000 FT</b></span></label>
          <div className="preset-row" aria-label="Altitude presets">{[1000, 1500, 2000, 2500].map((preset) => <button key={preset} className={altitudeFt === preset ? "active" : ""} onClick={() => setAltitudeFt(preset)}>{preset.toLocaleString()}</button>)}</div>

          <div className="rule-block">
            <div className="rule-heading"><span className="rule-number">§</span><span><small>MODELED STANDARD</small>91.119(b) clearance</span></div>
            <div className="rule-metrics"><div><strong>1,000</strong><span>FT ABOVE</span></div><i /><div><strong>2,000</strong><span>FT FROM ENVELOPE</span></div></div>
            <p>The horizontal distance is measured from the nearest point on each complete building footprint—not its center.</p>
          </div>

          <div className={`point-check ${check.state}`} aria-live="polite">
            <div className="point-check-title"><span className="check-symbol">{check.state === "conflict" ? "!" : check.state === "clear" ? "✓" : "·"}</span><span><small>SELECTED POINT</small>{statusTitle}</span></div>
            {check.state !== "outside" ? <dl>
              <div><dt>Required altitude</dt><dd>{check.requiredFt?.toLocaleString()} ft</dd></div>
              <div><dt>{(check.marginFt ?? 0) < 0 ? "Shortfall" : "Margin"}</dt><dd>{Math.abs(check.marginFt ?? 0).toLocaleString()} ft</dd></div>
              <div><dt>Highest within 2,000 ft</dt><dd>{check.obstacle?.name ?? "Ground baseline"}</dd></div>
              {check.obstacle && <div><dt>Distance to envelope</dt><dd>{Math.round(check.envelopeDistanceFt ?? 0).toLocaleString()} ft</dd></div>}
            </dl> : <p>Click inside a dashed amber study polygon to run the clearance screen.</p>}
          </div>

          <div className="screen-summary"><span><small>RED AREA</small><strong>{flaggedSquareMiles.toFixed(2)} mi²</strong></span><span><small>ACTIVE OBSTACLES</small><strong>{activeObstacles}</strong></span></div>

          <a className="national-source" href="https://docs.overturemaps.org/guides/buildings/" target="_blank" rel="noreferrer">
            <span className="source-kicker">NATIONWIDE BUILDING SOURCE</span>
            <strong>Overture Maps Buildings <b>↗</b></strong>
            <span>Polygon/MultiPolygon footprints · height in meters · building parts</span>
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
          <div className="map-titlebar"><div><span className="location-pin" aria-hidden="true" /><strong>{datasetName}</strong><small>{origin.lat.toFixed(4)}° N, {Math.abs(origin.lon).toFixed(4)}° W</small></div><span className="map-mode">2D · AGL</span></div>
          <div className="map-controls" aria-label="Map zoom controls">
            <button onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in">＋</button>
            <button onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out">−</button>
            <button onClick={() => mapRef.current?.flyTo({ center: [origin.lon, origin.lat], zoom: 14.2, essential: true })} aria-label="Reset map view">◎</button>
          </div>
          <div className="legend" aria-label="Map legend"><span><i className="legend-red" />Envelope conflict</span><span><i className="legend-amber" />Study polygon</span><span><i className="legend-building" />Building envelope</span></div>
          <div className="dataset-card"><span className="dataset-icon" aria-hidden="true">▤</span><span><small>BUILDING ENVELOPES</small><strong>{datasetName}</strong><em>{dataNote}</em></span><button onClick={() => inputRef.current?.click()}>Replace</button></div>
          <div className="basemap-badge">BASEMAP · OPENFREEMAP / OPENSTREETMAP</div>
        </section>
      </section>

      <footer className="legal-bar"><span><b>PLANNING AID ONLY</b> This screen does not determine whether a flight is legal or authorized.</span><button onClick={() => setInfoOpen(true)}>Read limitations</button></footer>
      {importError && <div className="toast error" role="alert"><span>!</span>{importError}<button onClick={() => setImportError("")} aria-label="Dismiss error">×</button></div>}

      {infoOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setInfoOpen(false)}>
        <section className="info-modal" role="dialog" aria-modal="true" aria-labelledby="limitations-title" onMouseDown={(event) => event.stopPropagation()}>
          <button className="modal-close" onClick={() => setInfoOpen(false)} aria-label="Close">×</button>
          <span className="modal-kicker">MODEL NOTES</span>
          <h2 id="limitations-title">Full envelopes, with important limits.</h2>
          <p>GeoJSON Polygon and MultiPolygon outer footprints are preserved. The red geometry begins at the closest footprint edge, buffers it by 2,000 feet, and compares the selected altitude with the building height plus 1,000 feet.</p>
          <p>The FAA evaluates whether an area is “congested” case by case. Imported buildings are therefore placed in a conservative study polygon—not labeled as an official FAA boundary.</p>
          <div className="modal-warning"><b>Small UAS note</b><span>Part 107 generally uses a different 400-foot AGL framework and may require airspace authorization. This prototype models the Part 91 rule named above.</span></div>
          <div className="source-detail">
            <h3>Recommended national source: Overture Maps</h3>
            <p>Overture Buildings provides nationwide Polygon/MultiPolygon footprints, building parts, and height in meters when available. Download a bounding-box extract and import GeoJSON here. A national deployment should convert the cloud-hosted GeoParquet into regional vector tiles rather than sending the full dataset to a browser.</p>
            <a href="https://docs.overturemaps.org/guides/buildings/" target="_blank" rel="noreferrer">Open Overture Buildings guide ↗</a>
          </div>
          <div className="file-help"><h3>Bring your own height data</h3><p>GeoJSON: use <code>height_ft</code>, Overture <code>height</code> (meters), <code>height_m</code>, <code>num_floors</code>, or <code>building:levels</code>. CSV: include <code>lat, lon, height_ft, width_ft, depth_ft</code>.</p><button onClick={downloadTemplate}>Download CSV template</button></div>
          <div className="modal-links"><a href="https://www.faa.gov/about/office_org/headquarters_offices/agc/practice_areas/regulations/interpretations/Data/interps/2009/Anderson_2009_Legal_Interpretation.pdf" target="_blank" rel="noreferrer">FAA Anderson interpretation ↗</a><a href="https://openfreemap.org/quick_start/" target="_blank" rel="noreferrer">Basemap source ↗</a></div>
        </section>
      </div>}
    </main>
  );
}
