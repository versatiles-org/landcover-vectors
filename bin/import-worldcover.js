// Import ESA WorldCover 2021 (v200) from AWS Open Data and cut a web-mercator
// XYZ raster pyramid. Replaces the old Terrascope WMTS download (now offline).
//
// Source: https://registry.opendata.aws/esa-worldcover-vito/ (s3://esa-worldcover)
// The source tiles are 3°×3° single-band class-code GeoTIFFs in EPSG:4326.
//
// Each source tile is downloaded once to a local mirror at 1/FACTOR resolution by
// reading its matching internal overview, so only a tiny fraction of the 10 m data
// is transferred (~tens of MB total instead of 124 GB). The reduced tiles stay in
// native EPSG:4326; the single reproject + resample to web-mercator happens locally
// in the tiling step. Processing from local disk avoids the flaky, many-request
// /vsicurl tiling. FACTOR=8 keeps full detail for the default zoom 0-6 (with
// headroom for z7). Each download is retried, written atomically, and skipped if
// already present, so the import is robust and resumable.
//
// Requires GDAL ≥ 3.11 (gdal_translate, gdalbuildvrt, `gdal raster tile`) on PATH.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUCKET = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com';
const PREFIX = 'v200/2021/map/';

const FACTOR = 8; // downsample each source tile by this factor on download
const PERCENT = `${100 / FACTOR}%`; // gdal_translate -outsize argument
const DOWNLOAD_CONCURRENCY = 8;
const DOWNLOAD_RETRIES = 3;

const tiledir = path.resolve(__dirname, '../tiles');
const srcdir = path.join(tiledir, 'esa-worldcover-src'); // local reduced-resolution mirror (EPSG:4326)
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

// run a child process quietly, capturing stderr for the error message
const runQuiet = (cmd, args) =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: gdalEnv });
		let stderr = '';
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit code ${code}`))));
	});

// run worker over items with bounded concurrency
const pMap = async (items, concurrency, worker) => {
	let i = 0;
	const next = async () => {
		while (i < items.length) await worker(items[i++]);
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
};

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

// download one source tile to the local mirror at reduced resolution, skipping if
// already present. Reads only the matching overview (small transfer), keeps the
// native projection and class codes (-r nearest), and writes atomically.
const reduce = async (key) => {
	const dest = path.join(srcdir, path.basename(key));
	if (existsSync(dest)) return false; // an existing file is complete (atomic rename below)

	const tmp = dest + '.part';
	const src = `/vsicurl/${BUCKET}/${key}`;
	for (let attempt = 1; ; attempt++) {
		try {
			await runQuiet('gdal_translate', [
				'-q',
				'-r',
				'nearest',
				'-outsize',
				PERCENT,
				PERCENT,
				'-of',
				'GTiff',
				'-co',
				'COMPRESS=DEFLATE',
				'-co',
				'TILED=YES',
				src,
				tmp,
			]);
			await fs.rename(tmp, dest); // atomic: only a complete file appears as dest
			return true;
		} catch (err) {
			await fs.rm(tmp, { force: true }); // never leave a partial file behind
			if (attempt >= DOWNLOAD_RETRIES) throw new Error(`reduce ${key} failed: ${err.message}`);
			await sleep(attempt * 1000);
		}
	}
};

(async () => {
	const zoom = process.argv[2] || '0-6';

	await fs.mkdir(srcdir, { recursive: true });
	await fs.mkdir(workdir, { recursive: true });

	// 1. enumerate source tiles
	console.error('Listing source tiles from s3://esa-worldcover/%s …', PREFIX);
	const keys = await listSourceKeys();
	console.error('Found %d source tiles', keys.length);

	// 2. download reduced-resolution local copies (parallel, resumable)
	let done = 0;
	let fetched = 0;
	await pMap(keys, DOWNLOAD_CONCURRENCY, async (key) => {
		if (await reduce(key)) fetched++;
		done++;
		if (done % 25 === 0 || done === keys.length) {
			process.stderr.write(`  ${done}/${keys.length} tiles (${fetched} downloaded, ${done - fetched} cached)\r`);
		}
	});
	process.stderr.write('\n');

	// 3. virtual mosaic over the local reduced tiles (EPSG:4326). Rebuilt every run
	//    so a resumed/expanded download is always fully included (cheap on local disk).
	const listPath = path.join(srcdir, 'sources.txt');
	await fs.writeFile(listPath, keys.map((k) => path.join(srcdir, path.basename(k))).join('\n') + '\n');
	const vrtPath = path.join(srcdir, 'worldcover.vrt');
	await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listPath, vrtPath]);

	// 4. cut a web-mercator XYZ pyramid locally (the GDAL "gdal raster tile" program).
	//    "mode" resampling — for both the base zoom and the overviews — keeps the
	//    land-cover class codes pure when downsampling (no blended values between
	//    classes), so lower zoom levels are categorically correct without a
	//    separate compositing step.
	//
	//    --add-alpha de-palettes the source: each tile carries the raw class code
	//    as its (grayscale) pixel value plus an alpha channel for nodata, which the
	//    render step classifies directly. --skip-blank omits all-nodata (ocean) tiles.
	//
	//    Tiles are 4096×4096 px to match the MVT extent (see render.js). A 4096 px
	//    tile at zoom Z has the same ground resolution as a 256 px tile at zoom Z+4,
	//    so e.g. zoom 6 tiles carry zoom-10 detail in a single, seam-free tile that
	//    the renderer vectorizes at native resolution (no upscaling).
	const [minZoom, maxZoom] = zoom.includes('-') ? zoom.split('-') : [zoom, zoom];
	await run(
		'gdal',
		[
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
		].flat(),
	);

	console.error('Done. XYZ tiles written to %s', workdir);
})();
