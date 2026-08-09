"use client";

import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Point = { x: number; y: number };
type Building = Point & {
  id: string;
  name: string;
  width: number;
  depth: number;
  heightFt: number;
};
type Zone = { id: string; label: string; points: Point[]; source: string };
type View = { x: number; y: number; scale: number };
type Check = {
  state: "conflict" | "clear" | "outside";
  zone?: Zone;
  obstacle?: Building;
  requiredFt?: number;
  marginFt?: number;
};

const CHICAGO_ORIGIN = { lat: 41.8819, lon: -87.6324 };
const FEET_PER_LAT_DEGREE = 364_000;
const FEET_PER_LON_DEGREE = 271_000;

const SAMPLE_ZONES: Zone[] = [
  {
    id: "loop",
    label: "Loop / Near South Side",
    source: "Sample planning polygon",
    points: [
      { x: -3600, y: -2650 },
      { x: 2700, y: -2700 },
      { x: 3300, y: -250 },
      { x: 2450, y: 2850 },
      { x: -3300, y: 2800 },
      { x: -4050, y: 250 },
    ],
  },
  {
    id: "river-north",
    label: "River North",
    source: "Sample planning polygon",
    points: [
      { x: -3450, y: -4300 },
      { x: 2500, y: -4300 },
      { x: 2750, y: -2850 },
      { x: -3600, y: -2700 },
    ],
  },
  {
    id: "west-loop",
    label: "West Loop",
    source: "Sample planning polygon",
    points: [
      { x: -6150, y: -2300 },
      { x: -3700, y: -2250 },
      { x: -3250, y: 2300 },
      { x: -6100, y: 2450 },
    ],
  },
];

function seeded(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
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
      const density = seeded(index + 14);
      const slots = density > 0.32 ? 4 : 3;
      for (let slot = 0; slot < slots; slot += 1) {
        const col = slot % 2;
        const row = Math.floor(slot / 2);
        const jitter = seeded(index * 8 + slot + 2);
        buildings.push({
          id: `b-${index}-${slot}`,
          name: `Building ${index + 1}${String.fromCharCode(65 + slot)}`,
          x: blockX + (col ? 155 : -145) + (jitter - 0.5) * 55,
          y: blockY + (row ? 150 : -150) + (seeded(index + slot + 80) - 0.5) * 55,
          width: 150 + seeded(index + slot + 33) * 145,
          depth: 130 + seeded(index + slot + 91) * 150,
          heightFt: Math.round(
            45 + downtownFactor * downtownFactor * (170 + seeded(index + slot + 55) * 640),
          ),
        });
      }
      index += 1;
    }
  }
  buildings.push(
    { id: "willis", name: "Willis Tower", x: -970, y: 690, width: 330, depth: 280, heightFt: 1451 },
    { id: "aon", name: "Aon Center", x: 890, y: -410, width: 270, depth: 260, heightFt: 1136 },
    { id: "trump", name: "Trump International", x: 390, y: -1390, width: 240, depth: 230, heightFt: 1170 },
    { id: "hancock", name: "875 N Michigan", x: 1480, y: -3380, width: 290, depth: 290, heightFt: 1128 },
  );
  return buildings;
}

const SAMPLE_BUILDINGS = makeSampleBuildings();

