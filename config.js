// shared configuration for the landcover-vectors pipeline

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// base directory for everything the pipeline downloads and generates
// (override with the DATA_DIR env var, e.g. to process into a scratch location)
export const datadir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, 'data');

// directories within the data folder, used across the pipeline
export const dir = {
	source: path.join(datadir, 'esa-worldcover-src'), // reduced-resolution raster mirror (download)
	work: path.join(datadir, 'polygons'), // per-tile polygon geometry (polygonize)
};

// files within the data folder
export const file = {
	geometry: path.join(datadir, 'landcover.fgb'), // merged polygon geometry (polygonize → tile)
	tiles: path.join(datadir, 'landcover.mbtiles'), // vector tile pyramid (tile → pack)
};

// ESA WorldCover class code → Shortbread `landcover.kind` (see issue #4).
// The polygonize step tags each polygon with its code; the tile step maps it to a
// kind. Several ESA classes merge (moss → bare, mangroves → wetland); 0 is nodata.
// Legend: https://esa-worldcover.org/en/data-access
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

// metadata embedded in the generated tileset
export const meta = {
	layer: 'landcover-vectors',
	name: 'Versatiles Landcover',
	attribution:
		'<a href="http://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a> <a href="https://esa-worldcover.org/en/data-access">ESA WorldCover 2021</a>',
	description:
		'Landcover vector tiles based on ESA Worldcover 2021, © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
};
