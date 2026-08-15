import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SOURCE_URL = "https://aeronav.faa.gov/Obst_Data/DAILY_DOF_CSV.ZIP";
const OUTPUT_ROOT = resolve("public/data/faa-obstacles");
const GRID_DEGREES = 1;

function parseCsvRow(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function roundedCoordinate(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function downloadArchive(destination) {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`FAA download failed with HTTP ${response.status}.`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
  return response.headers.get("last-modified");
}

function openArchiveCsv(archivePath) {
  const unzip = spawn("unzip", ["-p", archivePath, "DOF.CSV"], { stdio: ["ignore", "pipe", "inherit"] });
  unzip.stdout.on("error", (error) => unzip.kill(error));
  return unzip;
}

async function main() {
  if (!OUTPUT_ROOT.endsWith("/public/data/faa-obstacles")) throw new Error("Refusing to replace an unexpected output directory.");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "clearance-faa-ddof-"));
  const suppliedArchive = process.argv[2] ? resolve(process.argv[2]) : null;
  const archivePath = suppliedArchive || join(temporaryRoot, "DAILY_DOF_CSV.ZIP");
  let sourceLastModified = null;
  try {
    if (!suppliedArchive) sourceLastModified = await downloadArchive(archivePath);
    const unzip = openArchiveCsv(archivePath);
    const lines = createInterface({ input: unzip.stdout, crlfDelay: Infinity });
    const shards = new Map();
    let headers = null;
    let recordCount = 0;

    for await (const line of lines) {
      if (!headers) {
        headers = new Map(parseCsvRow(line).map((header, index) => [cleanText(header).toUpperCase(), index]));
        continue;
      }
      const cells = parseCsvRow(line);
      const read = (name) => cells[headers.get(name)] ?? "";
      const latitude = Number(read("LATDEC"));
      const longitude = Number(read("LONDEC"));
      const aglFt = Number.parseInt(read("AGL"), 10);
      const amslFt = Number.parseInt(read("AMSL"), 10);
      if (![latitude, longitude, aglFt, amslFt].every(Number.isFinite)) continue;
      const latIndex = Math.floor(latitude / GRID_DEGREES);
      const lonIndex = Math.floor(longitude / GRID_DEGREES);
      const key = `${latIndex}_${lonIndex}`;
      const records = shards.get(key) || [];
      records.push([
        cleanText(read("OAS")),
        roundedCoordinate(latitude),
        roundedCoordinate(longitude),
        cleanText(read("TYPE")) || "OBSTACLE",
        aglFt,
        amslFt,
        cleanText(read("VERIFIED STATUS")) || "U",
        cleanText(read("ACCURACY")) || "9I",
      ]);
      shards.set(key, records);
      recordCount += 1;
    }

    const exitCode = await new Promise((resolveExit, rejectExit) => {
      unzip.once("error", rejectExit);
      unzip.once("close", resolveExit);
    });
    if (exitCode !== 0) throw new Error(`unzip exited with code ${exitCode}.`);

    await rm(OUTPUT_ROOT, { recursive: true, force: true });
    await mkdir(OUTPUT_ROOT, { recursive: true });
    const sortedKeys = [...shards.keys()].sort((first, second) => first.localeCompare(second, "en", { numeric: true }));
    for (const key of sortedKeys) {
      const records = shards.get(key).sort((first, second) => String(first[0]).localeCompare(String(second[0])));
      await writeFile(join(OUTPUT_ROOT, `${key}.json`), JSON.stringify(records));
    }
    const sourceDate = sourceLastModified ? new Date(sourceLastModified).toISOString().slice(0, 10) : null;
    const manifest = {
      schemaVersion: 1,
      source: "FAA Daily Digital Obstacle File (DDOF)",
      sourceUrl: SOURCE_URL,
      sourceLastModified: sourceDate,
      generatedAt: new Date().toISOString(),
      gridDegrees: GRID_DEGREES,
      recordCount,
      cells: Object.fromEntries(sortedKeys.map((key) => [key, shards.get(key).length])),
    };
    await writeFile(join(OUTPUT_ROOT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Wrote ${recordCount.toLocaleString()} FAA obstacles to ${sortedKeys.length.toLocaleString()} geographic shards from ${basename(archivePath)}.\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
