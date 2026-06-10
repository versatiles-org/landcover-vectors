// Split ESA Worldcover files into distinct channels

const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const exists = require("../lib/exists");
const config = require("../config");

const channels = config.layers;

(async () => {

	// prepare bitmap buffers
	const bitmaps = Object.fromEntries(channels.map(channel => [channel, Buffer.alloc(65536, 0xff)]));

	for (let x = 0; x < 1024; x++) {

		// ensure directories
		for (let channel of channels) await fs.mkdir(path.resolve(__dirname, `../tiles/${channel}/10/${x}`), { recursive: true });

		for (let y = 0; y < 1024; y++) {

			// clear bitmap buffers
			for (let channel of channels) bitmaps[channel].fill(0xff);

			// file source
			const src = path.resolve(__dirname, `../tiles/esa-worldcover/10/${x}/${y}.png`);

			// get raw buffer
			const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });

			// iterate over pixels, classify by color channels, write to bitmap
			for (let i = 0; i < info.size; i += 4) {

				// check if transparent
				if (data[i + 3] === 0) continue;

				// classify pixel by color and mark it in the matching channel
				const kind = config.classify(data[i], data[i + 1], data[i + 2]);
				if (kind) bitmaps[kind][i / 4] = 0;
			};

			// save to individual files
			for (let channel in bitmaps) {
				const dest = path.resolve(__dirname, `../tiles/${channel}/10/${x}/${y}.png`);
				if (await exists(dest)) continue;
				await sharp(bitmaps[channel], { raw: { width: info.width, height: info.height, channels: 1 } }).png({
					palette: true,
					colours: 2,
				}).toFile(dest);
			};

			console.error(`Extracted ${x}/${y}`);
		};

	};

})();
