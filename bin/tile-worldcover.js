// Build the vector tile pyramid from the merged polygon geometry, using tippecanoe.
//
// tippecanoe simplifies the geometry per zoom level and tiles it seamlessly in one
// pass: --detect-shared-borders keeps boundaries between adjacent classes coincident
// while simplifying (no slivers/gaps), and --coalesce-smallest-as-needed merges the
// tile-boundary fragments left by per-tile polygonization rather than dropping them,
// so coverage stays complete.
//
// Requires tippecanoe on PATH (e.g. `brew install tippecanoe`).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { datadir, file, meta } from '../config.js';

const zoom = process.argv[2] || '0-6';
const [minZoom, maxZoom] = zoom.includes('-') ? zoom.split('-') : [zoom, zoom];

if (!existsSync(file.geometry)) {
	throw new Error(`missing ${file.geometry} — run "npm run polygonize" first`);
}

// tippecanoe sorts its features through a temp store of several GB. Keep it on the
// data disk rather than the default /tmp, which on servers is often a RAM-backed
// tmpfs — filling that gets tippecanoe OOM-killed (exits with signal SIGKILL).
const tmpdir = path.join(datadir, 'tippecanoe-tmp');
await fs.mkdir(tmpdir, { recursive: true });

await run('tippecanoe', [
	'-o',
	file.tiles,
	'--force', // overwrite existing output
	'--temporary-directory',
	tmpdir,
	'--minimum-zoom',
	minZoom,
	'--maximum-zoom',
	maxZoom,
	'--layer',
	meta.layer,
	'--attribute-type',
	'kind:string',
	'--include',
	'kind', // keep only the kind attribute
	'--detect-shared-borders', // coverage-aware simplification (no slivers between classes)
	'--coalesce-smallest-as-needed', // merge tile-boundary fragments instead of dropping
	'--name',
	meta.name,
	'--attribution',
	meta.attribution,
	'--description',
	meta.description,
	file.geometry,
]);

console.error('Done. Tiles written to %s', file.tiles);
