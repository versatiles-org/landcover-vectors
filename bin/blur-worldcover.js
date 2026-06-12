// Gaussian-blur each class mask.
//
// Blurring turns the hard 0/255 membership masks into smooth fields, so the later
// per-pixel argmax produces curved class boundaries instead of the pixel staircase,
// with shared borders staying exact (the masks still sum to a partition). GDAL has no
// Gaussian filter, so this uses libvips (much faster than ImageMagick on gigapixel
// images: streaming, and it works in 8-bit rather than promoting to float), falling
// back to ImageMagick when `vips` is not on PATH. Either way the blur is an
// approximation — exactness doesn't matter, since the result only feeds an argmax.
//
// BLUR_SIGMA (default 4) is the Gaussian standard deviation in pixels — the smoothing
// radius from the spec; at this resolution one pixel ≈ 1.2 km. BLUR_PRECISION (vips
// only, default `approximate`) trades accuracy for speed. Both tools strip the GeoTIFF
// georeferencing; that is intentional — the argmax step re-attaches it.
//
// Requires libvips (vips) or ImageMagick 7 (magick) on PATH.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { runQuiet, pMap, commandExists } from '../lib/worldcover.js';
import { progress } from '../lib/progress.js';
import { dir, datadir, channels, CPU_CORES, BLUR_RADIUS, maskPath, blurPath } from '../config.js';

const CONCURRENCY = process.env.BLUR_CONCURRENCY ? parseInt(process.env.BLUR_CONCURRENCY, 10) : CPU_CORES;
const PRECISION = process.env.BLUR_PRECISION || 'approximate'; // vips gaussblur: integer|float|approximate
const useVips = await commandExists('vips');
if (!useVips && !(await commandExists('magick')))
	throw new Error('need libvips (vips) or ImageMagick (magick) on PATH');

// keep ImageMagick's disk-backed pixel cache on the data disk, not a RAM-backed /tmp
process.env.MAGICK_TMPDIR = datadir;

for (let i = 0; i < channels.length; i++) {
	if (!existsSync(maskPath(i))) throw new Error(`missing ${maskPath(i)} — run "npm run channels" first`);
}

// blur one mask: vips writes a deflate-compressed 8-bit TIFF; ImageMagick is the fallback
function blur(src, out) {
	if (useVips) {
		return runQuiet('vips', [
			'gaussblur',
			src,
			`${out}[compression=deflate,predictor=horizontal]`,
			String(BLUR_RADIUS),
			'--precision',
			PRECISION,
		]);
	}
	return runQuiet('magick', [src, '-blur', `0x${BLUR_RADIUS}`, '-depth', '8', '-compress', 'Zip', out]);
}

console.error(
	'Blurring %d masks with %s (σ=%s px, %d workers)',
	channels.length,
	useVips ? 'vips' : 'ImageMagick',
	BLUR_RADIUS,
	CONCURRENCY,
);
const bar = progress(channels.length, 'Blur');
await pMap(
	channels.map((_, i) => i),
	CONCURRENCY,
	async (i) => {
		const out = blurPath(i);
		if (!existsSync(out)) await blur(maskPath(i), out);
		bar.tick();
	},
);
bar.done();

console.error('Done. Blurred masks in %s — run "npm run argmax" next', dir.channels);