function pointInPolygon(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function evaluatePoint(
  point: Point,
  altitudeFt: number,
  buildings: Building[],
  zones: Zone[],
): Check {
  const zone = zones.find((candidate) => pointInPolygon(point, candidate.points));
  if (!zone) return { state: "outside" };
  const nearby = buildings
    .filter((building) => Math.hypot(building.x - point.x, building.y - point.y) <= 2000)
    .sort((a, b) => b.heightFt - a.heightFt);
  const obstacle = nearby[0];
  const requiredFt = Math.max(1000, (obstacle?.heightFt ?? 0) + 1000);
  const marginFt = altitudeFt - requiredFt;
  return {
    state: marginFt >= 0 ? "clear" : "conflict",
    zone,
    obstacle,
    requiredFt,
    marginFt,
  };
}

function polygonPath(context: CanvasRenderingContext2D, points: Point[], project: (point: Point) => Point) {
  if (!points.length) return;
  const first = project(points[0]);
  context.beginPath();
  context.moveTo(first.x, first.y);
  points.slice(1).forEach((point) => {
    const screen = project(point);
    context.lineTo(screen.x, screen.y);
  });
  context.closePath();
}

function drawMap(
  canvas: HTMLCanvasElement,
  view: View,
  altitudeFt: number,
  buildings: Building[],
  zones: Zone[],
  selected: Point,
) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(rect.width * ratio) || canvas.height !== Math.round(rect.height * ratio)) {
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const project = (point: Point) => ({
    x: width / 2 + (point.x - view.x) * view.scale,
    y: height / 2 + (point.y - view.y) * view.scale,
  });

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#e9e7df";
  context.fillRect(0, 0, width, height);

  // Fine-grain city blocks and streets.
  context.lineCap = "round";
  for (let value = -9000; value <= 9000; value += 360) {
    const startV = project({ x: value, y: -9000 });
    const endV = project({ x: value, y: 9000 });
    context.beginPath();
    context.moveTo(startV.x, startV.y);
    context.lineTo(endV.x, endV.y);
    context.strokeStyle = value % 720 === 0 ? "#faf8f2" : "rgba(255,255,255,.58)";
    context.lineWidth = value % 720 === 0 ? 15 : 5;
    context.stroke();
    const startH = project({ x: -9000, y: value });
    const endH = project({ x: 9000, y: value });
    context.beginPath();
    context.moveTo(startH.x, startH.y);
    context.lineTo(endH.x, endH.y);
    context.stroke();
  }

  // River.
  const river = [
    { x: -7200, y: -1050 },
    { x: -4700, y: -1120 },
    { x: -2450, y: -980 },
    { x: -780, y: -1170 },
    { x: 700, y: -1200 },
    { x: 2500, y: -980 },
    { x: 6400, y: -1040 },
  ];
  context.beginPath();
  river.forEach((point, idx) => {
    const screen = project(point);
    if (idx === 0) context.moveTo(screen.x, screen.y);
    else context.lineTo(screen.x, screen.y);
  });
  context.strokeStyle = "#c8d9d9";
  context.lineWidth = Math.max(18, 290 * view.scale);
  context.stroke();
  context.strokeStyle = "rgba(255,255,255,.75)";
  context.lineWidth = 1;
  context.stroke();

  // Congested planning polygons.
  zones.forEach((zone) => {
    polygonPath(context, zone.points, project);
    context.fillStyle = "rgba(220, 174, 64, .075)";
    context.fill();
    context.setLineDash([8, 7]);
    context.strokeStyle = "rgba(117, 91, 27, .42)";
    context.lineWidth = 1.2;
    context.stroke();
    context.setLineDash([]);
  });

  // Buildings.
  buildings.forEach((building) => {
    const screen = project(building);
    const buildingWidth = Math.max(2.5, building.width * view.scale);
    const buildingDepth = Math.max(2.5, building.depth * view.scale);
    const isTall = building.heightFt >= 800;
    context.fillStyle = isTall ? "#1f292f" : building.heightFt > 350 ? "#566064" : "#9ba09d";
    context.fillRect(
      screen.x - buildingWidth / 2,
      screen.y - buildingDepth / 2,
      buildingWidth,
      buildingDepth,
    );
    if (view.scale > 0.13 && isTall) {
      context.font = "600 10px Arial, sans-serif";
      context.fillStyle = "#273036";
      context.fillText(building.name, screen.x + buildingWidth / 2 + 5, screen.y + 3);
    }
  });

  // 91.119(b) modeled conflict overlay: 2,000 ft buffers clipped to congested polygons.
  context.save();
  context.beginPath();
  zones.forEach((zone) => {
    const first = project(zone.points[0]);
    context.moveTo(first.x, first.y);
    zone.points.slice(1).forEach((point) => {
      const screen = project(point);
      context.lineTo(screen.x, screen.y);
    });
    context.closePath();
  });
  context.clip();
  if (altitudeFt < 1000) {
    context.fillStyle = "rgba(222, 49, 43, .40)";
    context.fillRect(0, 0, width, height);
  } else {
    buildings.forEach((building) => {
      if (altitudeFt >= building.heightFt + 1000) return;
      const screen = project(building);
      context.beginPath();
      context.arc(screen.x, screen.y, 2000 * view.scale, 0, Math.PI * 2);
      context.fillStyle = "rgba(226, 59, 49, .11)";
      context.fill();
    });
  }
  context.restore();

  // Outline active clearance-causing obstacles.
  buildings.forEach((building) => {
    if (altitudeFt >= building.heightFt + 1000) return;
    const screen = project(building);
    context.beginPath();
    context.arc(screen.x, screen.y, Math.max(3, 5 * view.scale), 0, Math.PI * 2);
    context.strokeStyle = "rgba(186, 34, 28, .8)";
    context.lineWidth = 1.5;
    context.stroke();
  });

  // City labels.
  if (view.scale > 0.075) {
    const labels = [
      { text: "WEST LOOP", x: -5000, y: 200 },
      { text: "THE LOOP", x: -900, y: 2050 },
      { text: "RIVER NORTH", x: -1200, y: -3550 },
      { text: "GRANT PARK", x: 3900, y: 1500 },
    ];
    context.font = "700 10px Arial, sans-serif";
    context.fillStyle = "rgba(32, 40, 44, .48)";
    labels.forEach((label) => {
      const screen = project(label);
      context.fillText(label.text, screen.x, screen.y);
    });
  }

  // Selected flight point.
  const selectedScreen = project(selected);
  const check = evaluatePoint(selected, altitudeFt, buildings, zones);
  context.beginPath();
  context.arc(selectedScreen.x, selectedScreen.y, 13, 0, Math.PI * 2);
  context.fillStyle = "rgba(255,255,255,.96)";
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = check.state === "conflict" ? "#d82f29" : check.state === "clear" ? "#16705b" : "#1e282e";
  context.stroke();
  context.beginPath();
  context.arc(selectedScreen.x, selectedScreen.y, 3.5, 0, Math.PI * 2);
  context.fillStyle = context.strokeStyle;
  context.fill();

  // Scale bar.
  const scaleWidth = 1000 * view.scale;
  context.strokeStyle = "#1e282e";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(width - 38 - scaleWidth, height - 34);
  context.lineTo(width - 38, height - 34);
  context.stroke();
  context.font = "700 10px Arial, sans-serif";
  context.fillStyle = "#1e282e";
  context.textAlign = "center";
  context.fillText("1,000 FT", width - 38 - scaleWidth / 2, height - 42);
  context.textAlign = "left";
}

