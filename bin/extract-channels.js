// Split ESA Worldcover files into distinct channels

const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const exists = require("../lib/exists");
const config = require("../config");

const channels = [ "treecover", "shrubland", "grassland", "cropland", "builtup", "bare", "snow", "water", "wetland", "mangroves", "moss" ];

(async ()=>{

	// prepare bitmap buffers
	const bitmaps = {
		treecover: Buffer.alloc(65536, 0xff),
		shrubland: Buffer.alloc(65536, 0xff),
		grassland: Buffer.alloc(65536, 0xff),
		cropland: Buffer.alloc(65536, 0xff),
		builtup: Buffer.alloc(65536, 0xff),
		bare: Buffer.alloc(65536, 0xff),
		snow: Buffer.alloc(65536, 0xff),
		water: Buffer.alloc(65536, 0xff),
		wetland: Buffer.alloc(65536, 0xff),
		mangroves: Buffer.alloc(65536, 0xff),
		moss: Buffer.alloc(65536, 0xff),
	};

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
			for (let i = 0; i < info.size; i+= 4) {

				// check if transparent
				if (data[i+3] === 0) continue;

				// detect channel by blue byte
				switch (data[i+2]) {
					case 180:
						bitmaps.bare[i/4] = 0;
						continue;
					break;
					case 76:
						bitmaps.grassland[i/4] = 0;
						continue;
					break;
					case 34:
						bitmaps.shrubland[i/4] = 0;
						continue;
					break;
					case 255:
						bitmaps.cropland[i/4] = 0;
						continue;
					break;
					case 0:
						switch (data[i+1]) { // distinguish by green byte
							case 100:
								bitmaps.treecover[i/4] = 0;
								continue;
							break;
							case 0:
								bitmaps.builtup[i/4] = 0;
								continue;
							break;
						};
					break;
					case 200:
						bitmaps.water[i/4] = 0;
						continue;
					break;
					case 240:
						bitmaps.snow[i/4] = 0;
						continue;
					break;
					case 117:
						bitmaps.mangroves[i/4] = 0;
						continue;
					break;
					case 160:
						switch (data[i+1]) { // distinguish by green byte
							case 150:
								bitmaps.wetland[i/4] = 0;
								continue;
							break;
							case 230:
								bitmaps.moss[i/4] = 0;
								continue;
							break;
						};
					break;
				};
			};

			// save to individual files
			for (let channel in bitmaps) {
				const dest =  path.resolve(__dirname, `../tiles/${channel}/10/${x}/${y}.png`);
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
