// vectorize tiles and combine into vectortiles
// warning: potrace-wasm appears to leak memory
// FIXME: put into worker, hope it fixes the memory leak

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import svgPathToPolygons from "svg-path-to-polygons";
import potrace from "potrace-wasm";
import sharp from "sharp";
import vtt from "vtt";

import exists from "../lib/exists.js";
import rewind from "../lib/rewind.js";
import * as config from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { pathDataToPolys } = svgPathToPolygons;

const render = async function render(z, x, y) {

	// destination
	const dest = path.resolve(__dirname, `../tiles/vectortiles/${z}/${x}/${y}.pbf`);

	// take time
	const t = Date.now();

	// abort if tile exists
	if (await exists(dest)) {
		console.error("Tile %s/%s/%s.pbf already rendered", z, x, y);
		return;
	};

	// prepare vectortile
	const vectortile = {
		version: 2,
		name: "landcover-vectors",
		extent: 4096,
		features: [],
		keys: ["kind"],
		values: [],
	};

	// iterate layers
	for (let layer of config.layers) {

		// load raster image
		const img = sharp(path.resolve(config.tiledir, `${layer}/${z}/${x}/${y}.png`));

		// get original metadata
		const meta = await img.metadata();

		// calculate scale factors
		const sx = (4096 / meta.width);
		const sy = (4096 / meta.height);

		// extend 10 pixels, get buffer and metadata
		const { data, info } = await img.extend({ top: 10, left: 10, right: 10, bottom: 10, extendWith: 'copy' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

		// vectorize with potrace-wasm
		const vectors = await potrace.loadFromImageData(data, info.width, info.height, {
			pathonly: true,
			turdsize: 2,
			transform: false,
		});

		// check if vectors were found
		if (vectors.length > 0) {

			// add layer to values
			vectortile.values.push(layer);

			for (const vector of vectors) {

				// turn vector paths into polygons
				const polygon = pathDataToPolys(vector);

				// turn polygons into geometry
				const geometry = polygon.map(r => { // clip vector by extend
					return r.map(c => {
						c[0] = Math.min(info.width, Math.max(0, c[0] - 10));
						c[1] = Math.min(info.height, Math.max(0, c[1] - 10));
						return c;
					});
				}).map(r => { // scale and round
					return r.map(c => { // scale to 4096×4096 and round to integers
						c[0] = Math.round(c[0] * sx);
						c[1] = Math.round(c[1] * sy);
						return c;
					}).filter((c, i, a) => { // filter double coordinates
						return (i === 0 || c[0] !== a[i - 1][0] || c[1] !== a[i - 1][1]);
					}).filter((c, i, a) => { // filter "180° corners" aka pointless nodes on a straight line
						return i === 0 || i === a.length - 1 || Math.atan2(c[1] - a[i - 1][1], c[0] - a[i - 1][1]) !== Math.atan2(a[i + 1][1] - c[1], a[i + 1][0] - c[0]);
					}); // FIXME apply simplification directly?
				});

				// enforce MVT 2.1 ring winding (exterior positive, holes negative)
				const rewound = rewind(geometry);

				// add feature to vectortile
				vectortile.features.push({
					id: (vectortile.features.length + 1),
					type: 3,
					geometry: rewound,
					properties: {
						kind: layer, // layer type
					},
				});

			};

		};

	};

	// pack tile, empty layer if no features
	const pbf = vtt.pack((vectortile.features.length > 0) ? [vectortile] : []);

	// write tile
	await fs.writeFile(dest, pbf);

	// status
	console.log("Rendered %s/%s/%s.pbf in %ss (%skb)", z, x, y, ((Date.now() - t) / 1000).toFixed(2), (pbf.length / 1024).toFixed(2));

	return;

};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) (async () => {
	let z1 = parseInt((process.argv[2] || "8"), 10);
	for (let z = 0; z <= z1; z++) {
		for (let x = 0; x < Math.pow(2, z); x++) {
			await fs.mkdir(path.resolve(__dirname, `../tiles/vectortiles/${z}/${x}`), { recursive: true });
			for (let y = 0; y < Math.pow(2, z); y++) {
				await render(z, x, y);
			};
		};
	};

	// write tilejson
	await fs.writeFile(path.resolve(__dirname, `../tiles/vectortiles-simplified/tile.json`), JSON.stringify(config.vectorTileJSON(), null, "\t"));
})();

