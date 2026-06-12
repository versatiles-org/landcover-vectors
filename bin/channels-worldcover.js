// Split the world raster into 10 per-class membership masks.
//
// For each entry in config.channels, gdal_calc.py evaluates its expression over the
// reprojected raster and writes a single-band Byte mask: 255 where the pixel belongs
// to that class, 0 elsewhere. Across all ten masks every pixel is 255 in exactly one
// channel (the classes partition the legend, with moss→bare and mangroves→wetland
// merged and ESA 0 captured by the last "no data" channel). These masks are the input
// to the blur step.
//
// Each mask is ~1 GB uncompressed in RAM inside gdal_calc, so a few run in parallel.
// Resumable: existing masks are skipped.
//
// Requires GDAL (gdal_calc.py) on PATH.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runQuiet, pMap } from '../lib/worldcover.js';
import { progress } from '../lib/progress.js';
import { dir, file, channels } from '../config.js';

// path of the raw (unblurred) mask for channel index i (0-based)
export function maskPath(i) {
	return path.join(dir.channels, `ch${String(i + 1).padStart(2, '0')}.tif`);
}

const CONCURRENCY = Math.max(1, Math.min(4, os.availableParallelism() - 1));

if (!existsSync(file.warped)) throw new Error(`missing ${file.warped} — run "npm run reproject" first`);
await fs.mkdir(dir.channels, { recursive: true });

console.error('Building %d class masks (%d workers)', channels.length, CONCURRENCY);
const bar = progress(channels.length, 'Channels');
await pMap(
	channels.map((c, i) => ({ c, i })),
	CONCURRENCY,
	async ({ c, i }) => {
		const out = maskPath(i);
		if (!existsSync(out)) {
			await runQuiet('gdal_calc.py', [
				'-A',
				file.warped,
				'--calc',
				c.calc,
				'--type',
				'Byte',
				'--hideNoData', // 0 means "not this class", not nodata — keep it a real value for the blur
				'--co',
				'COMPRESS=DEFLATE',
				'--co',
				'TILED=YES',
				'--overwrite',
				'--quiet',
				'--outfile',
				out,
			]);
		}
		bar.tick();
	},
);
bar.done();

console.error('Done. Masks in %s — run "npm run blur" next', dir.channels);
