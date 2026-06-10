// Import ESA WorldCover 2021 (v200) from AWS Open Data and cut a web-mercator
// XYZ raster pyramid. Replaces the old Terrascope WMTS download (now offline).
//
// Source: https://registry.opendata.aws/esa-worldcover-vito/ (s3://esa-worldcover)
// The source tiles are 3°×3° single-band GeoTIFFs in EPSG:4326 with the standard
// ESA WorldCover palette — the same colors the old PNG tiles used — so the
// downstream extract step works unchanged.
//
// The source GeoTIFFs are read anonymously over /vsicurl — no local mirror. They
// carry internal overviews, so cutting the pyramid only streams the resolution it
// needs (for the default zoom 0-6 that is roughly the ~160 m/px overview, a tiny
// fraction of the full 10 m data).
//
// Requires GDAL ≥ 3.11 (gdalbuildvrt + the `gdal raster tile` program) on PATH.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUCKET = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com';
const PREFIX = 'v200/2021/map/';

const tiledir = path.resolve(__dirname, '../tiles');
const workdir = path.join(tiledir, 'esa-worldcover'); // gdal raster tile XYZ output

// let GDAL read the public bucket anonymously over /vsicurl
const gdalEnv = {
	...process.env,
	AWS_NO_SIGN_REQUEST: 'YES',
	GDAL_DISABLE_READDIR_ON_OPEN: 'EMPTY_DIR',
	CPL_VSIL_CURL_ALLOWED_EXTENSIONS: '.tif',
	GDAL_HTTP_MAX_RETRY: '5',
	GDAL_HTTP_RETRY_DELAY: '2',
};

// run a child process, inheriting stdio, rejecting on non-zero exit
const run = (cmd, args) =>
	new Promise((resolve, reject) => {
		console.error('$ %s %s', cmd, args.join(' '));
		const child = spawn(cmd, args, { stdio: 'inherit', env: gdalEnv });
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
	});

// list every map GeoTIFF key in the bucket (paginated ListObjectsV2)
const listSourceKeys = async () => {
	const keys = [];
	let token;
	do {
		const url = new URL(BUCKET + '/');
		url.searchParams.set('list-type', '2');
		url.searchParams.set('prefix', PREFIX);
		if (token) url.searchParams.set('continuation-token', token);

		const res = await fetch(url);
		if (!res.ok) throw new Error(`S3 list failed: HTTP ${res.status}`);
		const xml = await res.text();

		for (const m of xml.matchAll(/<Key>([^<]+\.tif)<\/Key>/g)) keys.push(m[1]);

		const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
		token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && next ? next[1] : null;
	} while (token);
	return keys;
};

(async () => {
	const zoom = process.argv[2] || '0-6';

	await fs.mkdir(workdir, { recursive: true });

	// 1. enumerate source tiles → /vsicurl file list for gdalbuildvrt
	console.error('Listing source tiles from s3://esa-worldcover/%s …', PREFIX);
	const keys = await listSourceKeys();
	console.error('Found %d source tiles', keys.length);

	const listPath = path.join(workdir, 'sources.txt');
	await fs.writeFile(listPath, keys.map((k) => `/vsicurl/${BUCKET}/${k}`).join('\n') + '\n');

	// 2. virtual mosaic over the source tiles, read directly from S3 (EPSG:4326)
	const vrtPath = path.join(workdir, 'worldcover.vrt');
	await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listPath, vrtPath]);

	// 3. cut a web-mercator XYZ pyramid (the GDAL "gdal raster tile" program).
	//    "mode" resampling — for both the base zoom and the overviews — keeps the
	//    land-cover class codes pure when downsampling (no blended values between
	//    classes), so lower zoom levels are categorically correct without a
	//    separate compositing step.
	//
	//    --add-alpha de-palettes the source: each tile carries the raw class code
	//    as its (grayscale) pixel value plus an alpha channel for nodata, which the
	//    extract step classifies directly. --skip-blank omits all-nodata (ocean) tiles.
	//
	//    Tiles are 4096×4096 px to match the MVT extent (see render.js). A 4096 px
	//    tile at zoom Z has the same ground resolution as a 256 px tile at zoom Z+4,
	//    so e.g. zoom 6 tiles carry zoom-10 detail in a single, seam-free tile that
	//    the renderer vectorizes at native resolution (no upscaling).
	const [minZoom, maxZoom] = zoom.includes('-') ? zoom.split('-') : [zoom, zoom];
	await run('gdal', [
		['raster', 'tile'],
		['--convention', 'xyz'],
		['--tile-size', '4096'],
		['--min-zoom', minZoom],
		['--max-zoom', maxZoom],
		['-r', 'mode'],
		['--overview-resampling', 'mode'],
		'--add-alpha',
		'--skip-blank',
		'--resume',
		['--webviewer', 'none'],
		['--num-threads', 'ALL_CPUS'],
		['-i', vrtPath],
		['-o', workdir],
	].flat());

	console.error('Done. XYZ tiles written to %s', workdir);
})();
