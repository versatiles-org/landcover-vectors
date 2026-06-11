// Render imported raster tiles into MVT vector tiles, in parallel.
//
// Scans every zoom level up front, skips tiles whose output already exists, and
// feeds the remaining work to a pool of worker threads (one per core, see
// bin/render-worker.js). A single progress bar covers all the tiles that actually
// need rendering. Each worker reports its memory after every tile so the pool can
// recycle it once it grows too large — which bounds the known potrace-wasm leak.
//
// Tuning via env: RENDER_WORKERS (default cores-1), RENDER_MAX_RSS_MB (default 1024).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

import exists from '../lib/exists.js';
import { listZoomTiles } from '../lib/tiles.js';
import { progress } from '../lib/progress.js';
import * as config from '../config.js';

const WORKERS = parseInt(process.env.RENDER_WORKERS, 10) || Math.max(1, os.availableParallelism() - 1);
const MAX_RSS = (parseInt(process.env.RENDER_MAX_RSS_MB, 10) || 1024) * 1024 * 1024;
const MAX_RETRIES = 2; // re-queue a tile this many times if its worker crashes

const workerURL = new URL('./render-worker.js', import.meta.url);

// run all tasks through a pool of recycling worker threads
function renderPool(tasks) {
	return new Promise((resolve) => {
		const bar = progress(tasks.length, 'Rendering');
		let next = 0;
		let active = 0;
		let failures = 0;

		function assign(w) {
			if (next >= tasks.length) return retire(w);
			const task = tasks[next++];
			w.current = task;
			w.postMessage(task);
		}

		function retire(w) {
			w.dead = true;
			active--;
			w.terminate();
			if (active === 0) {
				bar.done();
				if (failures) console.error('%d tile(s) failed — re-run to retry', failures);
				resolve();
			}
		}

		function recycle(w) {
			w.dead = true;
			active--;
			w.terminate();
			spawn(); // fresh worker reclaims the leaked WASM heap and picks up the next task
		}

		function spawn() {
			const w = new Worker(workerURL);
			w.current = null;
			w.dead = false;
			active++;

			w.on('message', (msg) => {
				bar.tick();
				if (!msg.ok) {
					failures++;
					process.stderr.write(`\n  failed ${msg.task.z}/${msg.task.x}/${msg.task.y}: ${msg.error}\n`);
				}
				w.current = null;
				if (msg.rss > MAX_RSS) recycle(w);
				else assign(w);
			});

			w.on('error', (err) => {
				// uncaught crash (e.g. a WASM abort): re-queue its tile and replace it
				if (w.dead) return;
				w.dead = true;
				active--;
				const task = w.current;
				if (task) {
					task.attempts = (task.attempts || 0) + 1;
					if (task.attempts <= MAX_RETRIES) {
						tasks.push(task); // retry later
					} else {
						failures++;
						bar.tick();
						process.stderr.write(`\n  giving up on ${task.z}/${task.x}/${task.y} after ${MAX_RETRIES} crashes\n`);
					}
				}
				process.stderr.write(`\n  worker crashed (${err.message}); restarting\n`);
				spawn();
			});

			assign(w);
		}

		for (let i = 0; i < Math.min(WORKERS, tasks.length); i++) spawn();
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const z1 = parseInt(process.argv[2] || '6', 10);

	// scan every zoom up front; keep only tiles whose output doesn't exist yet
	console.error('Scanning tiles …');
	const tasks = [];
	for (let z = 0; z <= z1; z++) {
		for (const { x, y } of await listZoomTiles(config.dir.raster, z)) {
			const dest = path.join(config.dir.vector, `${z}/${x}/${y}.pbf`);
			if (!(await exists(dest))) tasks.push({ z, x, y });
		}
	}
	console.error('%d tiles to render (%d workers)', tasks.length, WORKERS);

	if (tasks.length > 0) await renderPool(tasks);

	// write tilejson
	await fs.mkdir(config.dir.simplified, { recursive: true });
	await fs.writeFile(
		path.join(config.dir.simplified, 'tile.json'),
		JSON.stringify(config.vectorTileJSON(), null, '\t'),
	);
}
