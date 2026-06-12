// Gaussian-blur each class mask.
//
// Blurring turns the hard 0/255 membership masks into smooth fields, so the later
// per-pixel argmax produces curved class boundaries instead of the pixel staircase,
// with shared borders staying exact (the masks still sum to a partition). ImageMagick
// does the blur (GDAL has no Gaussian filter); it processes one gigapixel band at a
// time and pages to disk via MAGICK_TMPDIR when it exceeds the memory limit.
//
// BLUR_SIGMA (default 4) is the Gaussian standard deviation in pixels — the smoothing
// radius from the spec; at this resolution one pixel ≈ 1.2 km. ImageMagick strips the
// GeoTIFF georeferencing; that is intentional — the argmax step re-attaches it from
// the reprojected raster (identical grid).
//
// Requires ImageMagick 7 (magick) on PATH.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { runQuiet, pMap } from '../lib/worldcover.js';
import { progress } from '../lib/progress.js';
import { dir, datadir, channels, CPU_CORES } from '../config.js';
import { maskPath } from './channels-worldcover.js';

// path of the blurred mask for channel index i (0-based)
export function blurPath(i) {
	return path.join(dir.channels, `ch${String(i + 1).padStart(2, '0')}-blur.tif`);
}

const SIGMA = process.env.BLUR_SIGMA || '8';
const CONCURRENCY = process.env.BLUR_CONCURRENCY ? parseInt(process.env.BLUR_CONCURRENCY, 10) : CPU_CORES;

// keep ImageMagick's disk-backed pixel cache on the data disk, not a RAM-backed /tmp
process.env.MAGICK_TMPDIR = datadir;

for (let i = 0; i < channels.length; i++) {
	if (!existsSync(maskPath(i))) throw new Error(`missing ${maskPath(i)} — run "npm run channels" first`);
}

console.error('Blurring %d masks (σ=%s px, %d workers)', channels.length, SIGMA, CONCURRENCY);
const bar = progress(channels.length, 'Blur');
await pMap(
	channels.map((_, i) => i),
	CONCURRENCY,
	async (i) => {
		const out = blurPath(i);
		if (!existsSync(out)) {
			await runQuiet('magick', [
				maskPath(i),
				'-blur',
				`0x${SIGMA}`,
				'-depth',
				'8',
				'-compress',
				'Zip',
				out,
			]);
		}
		bar.tick();
	},
);
bar.done();

console.error('Done. Blurred masks in %s — run "npm run argmax" next', dir.channels);
