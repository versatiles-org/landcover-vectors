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
