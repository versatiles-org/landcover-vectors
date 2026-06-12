// Shared network + GDAL helpers for importing ESA WorldCover 2021 (v200) from AWS
// Open Data. Source: https://registry.opendata.aws/esa-worldcover-vito/ (s3://esa-worldcover)
// Used by bin/download-worldcover.js (network) and bin/tile-worldcover.js (local).
// Data paths live in config.js.

import { spawn } from 'node:child_process';

export const BUCKET = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com';
export const PREFIX = 'v200/2021/map/';

// let GDAL read the public bucket anonymously over /vsicurl
export const gdalEnv = {
	...process.env,
	AWS_NO_SIGN_REQUEST: 'YES',
	GDAL_DISABLE_READDIR_ON_OPEN: 'EMPTY_DIR',
	CPL_VSIL_CURL_ALLOWED_EXTENSIONS: '.tif',
	GDAL_HTTP_MAX_RETRY: '5',
	GDAL_HTTP_RETRY_DELAY: '2',
};

// run a child process, inheriting stdio, rejecting on non-zero exit
export function run(cmd, args) {
	return new Promise((resolve, reject) => {
		console.error('$ %s %s', cmd, args.join(' '));
		const child = spawn(cmd, args, { stdio: 'inherit', env: gdalEnv });
		child.on('error', reject);
		child.on('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(exitMessage(cmd, code, signal)))));
	});
}

// run a child process quietly, capturing stderr for the error message
export function runQuiet(cmd, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: gdalEnv });
		let stderr = '';
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', reject);
		child.on('exit', (code, signal) =>
			code === 0 ? resolve() : reject(new Error(stderr.trim() || exitMessage(cmd, code, signal))),
		);
	});
}

// describe a non-zero child exit; a null code means it was terminated by a signal
// (e.g. SIGKILL from the OOM killer)
function exitMessage(cmd, code, signal) {
	if (signal) return `${cmd} was killed by ${signal}${signal === 'SIGKILL' ? ' (out of memory?)' : ''}`;
	return `${cmd} exited with code ${code}`;
}

// resolve true if `cmd` can be spawned (i.e. is on PATH), false otherwise
export function commandExists(cmd) {
	return new Promise((resolve) => {
		const child = spawn(cmd, ['--version'], { stdio: 'ignore', env: gdalEnv });
		child.on('error', () => resolve(false)); // ENOENT: not on PATH
		child.on('exit', () => resolve(true));
	});
}

// run worker over items with bounded concurrency
export async function pMap(items, concurrency, worker) {
	let i = 0;
	async function next() {
		while (i < items.length) await worker(items[i++]);
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}

// list every map GeoTIFF key in the bucket (paginated ListObjectsV2)
export async function listSourceKeys() {
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
}
