// Download ESA Worldcover 2021 tiles from Terrascope WMTS (~5.2GB)
// Data is licensed http://creativecommons.org/licenses/by/4.0/
// See https://esa-worldcover.org/en/data-access

const phn = require("phn");
const fs = require("node:fs/promises");
const path = require("node:path");
const exists = require("../lib/exists");
const https = require("node:https");

(async()=>{

	const total = 1048576;
	let n = 0; // number downloaded
	let p = ""; // percentage string

	const date = new Date().toISOString().slice(0,10);
	const agent = new https.Agent({ keepAlive: true });

	for (let x = 0; x < 1024; x++) {
		await fs.mkdir(path.resolve(__dirname,`../tiles/esa-worldcover/10/${x}`), {recursive: true});

		for (let y = 0; y < 1024; y++) {

			const dest = path.resolve(__dirname,`../tiles/esa-worldcover/10/${x}/${y}.png`);

			let pn = ((++n/total)*100).toFixed(2);
			if (pn !== p) process.stderr.write(`  ${p=pn}% complete\r`);

			if (await exists(dest)) continue;

			try {

				const res = await phn({
					url: `https://services.terrascope.be/wmts/v2?layer=WORLDCOVER_2021_MAP&style=&tilematrixset=EPSG:3857&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/png&TileMatrix=EPSG:3857:10&TileCol=${x}&TileRow=${y}&TIME=${date}`,
					core: { agent },
					headers: { "user-agent": "Mozilla/5.0 (compatible; versatiles-landcover-vectors/1.0; +https://github.com/versatiles-org/landcover-vectors)" },
				});

				if (res.statusCode !== 200 || res.headers['content-type'] !== 'image/png') {
					console.error("Missing: %s", `10/${x}/${y}.png`);
					continue;
				}

				await fs.writeFile(dest, res.body);
				// console.error("Got: %s", `10/${x}/${y}.png`);

			} catch (err) {

				console.error("Error: %s — %s", `10/${x}/${y}.png`, err.toString());
				continue;

			};

		};
	};

	// write tilejson
	await fs.writeFile(path.resolve(__dirname,`../tiles/esa-worldcover/tile.json`), JSON.stringify({
		"tilejson": "3.0.0",
		"attribution": "<a href=\"http://creativecommons.org/licenses/by/4.0/\">CC BY 4.0</a> <a href=\"https://esa-worldcover.org/en/data-access\">ESA WorldCover 2021</a>",
		"name": "ESA Worldcover",
		"description": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
		"version": "2021.0.0",
		"tiles": ["{z}/{x}/{y}.png"],
		"type": "raster",
		"scheme": "xyz",
		"format": "png",
		"bounds": [ -180, -85.0511287798066, 180, 85.0511287798066 ],
		"minzoom": 10,
		"maxzoom": 10
	},0,"\t"));

	console.error(`Download 100% complete`);

})();