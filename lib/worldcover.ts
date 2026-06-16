// Shared network + GDAL helpers for importing ESA WorldCover 2021 (v200) from AWS
// Open Data. Source: https://registry.opendata.aws/esa-worldcover-vito/ (s3://esa-worldcover)
// Data paths live in config.ts.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BUCKET = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com';
export const PREFIX = 'v200/2021/map/';

// environment for every GDAL child process
export const gdalEnv: NodeJS.ProcessEnv = {
	...process.env,
	// multithread GTiff block (de)compression on reads and writes, and any operation that
	// honours GDAL_NUM_THREADS (warp, etc.) — applies to all gdal/ogr2ogr/gdal_*.py calls
	GDAL_NUM_THREADS: 'ALL_CPUS',
	// let GDAL read the public bucket anonymously over /vsicurl
	AWS_NO_SIGN_REQUEST: 'YES',
	GDAL_DISABLE_READDIR_ON_OPEN: 'EMPTY_DIR',
	CPL_VSIL_CURL_ALLOWED_EXTENSIONS: '.tif',
	GDAL_HTTP_MAX_RETRY: '5',
	GDAL_HTTP_RETRY_DELAY: '2',
};

// A command argument: a single token (string or number), or a group of tokens (e.g. a flag and
// its value) kept together at the call site for readability. Numbers are stringified and groups
// are flattened one level before spawning, so `run('gdal', ['raster', 'sieve'],
// ['--size-threshold', 13], '-i', src, '-o', dst)` and the equivalent flat string array both work.
export type Arg = string | number | (string | number)[];

// flatten one level of grouping and stringify every token into a plain argv array
function toArgv(args: Arg[]): string[] {
	return args.flat().map(String);
}

// run a child process, inheriting stdio, rejecting on non-zero exit
export function run(cmd: string, ...args: Arg[]): Promise<void> {
	const argv = toArgv(args);
	return new Promise<void>((resolve, reject) => {
		console.error('$ %s %s', cmd, argv.join(' '));
		const child = spawn(cmd, argv, { stdio: 'inherit', env: gdalEnv });
		child.on('error', reject);
		child.on('exit', (code, signal) => (code === 0 ? resolve() : reject(new Error(exitMessage(cmd, code, signal)))));
	});
}

// run a child process quietly, capturing stderr for the error message
export function runQuiet(cmd: string, ...args: Arg[]): Promise<void> {
	const argv = toArgv(args);
	return new Promise<void>((resolve, reject) => {
		const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'], env: gdalEnv });
		let stderr = '';
		child.stderr?.on('data', (d) => (stderr += d));
		child.on('error', reject);
		child.on('exit', (code, signal) =>
			code === 0 ? resolve() : reject(new Error(stderr.trim() || exitMessage(cmd, code, signal))),
		);
	});
}

// run a child process quietly, resolving with its captured stdout (stderr feeds error messages)
export function runCapture(cmd: string, ...args: Arg[]): Promise<string> {
	const argv = toArgv(args);
	return new Promise<string>((resolve, reject) => {
		const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: gdalEnv });
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d) => (stdout += d));
		child.stderr?.on('data', (d) => (stderr += d));
		child.on('error', reject);
		child.on('exit', (code, signal) =>
			code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || exitMessage(cmd, code, signal))),
		);
	});
}

// the set of distinct band values present in a single-band Byte raster, via gdalinfo's histogram
// (256 buckets spanning -0.5..255.5, so bucket i counts pixels of value i). Reads the whole raster
// once. NB: gdalinfo -hist writes a `<tif>.aux.xml` PAM sidecar next to the file.
export async function presentValues(tif: string): Promise<Set<number>> {
	const info = JSON.parse(await runCapture('gdalinfo', ['-json', '-hist'], tif));
	const buckets: number[] = info.bands?.[0]?.histogram?.buckets ?? [];
	const present = new Set<number>();
	for (let v = 0; v < buckets.length; v++) if (buckets[v] > 0) present.add(v);
	return present;
}

// describe a non-zero child exit; a null code means it was terminated by a signal
// (e.g. SIGKILL from the OOM killer)
function exitMessage(cmd: string, code: number | null, signal: NodeJS.Signals | null): string {
	if (signal) return `${cmd} was killed by ${signal}${signal === 'SIGKILL' ? ' (out of memory?)' : ''}`;
	return `${cmd} exited with code ${code}`;
}

// resolve true if `cmd` can be spawned (i.e. is on PATH), false otherwise
export function commandExists(cmd: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const child = spawn(cmd, ['--version'], { stdio: 'ignore', env: gdalEnv });
		child.on('error', () => resolve(false)); // ENOENT: not on PATH
		child.on('exit', () => resolve(true));
	});
}

// verify every command is on PATH, reporting all that are missing at once
export async function requireCommands(cmds: string[]): Promise<void> {
	const present = await Promise.all(cmds.map(commandExists));
	const missing = cmds.filter((_, i) => !present[i]);
	if (missing.length) throw new Error(`required command(s) not found on PATH: ${missing.join(', ')}`);
}

// Let `produce` write the result to a temp file (".tmp-"-prefixed, in the same folder),
// then atomically rename it onto `out`. So a partial file from a crashed/killed command
// never appears as a finished result (which the skip-if-exists logic would wrongly reuse).
export async function atomic(out: string, produce: (tmp: string) => Promise<void>): Promise<void> {
	const tmp = path.join(path.dirname(out), '.tmp-' + path.basename(out));
	await fs.rm(tmp, { force: true }); // clear any leftover temp from a previous failed run
	try {
		await produce(tmp);
		await fs.rename(tmp, out); // atomic on the same filesystem
	} catch (err) {
		await fs.rm(tmp, { force: true }); // never leave a partial temp behind
		throw err;
	}
}

// run worker over items with bounded concurrency
export async function pMap<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void> | void,
): Promise<void> {
	let i = 0;
	async function next(): Promise<void> {
		while (i < items.length) await worker(items[i++]);
	}
	await Promise.all(Array.from({ length: Math.min(Math.floor(concurrency), items.length) }, next));
}

// list every map GeoTIFF key in the bucket (paginated ListObjectsV2)
export async function listSourceKeys(): Promise<string[]> {
	const keys: string[] = [];
	let token: string | null = null;
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
