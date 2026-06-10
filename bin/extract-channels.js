// Split the imported ESA WorldCover XYZ tiles into per-class monochrome masks.
// The imported tiles carry the ESA WorldCover class code as their pixel value
// plus an alpha channel for nodata. For each class present in a tile this writes
// a 2-color mask (0 = present, 0xff = absent) that the render step vectorizes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import exists from '../lib/exists.js';
import { listZoomTiles } from '../lib/tiles.js';
import * as config from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const channels = config.layers;

const srcdir = path.resolve(__dirname, '../tiles/esa-worldcover');

const extract = async (z, x, y) => {
	const src = path.join(srcdir, `${z}/${x}/${y}.png`);

	// get raw buffer; the class code is the first channel, alpha is the last
	const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
	const stride = info.channels;
	const pixels = info.width * info.height;

	// one mask buffer per channel, allocated lazily so empty channels are skipped
	const bitmaps = {};

	// classify each pixel by its class code, mark it present in the matching channel mask
	for (let p = 0; p < pixels; p++) {
		const i = p * stride;
		if (data[i + stride - 1] === 0) continue; // transparent = nodata
		const kind = config.classifyCode(data[i]);
		if (!kind) continue;
		if (!bitmaps[kind]) bitmaps[kind] = Buffer.alloc(pixels, 0xff);
		bitmaps[kind][p] = 0; // present
	}

	// write a mask file per non-empty channel
	for (const channel of channels) {
		if (!bitmaps[channel]) continue;
		const dest = path.join(config.tiledir, `${channel}/${z}/${x}/${y}.png`);
		if (await exists(dest)) continue;
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await sharp(bitmaps[channel], { raw: { width: info.width, height: info.height, channels: 1 } })
			.png({ palette: true, colours: 2 })
			.toFile(dest);
	}
};

(async () => {
	const z1 = parseInt(process.argv[2] || '6', 10);
	for (let z = 0; z <= z1; z++) {
		const tiles = await listZoomTiles(srcdir, z);
		console.error('Extracting z%d (%d tiles)', z, tiles.length);
		for (const { x, y } of tiles) {
			await extract(z, x, y);
		}
	}
})();
