// Split the imported ESA WorldCover XYZ tiles into per-class monochrome masks.
// Reads the colored tiles produced by import-worldcover.js and writes, for each
// land-cover class present in a tile, a 2-color mask (0 = present, 0xff = absent)
// that the render step vectorizes.

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

	// get raw RGBA buffer
	const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const pixels = info.width * info.height;

	// one mask buffer per channel, allocated lazily so empty channels are skipped
	const bitmaps = {};

	// classify each pixel by color, mark it present in the matching channel mask
	for (let i = 0; i < info.size; i += 4) {
		if (data[i + 3] === 0) continue; // transparent = nodata
		const kind = config.classify(data[i], data[i + 1], data[i + 2]);
		if (!kind) continue;
		if (!bitmaps[kind]) bitmaps[kind] = Buffer.alloc(pixels, 0xff);
		bitmaps[kind][i / 4] = 0; // present
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
