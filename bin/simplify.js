import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import vtt from 'vtt';

import visvalingam from '../lib/visvalingam.js';
import exists from '../lib/exists.js';
import { listZoomTiles } from '../lib/tiles.js';
import { progress } from '../lib/progress.js';
import * as config from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const vectordir = path.resolve(__dirname, '../tiles/vectortiles');

const targetSize = 1e5; // 100kb

const simplify = async function simplify(src) {
	const buf = await fs.readFile(src);

	// no need to simplify small tiles
	if (buf.length < targetSize / 2) return buf;

	const factor = Math.min(0.75, targetSize / buf.length);

	// unpack vectortile
	const vectortile = vtt.unpack(buf);

	// iterate layers
	for (let layer of vectortile) {
		// iterate features
		for (let feature of layer.features) {
			// FIXME check if polygon

			// iterate polylines
			feature.geometry = feature.geometry
				.filter((polygon) => {
					return polygon.length > 16;
				})
				.map((polygon) => {
					// simplify with edge-safe visvalingam
					return visvalingam(polygon, Math.max(16, Math.round(polygon.length * factor)));
				})
				.filter((polygon) => {
					// remove empty polygons
					return polygon.length;
				});
		}
	}

	return vtt.pack(vectortile);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	(async () => {
		let z1 = parseInt(process.argv[2] || '6', 10);
		for (let z = 0; z <= z1; z++) {
			const tiles = await listZoomTiles(vectordir, z, 'pbf');
			if (tiles.length === 0) continue;
			const bar = progress(tiles.length, `Simplifying z${z}`);
			for (const { x, y } of tiles) {
				const src = path.join(vectordir, `${z}/${x}/${y}.pbf`);
				const dest = path.resolve(__dirname, `../tiles/vectortiles-simplified/${z}/${x}/${y}.pbf`);

				// skip if already simplified
				if (!(await exists(dest))) {
					await fs.mkdir(path.dirname(dest), { recursive: true });
					await fs.writeFile(dest, await simplify(src));
				}
				bar.tick();
			}
			bar.done();
		}

		// write tilejson
		await fs.writeFile(
			path.resolve(__dirname, `../tiles/vectortiles-simplified/tile.json`),
			JSON.stringify(config.vectorTileJSON(), null, '\t'),
		);
	})();
