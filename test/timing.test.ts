// The timing log is only useful if every entry knows where it ran: steps nest, a block id reaches the commands
// run for it, a failed step is still logged, and nothing is written when no log was started.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	startTimingLog,
	stopTimingLog,
	timed,
	commandStarted,
	parseLog,
	runOf,
	group,
	anyZoom,
	type Entry,
} from '../lib/timing.ts';
import { runQuiet } from '../lib/worldcover.ts';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-timing-'));
after(() => fs.rm(tmp, { recursive: true, force: true }));

async function logOf(name: string, fn: () => Promise<void>): Promise<Entry[]> {
	const file = path.join(tmp, name);
	startTimingLog(file, 'test', { cores: 1 });
	try {
		await fn();
	} finally {
		stopTimingLog();
	}
	return parseLog(await fs.readFile(file, 'utf8'));
}

describe('timing log', () => {
	test('steps nest, and a block id reaches the commands inside', async () => {
		const log = await logOf('nest.jsonl', () =>
			timed('build', () =>
				timed('z9', () =>
					timed(
						'block',
						async () => {
							await timed('sieve', async () => commandStarted('gdal', ['raster', 'sieve', '-i', 'x'])(true));
						},
						'z9_1_2',
					),
				),
			),
		);
		assert.equal(log[0].kind, 'run');
		const cmd = log.find((e) => e.kind === 'cmd')!;
		assert.equal(cmd.path, 'build/z9/block/sieve');
		assert.equal(cmd.cmd, 'gdal raster sieve');
		assert.equal(cmd.block, 'z9_1_2');
		assert.deepEqual(
			log.filter((e) => e.kind === 'span').map((e) => [e.path, e.block ?? null]),
			[
				['build/z9/block/sieve', 'z9_1_2'],
				['build/z9/block', 'z9_1_2'],
				['build/z9', null],
				['build', null],
			],
		);
	});

	test('a failing step is logged as failed and the error still reaches the caller', async () => {
		const log = await logOf('fail.jsonl', async () => {
			await assert.rejects(
				timed('broken', async () => {
					throw new Error('boom');
				}),
				/boom/,
			);
		});
		const span = log.find((e) => e.kind === 'span')!;
		assert.equal(span.path, 'broken');
		assert.equal(span.ok, false);
	});

	test('par counts the commands already running when one starts', async () => {
		const log = await logOf('par.jsonl', async () => {
			const first = commandStarted('a', []);
			const second = commandStarted('b', []);
			second(true);
			first(true);
		});
		const par = Object.fromEntries(log.filter((e) => e.kind === 'cmd').map((e) => [e.cmd, e.par]));
		assert.deepEqual(par, { a: 0, b: 1 });
	});

	test('the command runners log real commands, failures included', async () => {
		const log = await logOf('runners.jsonl', () =>
			timed('step', async () => {
				await runQuiet('true');
				await assert.rejects(runQuiet('false'));
			}),
		);
		assert.deepEqual(
			log.filter((e) => e.kind === 'cmd').map((e) => [e.path, e.cmd, e.ok]),
			[
				['step', 'true', true],
				['step', 'false', false],
			],
		);
	});

	test('nothing is written without a log', async () => {
		await timed('quiet', async () => commandStarted('x', [])(true));
		assert.deepEqual(await fs.readdir(tmp).then((f) => f.filter((n) => n.startsWith('quiet'))), []);
	});
});

describe('reading the log back', () => {
	const e = (run: string, p: string, ms: number, ok = true): Entry => ({ kind: 'span', run, t: '', path: p, ms, ok });

	test('a truncated last line is skipped', () => {
		assert.equal(parseLog('{"kind":"run","run":"a","t":""}\n{"kind":"span","ru').length, 1);
	});

	test('the last run by default, or the one whose id starts with a prefix', () => {
		const all = [e('build-1', 'x', 1), e('build-2', 'x', 2), e('download-3', 'x', 3)];
		assert.deepEqual(
			runOf(all).map((r) => r.run),
			['download-3'],
		);
		assert.deepEqual(
			runOf(all, 'build-1').map((r) => r.ms),
			[1],
		);
		assert.deepEqual(runOf(all, 'nope'), []);
	});

	test('groups add up, slowest first, and count failures', () => {
		const rows = [e('r', 'a', 100), e('r', 'a', 300, false), e('r', 'b', 50)];
		const [a, b] = group(rows, (r) => r.path!);
		assert.deepEqual(a, { key: 'a', n: 2, ms: 400, mean: 200, p95: 300, max: 300, failed: 1 });
		assert.equal(b.key, 'b');
	});

	test('zooms fold into one row', () => {
		assert.equal(anyZoom('build/z10/blocks/block/sieve'), 'build/z*/blocks/block/sieve');
		assert.equal(anyZoom('build/z3'), 'build/z*');
		assert.equal(anyZoom('download/seashare/tiles'), 'download/seashare/tiles');
	});
});
