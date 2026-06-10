// shared configuration for the landcover-vectors pipeline

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// base directory holding all tile sets
export const tiledir = path.resolve(__dirname, 'tiles');

// landcover classes (the `kind` values), in a single canonical order used by
// every step. These reuse the proposed Shortbread `landcover` layer vocabulary
// so styling transitions seamlessly at the z6→z7 seam (see issue #4).
export const layers = ['bare', 'farmland', 'forest', 'glacier', 'grass', 'scrub', 'urban', 'water', 'wetland'];

// ESA WorldCover class code → Shortbread `landcover.kind`.
// The imported tiles carry the original class codes as pixel values (10, 20, …
// 100); 0 is nodata. See https://esa-worldcover.org/en/data-access for the legend
// and https://github.com/shortbread-tiles/shortbread-docs/issues/144 for the
// target vocabulary. Note ESA's moss → bare and mangroves → wetland are merged.
export const codemap = {
	10: 'forest', // tree cover
	20: 'scrub', // shrubland
	30: 'grass', // grassland
	40: 'farmland', // cropland
	50: 'urban', // built-up
	60: 'bare', // bare / sparse vegetation
	70: 'glacier', // snow and ice
	80: 'water', // permanent water bodies
	90: 'wetland', // herbaceous wetland
	95: 'wetland', // mangroves
	100: 'bare', // moss and lichen
};

// classify a single pixel by its class code, returns the landcover class or undefined
export const classifyCode = function (code) {
	return codemap[code];
};

// shared tilejson for the vector tile sets
export const vectorTileJSON = function () {
	return {
		tilejson: '3.0.0',
		attribution:
			'<a href="http://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover 2021</a>',
		name: 'Versatiles Landcover',
		description:
			'Landcover vector tiles based on ESA Worldcover 2021, © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
		version: '1.0.0',
		tiles: ['{z}/{x}/{y}.pbf'],
		type: 'vector',
		scheme: 'xyz',
		format: 'pbf',
		bounds: [-180, -85.0511287798066, 180, 85.0511287798066],
		minzoom: 0,
		maxzoom: 6,
		vector_layers: [
			{
				id: 'landcover-vectors',
				fields: { kind: 'String' },
				minzoom: 0,
				maxzoom: 6,
			},
		],
	};
};
