// shared configuration for the landcover-vectors pipeline

const path = require("node:path");

// base directory holding all tile sets
const tiledir = path.resolve(__dirname, "tiles");

// landcover classes, in a single canonical order used by every step
const layers = [
	"bare",
	"builtup",
	"cropland",
	"grassland",
	"mangroves",
	"moss",
	"shrubland",
	"snow",
	"treecover",
	"water",
	"wetland",
];

// ESA Worldcover palette → landcover class.
// Pixels are classified by their blue byte; the two ambiguous blue values
// (0 and 160) are disambiguated by their green byte. A string maps a blue
// value directly; an object maps green bytes within that blue value.
const colormap = {
	34: "shrubland",
	76: "grassland",
	117: "mangroves",
	180: "bare",
	200: "water",
	240: "snow",
	255: "cropland",
	0: { 100: "treecover", 0: "builtup" },
	160: { 150: "wetland", 230: "moss" },
};

// classify a single RGB pixel, returns the landcover class or undefined
const classify = function (r, g, b) {
	const entry = colormap[b];
	return (typeof entry === "string") ? entry : (entry && entry[g]);
};

// shared tilejson for the vector tile sets
const vectorTileJSON = function () {
	return {
		"tilejson": "3.0.0",
		"attribution": "<a href=\"http://creativecommons.org/licenses/by/4.0/\">CC BY 4.0</a> <a href=\"https://esa-worldcover.org/en/data-access\">ESA WorldCover 2021</a>",
		"name": "Versatiles Landcover",
		"description": "Landcover vector tiles based on ESA Worldcover 2021, © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
		"version": "1.0.0",
		"tiles": ["{z}/{x}/{y}.pbf"],
		"type": "vector",
		"scheme": "xyz",
		"format": "pbf",
		"bounds": [-180, -85.0511287798066, 180, 85.0511287798066],
		"minzoom": 0,
		"maxzoom": 10,
		"vector_layers": [{
			"id": "landcover-vectors",
			"fields": { "kind": "String" },
			"minzoom": 0,
			"maxzoom": 10,
		}],
	};
};

module.exports = { tiledir, layers, colormap, classify, vectorTileJSON };
