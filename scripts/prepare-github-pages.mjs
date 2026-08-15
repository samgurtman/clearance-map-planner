import { access, rename, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

const outputRoot = resolve("dist/client");
const configuredBasePath = process.env.PAGES_BASE_PATH?.trim() ?? "";
const basePath = configuredBasePath === "/" ? "" : configuredBasePath.replace(/\/$/, "");

if (!basePath) process.exit(0);
if (!/^\/[A-Za-z0-9._-]+$/.test(basePath)) {
  throw new Error(`Invalid PAGES_BASE_PATH: ${configuredBasePath}`);
}

// GitHub Pages mounts the artifact root at the repository URL. Vinext's asset
// prefix also nests emitted files beneath that prefix, so move only the
// generated _next directory back to the artifact root while preserving the
// prefixed browser URLs in index.html.
const prefixedRoot = resolve(outputRoot, basePath.slice(1));
const prefixedAssets = resolve(prefixedRoot, "_next");
const rootAssets = resolve(outputRoot, "_next");

if (!prefixedRoot.startsWith(`${outputRoot}${sep}`)) {
  throw new Error("Refusing to modify a path outside dist/client.");
}

await access(prefixedAssets);
await rm(rootAssets, { recursive: true, force: true });
await rename(prefixedAssets, rootAssets);
await rm(prefixedRoot, { recursive: true, force: true });
