// vectorize tiles and combine into vectortiles
// warning: potrace-wasm appears to leak memory
// FIXME: put into worker, hope it fixes the memory leak

const fs = require("node:fs/promises");
const path = require("node:path");

const pathDataToPolys = require("svg-path-to-polygons").pathDataToPolys;
const potrace = require("potrace-wasm");
const sharp = require("sharp");
const vtt = require("vtt");

const exists = require("../lib/exists");

const render = async function render(z,x,y){

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

		// hint garbage collection
		delete img;

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

			for (vector of vectors) {

				// turn vector paths into polygons
				const polygon = pathDataToPolys(vector);

				// turn polygons into geometry
				const geometry = polygon.map(r=>{ // clip vector by extend
					return r.map(c=>{
						c[0] = Math.min(info.width, Math.max(0,c[0]-10));
						c[1] = Math.min(info.height, Math.max(0,c[1]-10));
						return c;
					});
				}).map(r=>{ // scale and round
					return r.map(c=>{ // scale to 4096×4096 and round to integers
						c[0] = Math.round(c[0]*sx);
						c[1] = Math.round(c[1]*sy);
						return c;
					}).filter((c,i,a)=>{ // filter double coordinates
						return (i === 0 || c[0] !== a[i-1][0] || c[1] !== a[i-1][1]);
					}).filter((c,i,a)=>{ // filter "180° corners" aka pointless nodes on a straight line
						return i===0 || i===a.length-1 || Math.atan2(c[1] - a[i-1][1], c[0] - a[i-1][1]) !== Math.atan2(a[i+1][1] - c[1], a[i+1][0] - c[0]);
					}); // FIXME apply simplification directly?
				});

				// hint garbage collection
				delete polygon;

				// add feature to vectortile
				vectortile.features.push({
					id: (vectortile.features.length+1),
					type: 3,
					geometry: geometry,
					properties: {
						kind: layer, // layer type
					},
				});

			};

			// hint garbage collection
			delete vectors;

		};

	};

	// pack tile, empty layer if no features
	const pbf = vtt.pack((vectortile.features.length > 0) ? [vectortile] : []);

	// hint garbage collection
	delete vectortile;

	// write tile
	await fs.writeFile(dest, pbf);

	// hint garbage collection
	delete pbf;

	// status
	console.log("Rendered %s/%s/%s.pbf in %ss (%skb)", z, x, y, ((Date.now()-t)/1000).toFixed(2), (pbf.length/1024).toFixed(2));

	return;

};

if (require.main === module) (async ()=>{
	let z1 = parseInt((process.argv[2]||"8"),10);
	for (let z = 0; z <= z1; z++) {
		for (let x = 0; x < Math.pow(2,z); x++) {
			await fs.mkdir(path.resolve(__dirname,`../tiles/vectortiles/${z}/${x}`), { recursive: true });
			for (let y = 0; y < Math.pow(2,z); y++) {
				await render(z,x,y);
			};
		};
	};

	// write tilejson
	await fs.writeFile(path.resolve(__dirname,`../tiles/vectortiles-simplified/tile.json`), {
		"tilejson": "3.0.0",
		"attribution": "<a href=\"http://creativecommons.org/licenses/by/4.0/\">CC BY 4.0</a> <a href=\"https://esa-worldcover.org/en/data-access\">ESA WorldCover 2021</a>",
		"name": "Versatiles Landcover",
		"description": "Landcover vector tiles based on ESA Worldcover 2021, © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
		"version": "1.0.0",
		"tiles": ["{z}/{x}/{y}.pbf"],
		"type": "vector",
		"scheme": "xyz",
		"format": "pbf",
		"bounds": [ -180, -85.0511287798066, 180, 85.0511287798066 ],
		"minzoom": 0,
		"maxzoom": 10,
		"vector_layers":[{
			"id": "landcover-vectors",
			"fields": { "kind": "String" },
			"minzoom": 0,
			"maxzoom": 10,
		}]
	});
})();

