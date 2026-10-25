// The zoom loop decides tileset order (and therefore whether two builds of one config are identical),
// what happens when a block fails, and when a zoom is joined. All of it was previously locked inside a
// top-level script that could not run without a 23 GB raster; with the stages injectable it can be tested.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runZooms, type PipelineCtx, type PipelineDeps } from '../lib/pipeline.ts';
import type { ZoomBlocks } from '../lib/plan.ts';

const ctx = (over: Partial<PipelineCtx> = {}): PipelineCtx => ({
	src: '/nonexistent/source.tif',
	tmpdir: '/tmp/lcv-unused',
	resultsdir: '/tmp/lcv-unused',
	tilesdir: '/tmp/lcv-unused-tiles',
	concurrency: 4,
	...over,
});

// stages that record what they were asked to do; blocks finish in a jittered order on purpose
function fakeDeps(opts: { fail?: string[]; empty?: number[] } = {}) {
	const seen: string[] = [];
	const joined: { out: string; tilesets: string[] }[] = [];
	const deps: PipelineDeps = {
		processBlock: async (z, bx, by) => {
			const id = `z${z}_${bx}_${by}`;
			// reverse-ish completion order: later blocks return first
			await new Promise((r) => setTimeout(r, (7 - ((bx + by) % 7)) * 2));
			seen.push(id);
			if (opts.fail?.includes(id)) throw new Error(`boom ${id}`);
			return `${id}.mbtiles`;
		},
		joinTilesets: async (tilesets, out) => {
			joined.push({ out, tilesets: [...tilesets] });
			return !opts.empty?.some((z) => out.endsWith(`z${z}.mbtiles`));
		},
	};
	return { deps, seen, joined };
}

const plan = (z: number, n: number): ZoomBlocks[] => [
	{ z, blocks: Array.from({ length: n }, (_, i) => [i % 4, Math.floor(i / 4)] as [number, number]) },
];

describe('runZooms', () => {
	test("joins a zoom's tilesets in block order, whatever order they finished in", async () => {
		const { deps, seen, joined } = fakeDeps();
		const out = await runZooms(plan(7, 12), ctx(), deps);

		assert.deepEqual(out, ['/tmp/lcv-unused-tiles/z7.mbtiles']);
		const expected = plan(7, 12)[0].blocks.map(([bx, by]) => `z7_${bx}_${by}.mbtiles`);
		assert.deepEqual(joined, [{ out: '/tmp/lcv-unused-tiles/z7.mbtiles', tilesets: expected }]);
		assert.notDeepEqual(
			seen,
			expected.map((f) => f.replace('.mbtiles', '')),
			'the fake should finish out of order',
		);
	});

	test('a zoom without any tiles produces no tileset', async () => {
		const { deps } = fakeDeps({ empty: [5] });
		assert.deepEqual(await runZooms([...plan(5, 4), ...plan(6, 4)], ctx(), deps), [
			'/tmp/lcv-unused-tiles/z6.mbtiles',
		]);
	});

	test('a failing block lets the zoom finish, then reports every failure together', async () => {
		const { deps, seen, joined } = fakeDeps({ fail: ['z9_1_0', 'z9_3_1'] });
		const err = await runZooms(plan(9, 8), ctx({ logFile: '/tmp/blocks.log' }), deps).then(
			() => null,
			(e) => e as AggregateError,
		);

		assert.ok(err instanceof AggregateError);
		assert.equal(err.errors.length, 2);
		assert.match(err.message, /zoom 9: 2 of 8 blocks failed \(z9_1_0, z9_3_1\)/);
		assert.match(err.message, /see \/tmp\/blocks\.log/);
		assert.equal(seen.length, 8, 'every block was attempted — a failure must not stop the others');
		assert.equal(joined.length, 0, 'a partial zoom must not be joined');
	});

	test('reports the failing ids compactly when there are many', async () => {
		const ids = Array.from({ length: 12 }, (_, i) => `z3_${i % 4}_${Math.floor(i / 4)}`);
		const { deps } = fakeDeps({ fail: ids });
		const err = await runZooms(plan(3, 12), ctx(), deps).then(
			() => null,
			(e) => e as AggregateError,
		);
		assert.match(String(err?.message), /12 of 12 blocks failed \(.*, …\)/);
		assert.equal(err?.errors.length, 12);
	});

	test('a failed zoom stops the build before the next zoom', async () => {
		const { deps, seen } = fakeDeps({ fail: ['z2_0_0'] });
		await assert.rejects(
			runZooms(
				[
					{ z: 2, blocks: [[0, 0]] },
					{ z: 3, blocks: [[0, 0]] },
				],
				ctx(),
				deps,
			),
		);
		assert.deepEqual(seen, ['z2_0_0']);
	});

	test('a joined zoom is reused without touching a single block', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-pipe-'));
		try {
			await fs.writeFile(path.join(dir, 'z4.mbtiles'), '');
			const { deps, seen, joined } = fakeDeps();
			const ticks: number[] = [];
			const out = await runZooms(
				plan(4, 16),
				ctx({ tilesdir: dir, bar: { tick: (n = 1) => ticks.push(n), setLabel: () => {}, done: () => {} } }),
				deps,
			);
			assert.deepEqual(out, [path.join(dir, 'z4.mbtiles')]);
			assert.deepEqual(seen, [], 'no block was processed');
			assert.equal(joined.length, 0, 'no join either');
			assert.deepEqual(ticks, [16], 'the progress bar still accounts for the skipped blocks');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('walks the zooms in plan order and labels them', async () => {
		const { deps } = fakeDeps();
		const labels: string[] = [];
		const out = await runZooms(
			[
				{ z: 2, blocks: [[0, 0]] },
				{ z: 3, blocks: [[0, 0]] },
			],
			ctx({
				label: (z) => `zoom ${z}`,
				bar: { tick: () => {}, setLabel: (s) => labels.push(s), done: () => {} },
			}),
			deps,
		);
		assert.deepEqual(out, ['/tmp/lcv-unused-tiles/z2.mbtiles', '/tmp/lcv-unused-tiles/z3.mbtiles']);
		assert.deepEqual(labels, ['zoom 2', 'zoom 3']);
	});

	test('an empty plan is not an error, it just produces nothing', async () => {
		const { deps } = fakeDeps();
		assert.deepEqual(await runZooms([], ctx(), deps), []);
	});
});
