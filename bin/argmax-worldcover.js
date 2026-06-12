// Reduce the 10 blurred class masks to a single-band code raster via per-pixel argmax.
//
// Delegates the heavy raster math to lib/argmax.py (osgeo.gdal + numpy), which picks
// the winning channel per pixel, writes code = (channel index + 1) * 10 (so 10..100),
// and re-attaches the EPSG:3857 georeferencing that ImageMagick stripped — copied from
// the reprojected world raster, which shares the exact grid. Processing is block-wise
// to stay within RAM. The result, data/landcover-code.tif, is what gets polygonized.
//
// Requires Python 3 with GDAL bindings (osgeo.gdal) and numpy.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../lib/worldcover.js';
import { file, channels } from '../config.js';
import { blurPath } from './blur-worldcover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, '..', 'lib', 'argmax.py');

// number of raster rows held in memory at once: 10 byte bands × BLOCK_ROWS × 32768 px
const BLOCK_ROWS = process.env.ARGMAX_BLOCK_ROWS || '2048';

if (!existsSync(file.warped)) throw new Error(`missing ${file.warped} — run "npm run reproject" first`);
const inputs = channels.map((_, i) => blurPath(i));
for (const p of inputs) if (!existsSync(p)) throw new Error(`missing ${p} — run "npm run blur" first`);

console.error('Computing argmax over %d channels → %s', inputs.length, file.code);
await run('python3', [script, file.warped, file.code, BLOCK_ROWS, ...inputs]);

console.error('Done. Code raster in %s — run "npm run polygonize" next', file.code);
