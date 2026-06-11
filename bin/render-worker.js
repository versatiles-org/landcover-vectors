// Worker thread: vectorizes one tile per message and reports its memory so the
// pool (bin/render.js) can recycle it — which bounds the potrace-wasm leak.

import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';

import { renderTile } from '../lib/render-tile.js';

// each worker is a single core; don't let libvips spawn its own thread pool on top
sharp.concurrency(1);

parentPort.on('message', async (task) => {
	try {
		await renderTile(task.z, task.x, task.y);
		parentPort.postMessage({ ok: true, rss: process.memoryUsage().rss });
	} catch (err) {
		parentPort.postMessage({ ok: false, task, error: err.message, rss: process.memoryUsage().rss });
	}
});
