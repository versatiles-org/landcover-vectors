// Cut the local reduced-resolution mirror into a web-mercator XYZ raster pyramid.
//
// Runs entirely from local disk (no network), so it avoids the flaky, many-request
// /vsicurl tiling. "mode" resampling — for both the base zoom and the overviews —
// keeps the land-cover class codes pure when downsampling (no blended values between
// classes), so lower zoom levels are categorically correct without a separate
// compositing step.
//
// --add-alpha de-palettes the source: each output tile carries the raw class code as
// its (grayscale) pixel value plus an alpha channel for nodata, which the render step
// classifies directly. --skip-blank omits all-nodata (ocean) tiles.
//
// Tiles are 4096×4096 px to match the MVT extent (see render.js). A 4096 px tile at
// zoom Z has the same ground resolution as a 256 px tile at zoom Z+4, so e.g. zoom 6
// tiles carry zoom-10 detail in a single, seam-free tile that the renderer vectorizes
// at native resolution (no upscaling).
//
// Requires GDAL ≥ 3.11 (gdalbuildvrt + `gdal raster tile`) on PATH.

import fs from 'node:fs/promises';
import path from 'node:path';

import { run } from '../lib/worldcover.js';
import { dir } from '../config.js';

const srcdir = dir.source;
const workdir = dir.raster;

const zoom = process.argv[2] || '0-6';

await fs.mkdir(workdir, { recursive: true });

// enumerate the downloaded reduced tiles (fully offline)
const sources = (await fs.readdir(srcdir)).filter((f) => f.endsWith('.tif')).map((f) => path.join(srcdir, f));
if (sources.length === 0) throw new Error(`no source tiles in ${srcdir} — run "npm run download" first`);
console.error('Tiling %d source tiles', sources.length);

// virtual mosaic over the local reduced tiles (EPSG:4326). Rebuilt every run so a
// resumed/expanded download is always fully included (cheap on local disk).
const listPath = path.join(srcdir, 'sources.txt');
await fs.writeFile(listPath, sources.join('\n') + '\n');
const vrtPath = path.join(srcdir, 'worldcover.vrt');
await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listPath, vrtPath]);

// cut the web-mercator XYZ pyramid (the GDAL "gdal raster tile" program)
const [minZoom, maxZoom] = zoom.includes('-') ? zoom.split('-') : [zoom, zoom];
await run(
	'gdal',
	[
		['raster', 'tile'],
		['--convention', 'xyz'],
		['--tile-size', '4096'],
		['--min-zoom', minZoom],
		['--max-zoom', maxZoom],
		['-r', 'mode'],
		['--overview-resampling', 'mode'],
		'--add-alpha',
		'--skip-blank',
		'--resume',
		['--webviewer', 'none'],
		['--num-threads', 'ALL_CPUS'],
		['-i', vrtPath],
		['-o', workdir],
	].flat(),
);

console.error('Done. XYZ tiles written to %s', workdir);
