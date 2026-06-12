// Build the vector tile pyramid from the merged polygon geometry, using tippecanoe.
//
// tippecanoe simplifies the geometry per zoom level and tiles it seamlessly in one
// pass. When a tile would exceed the size limit (z0 is the whole world in one tile),
// it keeps the coverage complete by simplifying harder — --simplification scales the
// per-zoom tolerance, so it mostly affects the low zooms — and merging the smallest
// polygons into their neighbours (--coalesce-smallest-as-needed). Features are never
// dropped, which would leave holes in the landcover.
//
// Requires tippecanoe on PATH (e.g. `brew install tippecanoe`).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { datadir, file, meta } from '../config.js';

const zoom = process.argv[2] || '6';
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
	// keep oversized tiles complete: simplify harder + merge the smallest polygons into
	// their neighbours, rather than dropping features (which would leave holes)
	'--simplification',
	'10',
	'--coalesce-smallest-as-needed',
	'--name',
	meta.name,
	'--attribution',
	meta.attribution,
	'--description',
	meta.description,
];

args.push(file.geometry);

await run('tippecanoe', args);

console.error('Done. Tiles written to %s', file.tiles);