function parseCsv(text: string): Building[] {
  const rows = text.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length < 2) throw new Error("The CSV needs a header and at least one building row.");
  const headers = rows[0].split(",").map((header) => header.trim().toLowerCase());
  const values = rows.slice(1).map((row) => row.split(",").map((cell) => cell.trim()));
  const entries = values.map((cells) => Object.fromEntries(headers.map((header, i) => [header, cells[i]])));
  const latitudes = entries.map((row) => Number(row.lat ?? row.latitude)).filter(Number.isFinite);
  const longitudes = entries.map((row) => Number(row.lon ?? row.lng ?? row.longitude)).filter(Number.isFinite);
  const originLat = latitudes.length ? latitudes.reduce((sum, value) => sum + value, 0) / latitudes.length : CHICAGO_ORIGIN.lat;
  const originLon = longitudes.length ? longitudes.reduce((sum, value) => sum + value, 0) / longitudes.length : CHICAGO_ORIGIN.lon;
  return entries.map((row, index) => {
    const latitude = Number(row.lat ?? row.latitude);
    const longitude = Number(row.lon ?? row.lng ?? row.longitude);
    const heightFt = Number(row.height_ft ?? row.heightfeet ?? row.height);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(heightFt)) {
      throw new Error("CSV columns required: lat, lon, height_ft. Optional: name, width_ft, depth_ft.");
    }
    return {
      id: `csv-${index}`,
      name: row.name || `Imported building ${index + 1}`,
      x: (longitude - originLon) * FEET_PER_LON_DEGREE,
      y: -(latitude - originLat) * FEET_PER_LAT_DEGREE,
      width: Number(row.width_ft) || 180,
      depth: Number(row.depth_ft) || 180,
      heightFt,
    };
  });
}

