// shared configuration for the landcover-vectors pipeline

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// base directory holding all tile sets
export const tiledir = path.resolve(__dirname, 'tiles');

// landcover classes, in a single canonical order used by every step
export const layers = [
	'bare',
	'builtup',
	'cropland',
	'grassland',
	'mangroves',
	'moss',
	'shrubland',
	'snow',
	'treecover',
	'water',
	'wetland',
];

// ESA WorldCover class code → landcover class.
// The imported tiles carry the original class codes as pixel values (10, 20, …
// 100); 0 is nodata. See https://esa-worldcover.org/en/data-access for the legend.
export const codemap = {
	10: 'treecover',
	20: 'shrubland',
	30: 'grassland',
	40: 'cropland',
	50: 'builtup',
	60: 'bare',
	70: 'snow',
	80: 'water',
	90: 'wetland',
	95: 'mangroves',
	100: 'moss',
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
