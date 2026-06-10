// Import ESA WorldCover 2021 (v200) from AWS Open Data and cut a web-mercator
// XYZ raster pyramid. Replaces the old Terrascope WMTS download (now offline).
//
// Source: https://registry.opendata.aws/esa-worldcover-vito/ (s3://esa-worldcover)
// The source tiles are 3°×3° single-band GeoTIFFs in EPSG:4326 with the standard
// ESA WorldCover palette — the same colors the old PNG tiles used — so the
// downstream extract step works unchanged.
//
// The source GeoTIFFs are downloaded once to a local mirror and then tiled from
// local disk (much faster than streaming each block over /vsicurl during tiling).
//
// Requires GDAL (gdalbuildvrt + gdal2tiles.py) on PATH.

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUCKET = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com';
const PREFIX = 'v200/2021/map/';

const DOWNLOAD_CONCURRENCY = 8;
const DOWNLOAD_RETRIES = 3;

const tiledir = path.resolve(__dirname, '../tiles');
const srcdir = path.join(tiledir, 'esa-worldcover-src'); // local mirror of source GeoTIFFs
const workdir = path.join(tiledir, 'esa-worldcover'); // gdal2tiles XYZ output

// run a child process, inheriting stdio, rejecting on non-zero exit
const run = (cmd, args) =>
	new Promise((resolve, reject) => {
		console.error('$ %s %s', cmd, args.join(' '));
		const child = spawn(cmd, args, { stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
	});

// run worker over items with bounded concurrency
const pMap = async (items, concurrency, worker) => {
	let i = 0;
	const next = async () => {
		while (i < items.length) {
			const idx = i++;
			await worker(items[idx], idx);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
};

// list every map GeoTIFF in the bucket (paginated ListObjectsV2), with sizes
const listSources = async () => {
	const sources = [];
	let token;
	do {
		const url = new URL(BUCKET + '/');
		url.searchParams.set('list-type', '2');
		url.searchParams.set('prefix', PREFIX);
		if (token) url.searchParams.set('continuation-token', token);

		const res = await fetch(url);
		if (!res.ok) throw new Error(`S3 list failed: HTTP ${res.status}`);
		const xml = await res.text();

		for (const block of xml.matchAll(/<Contents>(.*?)<\/Contents>/gs)) {
			const key = block[1].match(/<Key>([^<]+\.tif)<\/Key>/);
			const size = block[1].match(/<Size>(\d+)<\/Size>/);
			if (key && size) sources.push({ key: key[1], size: Number(size[1]) });
		}

		const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
		token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && next ? next[1] : null;
	} while (token);
	return sources;
};

// download one source to the local mirror, skipping if already complete
const download = async ({ key, size }) => {
	const dest = path.join(srcdir, path.basename(key));

	// skip if a complete copy already exists (resumable)
	try {
		const st = await fs.stat(dest);
		if (st.size === size) return false;
	} catch {
		/* not downloaded yet */
	}

	const tmp = dest + '.part';
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(`${BUCKET}/${key}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
			await fs.rename(tmp, dest); // atomic: only a fully written file appears
			return true;
		} catch (err) {
			if (attempt >= DOWNLOAD_RETRIES) throw new Error(`download ${key} failed: ${err.message}`);
			await sleep(attempt * 1000);
		}
	}
};

(async () => {
	const zoom = process.argv[2] || '0-10';

	await fs.mkdir(srcdir, { recursive: true });
	await fs.mkdir(workdir, { recursive: true });

	// 1. enumerate source tiles
	console.error('Listing source tiles from s3://esa-worldcover/%s …', PREFIX);
	const sources = await listSources();
	console.error('Found %d source tiles', sources.length);

	// 2. download them to the local mirror (parallel, resumable)
	let done = 0;
	let fetched = 0;
	await pMap(sources, DOWNLOAD_CONCURRENCY, async (source) => {
		if (await download(source)) fetched++;
		done++;
		if (done % 25 === 0 || done === sources.length) {
			process.stderr.write(`  ${done}/${sources.length} tiles (${fetched} downloaded, ${done - fetched} cached)\r`);
		}
	});
	process.stderr.write('\n');

	// 3. virtual mosaic over the local source tiles (EPSG:4326)
	const listPath = path.join(srcdir, 'sources.txt');
	await fs.writeFile(listPath, sources.map((s) => path.join(srcdir, path.basename(s.key))).join('\n') + '\n');

	const vrtPath = path.join(srcdir, 'worldcover.vrt');
	await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listPath, vrtPath]);

	// 4. cut a web-mercator XYZ pyramid. "mode" resampling keeps land-cover
	//    classes pure when downsampling (no blended colors between classes), so
	//    lower zoom levels are categorically correct without a separate compositing step.
	await run('gdal2tiles.py', [
		'--xyz',
		'-z',
		zoom,
		'-r',
		'mode',
		'-w',
		'none',
		'--processes=' + Math.max(1, os.cpus().length - 1),
		'--resume',
		vrtPath,
		workdir,
	]);

	console.error('Done. XYZ tiles written to %s', workdir);
})();
