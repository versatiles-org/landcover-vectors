// Build the vector tile pyramid from the merged polygon geometry, using tippecanoe.
//
// tippecanoe simplifies the geometry per zoom level and tiles it seamlessly in one
// pass. --coalesce-smallest-as-needed merges the tile-boundary fragments left by
// polygonization (keeping coverage), and --drop-densest-as-needed sheds features so
// that dense low-zoom tiles — z0 is the whole world in a single tile — fit the MVT
// size limit instead of blowing up.
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

const args = [
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
	'--coalesce-smallest-as-needed', // merge tile-boundary fragments instead of dropping
	'--drop-densest-as-needed', // shed features so dense low-zoom tiles fit (bounds size + memory)
	'--name',
	meta.name,
	'--attribution',
	meta.attribution,
	'--description',
	meta.description,
];

// --detect-shared-borders gives cleaner class boundaries but is very memory-heavy at
// low zoom (z0 is the whole world in one tile) and can blow up tile 0/0/0. The
// geometry is already coverage-simplified upstream, so it's redundant; enable it only
// with plenty of RAM via TIPPECANOE_SHARED_BORDERS=1.
if (process.env.TIPPECANOE_SHARED_BORDERS === '1') args.push('--detect-shared-borders');

args.push(file.geometry);

await run('tippecanoe', args);

console.error('Done. Tiles written to %s', file.tiles);
