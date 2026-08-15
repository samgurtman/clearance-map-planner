# Clearance Map Planner

A client-side planning aid that screens a selected area against modeled FAA
clearance criteria using Overture building footprints, FAA obstacle data, and
surface elevation. It is a screening tool, not an authoritative source for
flight planning.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

## GitHub Pages

The repository includes a GitHub Actions workflow that builds and deploys a
static export. In the repository's **Settings → Pages**, set **Source** to
**GitHub Actions**. Pushes to `main` then deploy automatically.

To verify the export locally at a repository-style base path:

```bash
PAGES_BASE_PATH=/clearance-map-planner npm run build:pages
```

The deployable files are written to `dist/client`.

## Data layers

- Overture Maps building and water PMTiles
- FAA Daily Digital Obstacle File snapshot bundled as geographic shards
- Mapzen Terrarium elevation tiles, including U.S. data derived from USGS
- CARTO/OpenStreetMap streets plus FAA sectional and terminal chart tiles

Building, obstacle, terrain, shoreline, and chart data can be incomplete,
outdated, generalized, or unavailable. The displayed result does not establish
that a flight is legal or authorized.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm run build:pages`: create the GitHub Pages static export
- `npm run data:faa`: refresh the bundled FAA obstacle snapshot
