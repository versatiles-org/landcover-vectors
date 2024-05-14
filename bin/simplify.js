
const fs = require("node:fs/promises");
const path = require("node:path");

const vtt = require("vtt");

const visvalingam = require("../lib/visvalingam");
const exists = require("../lib/exists");

const targetSize = 1e5; // 100kb

const simplify = async function simplify(src){

	const t = Date.now();

	const buf = await fs.readFile(src);

	// no need to simplify small tiles
	if (buf.length < (targetSize/2)) {
		console.log("%s — Ignored %skb", path.relative(process.cwd(), src), (buf.length/1024).toFixed(1));
		return buf;
	};

	const factor = Math.min(0.75, targetSize / buf.length);

	// unpack vectortile
	const vectortile = vtt.unpack(buf);

	// iterate layers
	for (let layer of vectortile) {

		// iterate features
		for (let feature of layer.features) {

			// FIXME check if polygon

			// iterate polylines
			feature.geometry = feature.geometry.filter(polygon=>{
				return polygon.length > 16;
			}).map(polygon=>{ // simplify with edge-safe visvalingam
				return visvalingam(polygon, Math.max(16,Math.round(polygon.length * factor)));
			}).filter(polygon=>{ // remove empty polygons
				return (polygon.length);
			});

		};

	};

	const pbf = vtt.pack(vectortile);

	console.log("%s — Reduced %skb → %skb (%s%%) in %ss", path.relative(process.cwd(), src), (buf.length/1024).toFixed(1), (pbf.length/1024).toFixed(1), (100-(pbf.length/buf.length)*100).toFixed(1), ((Date.now()-t)/1000).toFixed(2));

	return pbf;

};

if (require.main === module) (async ()=>{

	let z1 = parseInt((process.argv[2]||"8"),10);
	for (let z = 0; z <= z1; z++) {
		for (let x = 0; x < Math.pow(2,z); x++) {
			// prepare dir
			await fs.mkdir(path.resolve(__dirname, `../tiles/vectortiles-simplified/${z}/${x}`), { recursive: true });
			for (let y = 0; y < Math.pow(2,z); y++) {

				const src = path.resolve(__dirname, `../tiles/vectortiles/${z}/${x}/${y}.pbf`);
				const dest = path.resolve(__dirname, `../tiles/vectortiles-simplified/${z}/${x}/${y}.pbf`);

				// skip if exists
				if (await exists(dest)) continue;

				// simplify tile
				await fs.writeFile(dest, await simplify(src));

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