function parseGeoJson(text: string): Building[] {
  const data = JSON.parse(text);
  const features = data.type === "FeatureCollection" ? data.features : data.type === "Feature" ? [data] : [];
  if (!features.length) throw new Error("GeoJSON must be a Feature or FeatureCollection.");
  const buildingFeatures = features.filter((feature: Record<string, unknown>) => {
    const geometry = feature.geometry as { type?: string } | undefined;
    return geometry && ["Point", "Polygon", "MultiPolygon"].includes(geometry.type || "");
  });
  const coordinates: { lat: number; lon: number; feature: Record<string, unknown> }[] = buildingFeatures.map(
    (feature: Record<string, unknown>) => {
      const geometry = feature.geometry as { type: string; coordinates: unknown };
      let points: number[][] = [];
      if (geometry.type === "Point") points = [geometry.coordinates as number[]];
      if (geometry.type === "Polygon") points = (geometry.coordinates as number[][][])[0];
      if (geometry.type === "MultiPolygon") points = (geometry.coordinates as number[][][][])[0][0];
      const lon = points.reduce((sum, point) => sum + Number(point[0]), 0) / points.length;
      const lat = points.reduce((sum, point) => sum + Number(point[1]), 0) / points.length;
      return { lat, lon, feature };
    },
  );
  const originLat = coordinates.reduce((sum, item) => sum + item.lat, 0) / coordinates.length;
  const originLon = coordinates.reduce((sum, item) => sum + item.lon, 0) / coordinates.length;
  return coordinates.map(({ lat, lon, feature }, index) => {
    const properties = (feature.properties || {}) as Record<string, unknown>;
    const heightFt = Number(properties.height_ft) || Number(properties.height_m) * 3.28084 || Number(properties.height) * 3.28084 || Number(properties["building:levels"]) * 10 || 30;
    return {
      id: `geo-${index}`,
      name: String(properties.name || `Imported building ${index + 1}`),
      x: (lon - originLon) * FEET_PER_LON_DEGREE,
      y: -(lat - originLat) * FEET_PER_LAT_DEGREE,
      width: Number(properties.width_ft) || 180,
      depth: Number(properties.depth_ft) || 180,
      heightFt: Math.round(heightFt),
    };
  });
}

function makeConservativeZone(buildings: Building[], label: string): Zone {
  const xs = buildings.map((building) => building.x);
  const ys = buildings.map((building) => building.y);
  const minX = Math.min(...xs) - 700;
  const maxX = Math.max(...xs) + 700;
  const minY = Math.min(...ys) - 700;
  const maxY = Math.max(...ys) + 700;
  return {
    id: "imported-study-area",
    label,
    source: "Conservative imported-data screen",
    points: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
  };
}

function estimateFlaggedSquareMiles(altitudeFt: number, buildings: Building[], zones: Zone[]) {
  if (!zones.length) return 0;
  const xs = zones.flatMap((zone) => zone.points.map((point) => point.x));
  const ys = zones.flatMap((zone) => zone.points.map((point) => point.y));
  const step = 300;
  let flagged = 0;
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += step) {
      if (evaluatePoint({ x, y }, altitudeFt, buildings, zones).state === "conflict") flagged += 1;
    }
  }
  return (flagged * step * step) / 27_878_400;
}

