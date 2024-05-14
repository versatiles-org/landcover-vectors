// create lower zoom tiles by compositing higher zoom tiles

const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const exists = require("../lib/exists");

(async()=>{

	const channels = [ "bare", "builtup", "cropland", "grassland", "mangroves", "moss", "shrubland", "snow", "treecover", "water", "wetland"];

	for (let z = 9; z >= 0; z--) {
		for (let x = 0; x < Math.pow(2,z); x++) {

			// create dest dir
			for (let channel of channels) await fs.mkdir(path.resolve(__dirname, `../tiles/${channel}/${z}/${x}`), { recursive: true });

			for (let y = 0; y < Math.pow(2,z); y++) {

				// origin tiles are 256×256, all composites will be 512×512
				const size = (z===9) ? 256 : 512;

				// prepare components of tiles to composite
				const z1 = z+1;
				const x0 = x*2;
				const x1 = x0+1;
				const y0 = y*2;
				const y1 = y0+1;

				for (let channel of channels) {

					const dest = path.resolve(__dirname,`../tiles/${channel}/${z}/${x}/${y}.png`);
					if (await exists(dest)) continue; // skip if exists

					// composite operation
					const { data, info } = await sharp({ create: {
						width: size*2,
						height: size*2,
						channels: 4,
						background: { r: 255, g: 255, b: 255, alpha: 255 }}
					}).composite([
						{ input: await sharp(path.resolve(__dirname,`../tiles/${channel}/${z1}/${x0}/${y0}.png`)).toBuffer(), top: 0, left: 0 },
						{ input: await sharp(path.resolve(__dirname,`../tiles/${channel}/${z1}/${x1}/${y0}.png`)).toBuffer(), top: 0, left: size },
						{ input: await sharp(path.resolve(__dirname,`../tiles/${channel}/${z1}/${x0}/${y1}.png`)).toBuffer(), top: size, left: 0 },
						{ input: await sharp(path.resolve(__dirname,`../tiles/${channel}/${z1}/${x1}/${y1}.png`)).toBuffer(), top: size, left: size },
					]).raw().toBuffer({ resolveWithObject: true });

					// resize operation (this has to be seperated via a buffer, otherwise sharp resizes before compositing)
					sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).resize(512, 512).png().toFile(dest);

				};
				console.error(`Composited ${z}/${x}/${y}`);
			};
		};
	};

})();