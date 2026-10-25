// The progress bar is the only feedback during an 11-hour build, so its accounting has to survive
// tick(n) jumps (a cached zoom ticks through in one call) and its ETA formatting has to stay readable.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { progress, fmtTime } from '../lib/progress.ts';

// run fn with stderr captured and forced into the non-TTY (one line per percent) mode
function capture(fn: () => void): string[] {
	const chunks: string[] = [];
	const origWrite = process.stderr.write;
	const origTTY = process.stderr.isTTY;
	process.stderr.isTTY = false;
	process.stderr.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		fn();
	} finally {
		process.stderr.write = origWrite;
		process.stderr.isTTY = origTTY;
	}
	return chunks;
}

describe('fmtTime', () => {
	test('seconds, minutes and hours', () => {
		assert.equal(fmtTime(0), '0s');
		assert.equal(fmtTime(5.4), '5s');
		assert.equal(fmtTime(59), '59s');
		assert.equal(fmtTime(60), '1m00s');
		assert.equal(fmtTime(61), '1m01s');
		assert.equal(fmtTime(3599), '59m59s');
		assert.equal(fmtTime(3600), '1h00m');
		assert.equal(fmtTime(7260), '2h01m');
	});

	test('an unknown or nonsensical duration is not rendered as a number', () => {
		for (const bad of [Infinity, NaN, -1]) assert.equal(fmtTime(bad), '--', String(bad));
	});
});

describe('progress', () => {
	test('reports every whole percent once when stderr is not a TTY', () => {
		const lines = capture(() => {
			const bar = progress(10, 'blocks');
			for (let i = 0; i < 10; i++) bar.tick();
		});
		assert.equal(lines.length, 11, 'the initial draw plus one line per 10 %');
		assert.match(lines[0], /^blocks\s+0% 0\/10 /); // the percentage is right-padded to three chars
		assert.match(lines.at(-1)!, /100% 10\/10 /);
	});

	test('a single tick(n) is accounted for as n items', () => {
		const lines = capture(() => {
			const bar = progress(10);
			bar.tick(5);
			bar.tick(5);
		});
		assert.match(lines.at(-2)!, / 50% 5\/10 /);
		assert.match(lines.at(-1)!, /100% 10\/10 /);
	});

	test('done() fills the bar even if fewer ticks arrived', () => {
		const lines = capture(() => {
			const bar = progress(10);
			bar.tick();
			bar.done();
		});
		assert.match(lines.at(-1)!, /100% 10\/10 /);
	});

	test('setLabel prefixes later output', () => {
		const lines = capture(() => {
			const bar = progress(4);
			bar.setLabel('zoom 7/10');
			bar.tick();
		});
		assert.match(lines.at(-1)!, /^zoom 7\/10 /);
	});

	test('a zero total does not divide by zero', () => {
		const lines = capture(() => progress(0, 'nothing').done());
		assert.ok(
			lines.every((l) => l.includes('100%')),
			lines.join('|'),
		);
	});
});

describe("GDAL's own progress, shown as a bar", () => {
	test('counts the 2.5 % marks on the last line, after any prefix', async () => {
		const { gdalProgressSteps, GDAL_PROGRESS_STEPS } = await import('../lib/worldcover.ts');
		const done = '0...10...20...30...40...50...60...70...80...90...100 - done.\n';
		for (const [out, steps] of [
			['', 0],
			['Input file size is 4096, 4096\n', 0], // gdal_translate, before it starts
			['Input file size is 4096, 4096\n0', 0],
			['0...', 3],
			['0...10..', 6],
			['Creating output file that is 2048P x 2048L.\nProcessing g.tif [1/1] : 0...10...20', 8], // gdalwarp
			[done, GDAL_PROGRESS_STEPS],
			['Processing g.tif [1/1] : ' + done, GDAL_PROGRESS_STEPS],
		] as const)
			assert.equal(gdalProgressSteps(out), steps, JSON.stringify(out));
	});

	test('runProgress runs a real GDAL tool to the end', async (t) => {
		const { runProgress, runQuiet } = await import('../lib/worldcover.ts');
		const { skipWithout } = await import('./tools.ts');
		const skip = await skipWithout('gdal_translate');
		if (skip) return t.skip(skip);
		const fs = await import('node:fs/promises');
		const os = await import('node:os');
		const path = await import('node:path');
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-progress-'));
		try {
			const src = path.join(dir, 'in.tif');
			await runQuiet('gdal_create', ['-of', 'GTiff'], ['-ot', 'Byte'], ['-outsize', 512, 512], ['-burn', 7], src);
			const out = path.join(dir, 'out.tif');
			await runProgress('copy', 'gdal_translate', src, out);
			assert.ok((await fs.stat(out)).size > 0);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
