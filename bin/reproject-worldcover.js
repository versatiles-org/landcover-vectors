// Render the reduced-resolution raster mirror into one global Web Mercator raster.
//
// The ~2651 source tiles (native EPSG:4326, ~74 m) are mosaicked with a VRT and
// reprojected to EPSG:3857 at SIZE×SIZE pixels covering the standard Mercator square
// (±MERC m ≈ ±85.0511°). Resampling is "mode" (dominant class) — the only correct
// choice for categorical data. The result, data/worldcover-3857.tif, is a single Byte
// band with class codes {0,10,…,100}; it is the input to the channel split.
//
// SIZE = 32768 is exactly zoom-7 tile resolution, so the grid is tile-aligned and the
// pixels are square. DEFLATE keeps the file small (~hundreds of MB).
//
// Requires GDAL (gdalbuildvrt, gdalwarp) on PATH.

import fs from 'node:fs/promises';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { dir, file, datadir, SIZE, MERC } from '../config.js';

const tiles = (await fs.readdir(dir.source).catch(() => [])).filter((f) => f.endsWith('.tif'));
if (tiles.length === 0) throw new Error(`no source tiles in ${dir.source} — run "npm run download" first`);

await fs.mkdir(datadir, { recursive: true });

// mosaic all source tiles into a VRT (via an input-file list so we don't hit
// command-line length limits or rely on shell glob expansion, which run() doesn't do)
const listPath = path.join(datadir, '_src.txt');
const vrtPath = path.join(datadir, '_src.vrt');
await fs.writeFile(listPath, tiles.map((t) => path.join(dir.source, t)).join('\n') + '\n');

console.error('Mosaicking %d source tiles → %s', tiles.length, vrtPath);
await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listPath, vrtPath]);

// reproject the mosaic to the global Web Mercator square. -r mode = dominant class.
console.error('Warping to EPSG:3857 %d×%d → %s', SIZE, SIZE, file.warped);
await run('gdalwarp', [
	'-t_srs',
	'EPSG:3857',
	'-te',
	String(-MERC),
	String(-MERC),
	String(MERC),
	String(MERC),
	'-ts',
	String(SIZE),
	String(SIZE),
	'-r',
	'mode',
	'-ot',
	'Byte',
	'-dstnodata',
	'0',
	'-of',
	'GTiff',
	'-co',
	'COMPRESS=DEFLATE',
	'-co',
	'TILED=YES',
	'-co',
	'BIGTIFF=YES',
	'-multi',
	'-wo',
	'NUM_THREADS=ALL_CPUS',
	'-overwrite',
	vrtPath,
	file.warped,
]);

await fs.rm(listPath, { force: true });
await fs.rm(vrtPath, { force: true });

console.error('Done. World raster in %s — run "npm run channels" next', file.warped);
