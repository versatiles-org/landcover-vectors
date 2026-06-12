// Reduce the 10 blurred class masks to a single-band code raster via per-pixel argmax.
//
// Done entirely with stock `gdal raster` commands, which stream block by block (no
// need to hold the ten gigapixel bands in RAM):
//   1. calc      — `--calc argmax` (builtin dialect) returns the 1-based index of the
//                  channel with the highest blurred value, breaking ties toward the
//                  lowest index. Inputs are named A..J in channel order, so the index
//                  matches the channel order.
//   2. reclassify — map index 1..10 → code 10..100 (from config.channels).
//   3. edit      — re-attach the EPSG:3857 georeferencing that ImageMagick stripped
//                  from the blurred masks (CRS + the world Mercator bbox).
//
// The result, data/landcover-code.tif, is a clean coverage (every pixel one code) and
// is what gets polygonized.
//
// Requires GDAL ≥ 3.13 (gdal raster calc with the builtin `argmax`, reclassify, edit).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { file, datadir, channels, MERC } from '../config.js';
import { blurPath } from './blur-worldcover.js';

const inputs = channels.map((_, i) => blurPath(i));
for (const p of inputs) if (!existsSync(p)) throw new Error(`missing ${p} — run "npm run blur" first`);

// name the inputs A, B, C … in channel order; argmax's index follows input order
const named = inputs.flatMap((p, i) => ['-i', `${String.fromCharCode(65 + i)}=${p}`]);
// index 1..10 → code (10..100)
const mapping = channels.map((c, i) => `${i + 1}=${c.code}`).join(';');
const indexTif = path.join(datadir, '_index.tif');

try {
	console.error('argmax over %d channels → %s', inputs.length, indexTif);
	await run('gdal', [
		'raster',
		'calc',
		'--dialect',
		'builtin',
		...named,
		'--calc',
		'argmax',
		'--ot',
		'UInt8',
		'--no-check-crs', // the blurred masks carry no CRS (ImageMagick stripped it) — that's expected
		'--co',
		'COMPRESS=DEFLATE',
		'--co',
		'TILED=YES',
		'--overwrite',
		'-o',
		indexTif,
	]);

	console.error('Reclassifying index 1..10 → code 10..100 → %s', file.code);
	await run('gdal', [
		'raster',
		'reclassify',
		'-m',
		mapping,
		'--ot',
		'UInt8',
		'--co',
		'COMPRESS=DEFLATE',
		'--co',
		'TILED=YES',
		'--overwrite',
		'-i',
		indexTif,
		'-o',
		file.code,
	]);

	console.error('Re-attaching EPSG:3857 georeferencing');
	await run('gdal', [
		'raster',
		'edit',
		'--crs',
		'EPSG:3857',
		'--bbox',
		`${-MERC},${-MERC},${MERC},${MERC}`,
		file.code,
	]);
} finally {
	await fs.rm(indexTif, { force: true });
}

console.error('Done. Code raster in %s — run "npm run polygonize" next', file.code);