export function AirspacePlanner() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; view: View; moved: boolean } | null>(null);
  const [altitudeFt, setAltitudeFt] = useState(1800);
  const [buildings, setBuildings] = useState<Building[]>(SAMPLE_BUILDINGS);
  const [zones, setZones] = useState<Zone[]>(SAMPLE_ZONES);
  const [datasetName, setDatasetName] = useState("Downtown Chicago · sample");
  const [dataNote, setDataNote] = useState(`${SAMPLE_BUILDINGS.length} building records · 3 study polygons`);
  const [view, setView] = useState<View>({ x: -800, y: -550, scale: 0.105 });
  const [selected, setSelected] = useState<Point>({ x: 80, y: 160 });
  const [importError, setImportError] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const check = useMemo(
    () => evaluatePoint(selected, altitudeFt, buildings, zones),
    [selected, altitudeFt, buildings, zones],
  );
  const activeObstacles = useMemo(
    () => buildings.filter((building) => altitudeFt < building.heightFt + 1000).length,
    [altitudeFt, buildings],
  );
  const flaggedSquareMiles = useMemo(
    () => estimateFlaggedSquareMiles(altitudeFt, buildings, zones),
    [altitudeFt, buildings, zones],
  );

  const redraw = useCallback(() => {
    if (canvasRef.current) drawMap(canvasRef.current, view, altitudeFt, buildings, zones, selected);
  }, [view, altitudeFt, buildings, zones, selected]);

  useEffect(() => {
    redraw();
    const observer = new ResizeObserver(redraw);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [redraw]);

  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: view.x + (event.clientX - rect.left - rect.width / 2) / view.scale,
      y: view.y + (event.clientY - rect.top - rect.height / 2) / view.scale,
    };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startY: event.clientY, view, moved: false };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    if (Math.hypot(dx, dy) > 4) dragRef.current.moved = true;
    setView({
      ...dragRef.current.view,
      x: dragRef.current.view.x - dx / dragRef.current.view.scale,
      y: dragRef.current.view.y - dy / dragRef.current.view.scale,
    });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (dragRef.current && !dragRef.current.moved) setSelected(canvasPoint(event));
    dragRef.current = null;
  }

  function handleWheel(event: ReactWheelEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    setView((current) => ({ ...current, scale: Math.max(0.045, Math.min(0.24, current.scale * factor)) }));
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportError("");
    try {
      const text = await file.text();
      const imported = file.name.toLowerCase().endsWith(".csv") ? parseCsv(text) : parseGeoJson(text);
      if (!imported.length) throw new Error("No usable building records were found.");
      const importedZone = makeConservativeZone(imported, "Imported conservative study area");
      setBuildings(imported);
      setZones([importedZone]);
      setDatasetName(file.name);
      setDataNote(`${imported.length.toLocaleString()} buildings · heights normalized to feet`);
      setSelected({ x: 0, y: 0 });
      const span = Math.max(
        ...imported.map((building) => Math.abs(building.x)),
        ...imported.map((building) => Math.abs(building.y)),
        2500,
      );
      setView({ x: 0, y: 0, scale: Math.max(0.045, Math.min(0.15, 420 / span)) });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "This file could not be read.");
    } finally {
      event.target.value = "";
    }
  }

  function resetSample() {
    setBuildings(SAMPLE_BUILDINGS);
    setZones(SAMPLE_ZONES);
    setDatasetName("Downtown Chicago · sample");
    setDataNote(`${SAMPLE_BUILDINGS.length} building records · 3 study polygons`);
    setView({ x: -800, y: -550, scale: 0.105 });
    setSelected({ x: 80, y: 160 });
    setImportError("");
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

  const statusTitle =
    check.state === "conflict"
      ? "Modeled clearance not met"
      : check.state === "clear"
        ? "Modeled clearance met"
        : "Outside study polygons";

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={resetSample} aria-label="Clearance home and reset sample">
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <span>CLEARANCE</span>
        </button>
        <div className="rule-chip"><span>RULESET</span> FAA §91.119(b)</div>
        <div className="topbar-actions">
          <button className="data-source" onClick={() => inputRef.current?.click()}>
            <span className="status-dot" />
            <span><small>ACTIVE DATASET</small>{datasetName}</span>
          </button>
          <button className="import-button" onClick={() => inputRef.current?.click()}>
            <span aria-hidden="true">↥</span> Import data
          </button>
          <button className="icon-button" onClick={() => setInfoOpen(true)} aria-label="About this planning aid">?</button>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept=".csv,.geojson,.json,application/geo+json,text/csv"
            onChange={handleImport}
          />
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <div className="eyebrow-row">
            <span className="eyebrow">FLIGHT ALTITUDE</span>
            <span className="live-label"><i /> LIVE MODEL</span>
          </div>

          <div className="altitude-readout">
            <strong>{altitudeFt.toLocaleString()}</strong>
            <span>FT<br />AGL</span>
          </div>

          <label className="slider-wrap">
            <span className="visually-hidden">Flight altitude in feet above ground level</span>
            <input
              type="range"
              min="500"
              max="3000"
              step="50"
              value={altitudeFt}
              onChange={(event) => setAltitudeFt(Number(event.target.value))}
            />
            <span className="range-labels"><b>500</b><b>3,000 FT</b></span>
          </label>

          <div className="preset-row" aria-label="Altitude presets">
            {[1000, 1500, 2000, 2500].map((preset) => (
              <button
                key={preset}
                className={altitudeFt === preset ? "active" : ""}
                onClick={() => setAltitudeFt(preset)}
              >
                {preset.toLocaleString()}
              </button>
            ))}
          </div>

          <div className="rule-block">
            <div className="rule-heading"><span className="rule-number">§</span><span><small>MODELED STANDARD</small>91.119(b) clearance</span></div>
            <div className="rule-metrics">
              <div><strong>1,000</strong><span>FT ABOVE</span></div>
              <i />
              <div><strong>2,000</strong><span>FT RADIUS</span></div>
            </div>
            <p>Over a modeled congested polygon, the selected altitude is compared with the highest nearby obstacle.</p>
          </div>

          <div className={`point-check ${check.state}`} aria-live="polite">
            <div className="point-check-title"><span className="check-symbol">{check.state === "conflict" ? "!" : check.state === "clear" ? "✓" : "·"}</span><span><small>SELECTED POINT</small>{statusTitle}</span></div>
            {check.state !== "outside" ? (
              <dl>
                <div><dt>Required altitude</dt><dd>{check.requiredFt?.toLocaleString()} ft</dd></div>
                <div><dt>{(check.marginFt ?? 0) < 0 ? "Shortfall" : "Margin"}</dt><dd>{Math.abs(check.marginFt ?? 0).toLocaleString()} ft</dd></div>
                <div><dt>Highest within 2,000 ft</dt><dd>{check.obstacle?.name ?? "Ground baseline"}</dd></div>
              </dl>
            ) : <p>Click inside a dashed amber study polygon to run the clearance screen.</p>}
          </div>

          <div className="screen-summary">
            <span><small>RED AREA</small><strong>{flaggedSquareMiles.toFixed(2)} mi²</strong></span>
            <span><small>ACTIVE OBSTACLES</small><strong>{activeObstacles}</strong></span>
          </div>

          <div className="panel-footer">
            <button onClick={() => setDetailsOpen((current) => !current)}>
              {detailsOpen ? "Hide" : "Show"} model details <span>{detailsOpen ? "−" : "+"}</span>
            </button>
            {detailsOpen && (
              <div className="model-details">
                <p>Red = points inside a study polygon where altitude is below the tallest obstacle within 2,000 ft plus 1,000 ft.</p>
                <p>Terrain, airspace, temporary restrictions, weather, routes, takeoff/landing exceptions, and §91.119(a)/(c)/(d) are not modeled.</p>
              </div>
            )}
          </div>
        </aside>

        <section className="map-panel" aria-label="Interactive two-dimensional clearance map">
          <div className="map-titlebar">
            <div><span className="location-pin" aria-hidden="true" /> <strong>Chicago, Illinois</strong><small>41.8819° N, 87.6324° W</small></div>
            <span className="map-mode">2D · AGL</span>
          </div>
          <canvas
            ref={canvasRef}
            className="map-canvas"
            aria-label={`Interactive 2D map at ${altitudeFt} feet AGL. Red areas do not meet the modeled clearance. Click to check a point; drag to pan; scroll to zoom.`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => { dragRef.current = null; }}
            onWheel={handleWheel}
          />
          <div className="map-controls" aria-label="Map zoom controls">
            <button onClick={() => setView((current) => ({ ...current, scale: Math.min(0.24, current.scale * 1.2) }))} aria-label="Zoom in">＋</button>
            <button onClick={() => setView((current) => ({ ...current, scale: Math.max(0.045, current.scale / 1.2) }))} aria-label="Zoom out">−</button>
            <button onClick={() => setView({ x: -800, y: -550, scale: 0.105 })} aria-label="Reset map view">◎</button>
          </div>
          <div className="legend" aria-label="Map legend">
            <span><i className="legend-red" />Modeled conflict</span>
            <span><i className="legend-amber" />Study polygon</span>
            <span><i className="legend-building" />Building</span>
          </div>
          <div className="dataset-card">
            <span className="dataset-icon" aria-hidden="true">▤</span>
            <span><small>BUILDING HEIGHTS</small><strong>{datasetName}</strong><em>{dataNote}</em></span>
            <button onClick={() => inputRef.current?.click()}>Replace</button>
          </div>
          <div className="map-instruction">Click to test a point · drag to pan · scroll to zoom</div>
        </section>
      </section>

      <footer className="legal-bar">
        <span><b>PLANNING AID ONLY</b> This screen does not determine whether a flight is legal or authorized.</span>
        <button onClick={() => setInfoOpen(true)}>Read limitations</button>
      </footer>

      {importError && (
        <div className="toast error" role="alert"><span>!</span>{importError}<button onClick={() => setImportError("")} aria-label="Dismiss error">×</button></div>
      )}

      {infoOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setInfoOpen(false)}>
          <section className="info-modal" role="dialog" aria-modal="true" aria-labelledby="limitations-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setInfoOpen(false)} aria-label="Close">×</button>
            <span className="modal-kicker">MODEL NOTES</span>
            <h2 id="limitations-title">Clearance is a screening tool, not a go/no-go decision.</h2>
            <p>FAA §91.119(b) uses a 1,000-foot vertical clearance over the highest obstacle within 2,000 feet when operating over a congested area, except where necessary for takeoff or landing.</p>
            <p>The FAA evaluates whether an area is “congested” case by case. Housing density, people, and occupied buildings can matter. Imported files are therefore placed in a conservative study polygon—not labeled as an official FAA boundary.</p>
            <div className="modal-warning"><b>Small UAS note</b><span>Part 107 generally uses a different 400-foot AGL framework and may require airspace authorization. This prototype models the Part 91 rule named above.</span></div>
            <div className="file-help">
              <h3>Bring your own height data</h3>
              <p>GeoJSON: use <code>height_ft</code>, <code>height_m</code>, <code>height</code> (meters), or <code>building:levels</code>. CSV: include <code>lat, lon, height_ft</code>.</p>
              <button onClick={downloadTemplate}>Download CSV template</button>
            </div>
            <a href="https://www.faa.gov/about/office_org/headquarters_offices/agc/practice_areas/regulations/interpretations/Data/interps/2009/Anderson_2009_Legal_Interpretation.pdf" target="_blank" rel="noreferrer">FAA Anderson legal interpretation ↗</a>
          </section>
        </div>
      )}
    </main>
  );
}
