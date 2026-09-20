// The end-of-build summary is the only place the branch tally is ever seen, so it has to count the right
// run: blocks.log accumulates across runs, and a resumed build's numbers are not the first build's.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { summariseLog, formatSummary, readRunSummary } from '../lib/summary.ts';
import { LOG_HEADER } from '../lib/block.ts';

// a log row with the columns the summary reads (timestamp, id, branch, ms, …)
const row = (id: string, branch: string, ms: number) =>
	['2026-09-21T00:00:00.000Z', id, branch, String(ms), '', '', '', '', '', '', ''].join('\t');

describe('summariseLog', () => {
	test('tallies branches and core time per zoom', () => {
		const s = summariseLog(
			[
				LOG_HEADER,
				row('z9_1_2', 'full', 30_000),
				row('z9_2_2', 'empty', 500),
				row('z10_0_0', 'full', 20_000),
				'',
			].join('\n'),
		);
		assert.equal(s.blocks, 3);
		assert.equal(s.ms, 50_500);
		assert.deepEqual(s.branches, { full: 2, empty: 1 });
		assert.deepEqual(
			s.zooms.map((z) => [z.z, z.blocks, z.ms]),
			[
				[9, 2, 30_500],
				[10, 1, 20_000],
			],
		);
		assert.deepEqual(s.zooms[0].branches, { full: 1, empty: 1 });
	});

	test('counts only the latest run — the log outlives it', () => {
		const s = summariseLog(
			[
				LOG_HEADER,
				row('z0_0_0', 'full', 9_999), // a previous run
				row('z1_0_0', 'failed', 1),
				LOG_HEADER, // this run starts here
				row('z5_0_0', 'cached', 2),
				row('z5_1_0', 'full', 100),
				'',
			].join('\n'),
		);
		assert.equal(s.blocks, 2);
		assert.equal(s.ms, 102);
		assert.deepEqual(s.branches, { cached: 1, full: 1 });
	});

	test('zooms come out in numeric order, not the order they were logged', () => {
		const s = summariseLog(
			[LOG_HEADER, row('z10_0_0', 'full', 1), row('z2_0_0', 'full', 1), row('z9_0_0', 'full', 1)].join('\n'),
		);
		assert.deepEqual(
			s.zooms.map((z) => z.z),
			[2, 9, 10],
		);
	});

	test('survives a truncated or garbled log instead of taking the build down with it', () => {
		const s = summariseLog(
			[
				LOG_HEADER,
				row('z3_0_0', 'full', 10),
				'half a row',
				'',
				'z3_1_0\tno tabs here',
				row('bad-id', 'full', 5),
				'',
			].join('\n'),
		);
		assert.equal(s.blocks, 1, 'only the one well-formed row counts');
	});

	test('a log with no rows yields nothing to report', () => {
		assert.equal(summariseLog('').blocks, 0);
		assert.equal(summariseLog(LOG_HEADER + '\n').blocks, 0);
	});

	test('rows without a header still count, so an older log is not silently empty', () => {
		assert.equal(summariseLog([row('z1_0_0', 'full', 5)].join('\n')).blocks, 1);
	});
});

describe('formatSummary', () => {
	const s = summariseLog(
		[LOG_HEADER, row('z9_0_0', 'full', 3_600_000), row('z9_1_0', 'uniform', 1_800_000)].join('\n'),
	);

	test('reports the branch tally, the per-zoom cost and the parallel speed-up', () => {
		const text = formatSummary(s, 1_800_000);
		assert.match(text, /full 1, uniform 1/);
		assert.match(
			text,
			/^\s+9\s+2\s+1\.50\s+full 1, uniform 1$/m,
			'the zoom row shows blocks, core-hours and branches',
		);
		assert.match(text, /total 2 blocks, 1\.50 core-h, 0\.50 h wall \(×3\.0 parallel\)/);
	});

	test('leaves the wall clock out when it was not measured', () => {
		assert.ok(!formatSummary(s).includes('wall'));
	});
});

describe('readRunSummary', () => {
	test('reads a log file, and returns null when there is nothing to say', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-sum-'));
		try {
			const log = path.join(dir, 'blocks.log');
			assert.equal(await readRunSummary(log), null, 'missing file');
			await fs.writeFile(log, LOG_HEADER + '\n');
			assert.equal(await readRunSummary(log), null, 'header only');
			await fs.appendFile(log, row('z7_3_4', 'full', 42) + '\n');
			const s = await readRunSummary(log);
			assert.equal(s?.blocks, 1);
			assert.deepEqual(s?.branches, { full: 1 });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
