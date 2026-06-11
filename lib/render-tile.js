// Vectorize a single imported class-code tile into one MVT vector tile.
// Runs inside a worker thread (see bin/render-worker.js); the orchestrator
// (bin/render.js) decides which tiles to process and when to recycle the worker.

import fs from 'node:fs/promises';
import path from 'node:path';

import svgPathToPolygons from 'svg-path-to-polygons';
import potrace from 'potrace-wasm';
import sharp from 'sharp';
import vtt from 'vtt';

import rewind from './rewind.js';
import * as config from '../config.js';

const { pathDataToPolys } = svgPathToPolygons;

export async function renderTile(z, x, y) {
	// load the imported class-code tile (class code = first channel, alpha = last)
	const { data, info } = await sharp(path.join(config.dir.raster, `${z}/${x}/${y}.png`))
		.raw()
		.toBuffer({ resolveWithObject: true });
	const stride = info.channels;
	const pixels = info.width * info.height;

	// scale factors from the source resolution to the 4096 MVT extent
	const sx = 4096 / info.width;
	const sy = 4096 / info.height;

	const vectortile = {
		version: 2,
		name: 'landcover-vectors',
		extent: 4096,
		features: [],
		keys: ['kind'],
		values: [],
	};

	for (let layer of config.layers) {
		// build a monochrome mask for this kind from the class codes
		// (0 = present, 0xff = absent); skip layers absent from this (sparse) tile
		let mask = null;
		for (let p = 0; p < pixels; p++) {
			const i = p * stride;
			if (data[i + stride - 1] === 0) continue; // nodata
			if (config.classifyCode(data[i]) !== layer) continue;
			if (!mask) mask = Buffer.alloc(pixels, 0xff);
			mask[p] = 0; // present
		}
		if (!mask) continue;

		// extend 10 pixels, get buffer and metadata
		const { data: edata, info: einfo } = await sharp(mask, {
			raw: { width: info.width, height: info.height, channels: 1 },
		})
			.extend({ top: 10, left: 10, right: 10, bottom: 10, extendWith: 'copy' })
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });

		// vectorize with potrace-wasm
		const vectors = await potrace.loadFromImageData(edata, einfo.width, einfo.height, {
			pathonly: true,
			turdsize: 2,
			transform: false,
		});

		if (vectors.length === 0) continue;

		// add layer to values
		vectortile.values.push(layer);

		for (const vector of vectors) {
			// turn vector paths into polygons
			const polygon = pathDataToPolys(vector);

			// turn polygons into geometry
			const geometry = polygon
				.map((r) => {
					// clip vector by extend
					return r.map((c) => {
						c[0] = Math.min(einfo.width, Math.max(0, c[0] - 10));
						c[1] = Math.min(einfo.height, Math.max(0, c[1] - 10));
						return c;
					});
				})
				.map((r) => {
					// scale and round
					return r
						.map((c) => {
							c[0] = Math.round(c[0] * sx);
							c[1] = Math.round(c[1] * sy);
							return c;
						})
						.filter((c, i, a) => {
							// filter double coordinates
							return i === 0 || c[0] !== a[i - 1][0] || c[1] !== a[i - 1][1];
						})
						.filter((c, i, a) => {
							// filter "180° corners" aka pointless nodes on a straight line
							return (
								i === 0 ||
								i === a.length - 1 ||
								Math.atan2(c[1] - a[i - 1][1], c[0] - a[i - 1][1]) !==
									Math.atan2(a[i + 1][1] - c[1], a[i + 1][0] - c[0])
							);
						});
				});

			// enforce MVT 2.1 ring winding (exterior positive, holes negative)
			const rewound = rewind(geometry);

			vectortile.features.push({
				id: vectortile.features.length + 1,
				type: 3,
				geometry: rewound,
				properties: { kind: layer },
			});
		}
	}

	// nothing to write for tiles without any features (sparse coverage)
	if (vectortile.features.length === 0) return;

	const dest = path.join(config.dir.vector, `${z}/${x}/${y}.pbf`);
	const pbf = vtt.pack([vectortile]);
	await fs.mkdir(path.dirname(dest), { recursive: true });
	await fs.writeFile(dest, pbf);
}
