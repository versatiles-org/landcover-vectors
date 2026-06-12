// shared configuration for the landcover-vectors pipeline

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// base directory for everything the pipeline downloads and generates
// (override with the DATA_DIR env var, e.g. to process into a scratch location)
export const datadir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, 'data');

// the world raster is rendered in EPSG:3857 (Web Mercator) at SIZE×SIZE pixels covering
// the standard Mercator square (±MERC metres ≈ ±85.0511°). SIZE = 2^15 = 32768 is exactly
// zoom-7 tile resolution (128 tiles × 256 px), so the grid aligns to tile boundaries and
// the pixels are square.
export const SIZE = 32768;
export const MERC = 20037508.342789244;

// directories within the data folder, used across the pipeline
export const dir = {
	source: path.join(datadir, 'esa-worldcover-src'), // reduced-resolution raster mirror (download)
	channels: path.join(datadir, 'channels'), // per-class membership masks + blurred masks
};

// files within the data folder
export const file = {
	warped: path.join(datadir, 'worldcover-3857.tif'), // reprojected world raster (reproject → channels)
	code: path.join(datadir, 'landcover-code.tif'), // single-band argmax codes 10..100 (argmax → polygonize)
	geometry: path.join(datadir, 'landcover.fgb'), // polygon geometry, EPSG:4326 (polygonize → tile)
	tiles: path.join(datadir, 'landcover.mbtiles'), // vector tile pyramid (tile → pack)
};

// The 10 channels of the blur/argmax stage, in order. Channel i (1-based) carries
// code i*10; after blurring all ten masks, each pixel is assigned the code of the
// channel with the highest value (argmax). `calc` is the gdal_calc.py expression over
// band A of the reprojected ESA raster that builds the 0/255 membership mask, and
// `kind` is the Shortbread landcover kind the code maps to in the final tiles.
//
// Several ESA classes merge (moss → bare, mangroves → wetland). The last channel is
// "no data / no landcover" (ESA 0); its code 100 is dropped before tiling.
// Legend: https://esa-worldcover.org/en/data-access
export const channels = [
	{ code: 10, kind: 'forest', calc: '255*(A==10)' }, // tree cover
	{ code: 20, kind: 'scrub', calc: '255*(A==20)' }, // shrubland
	{ code: 30, kind: 'grass', calc: '255*(A==30)' }, // grassland
	{ code: 40, kind: 'farmland', calc: '255*(A==40)' }, // cropland
	{ code: 50, kind: 'urban', calc: '255*(A==50)' }, // built-up
	{ code: 60, kind: 'bare', calc: '255*((A==60)|(A==100))' }, // bare/sparse vegetation + moss and lichen
	{ code: 70, kind: 'glacier', calc: '255*(A==70)' }, // snow and ice
	{ code: 80, kind: 'water', calc: '255*(A==80)' }, // permanent water bodies
	{ code: 90, kind: 'wetland', calc: '255*((A==90)|(A==95))' }, // herbaceous wetland + mangroves
	{ code: 100, kind: null, calc: '255*(A==0)' }, // no data / no landcover (dropped before tiling)
];

// metadata embedded in the generated tileset
export const meta = {
	layer: 'landcover-vectors',
	name: 'Versatiles Landcover',
	attribution:
		'<a href="http://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover 2021</a>',
	description:
		'Landcover vector tiles based on ESA Worldcover 2021, © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
};
