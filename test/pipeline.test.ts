// The zoom loop decides fragment order (and therefore whether two builds of one config are identical)
// and what happens when a block fails. Both were previously locked inside a top-level script that could
// not run without a 23 GB raster; with the stages injectable they can finally be tested.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runZooms, type PipelineCtx, type PipelineDeps } from '../lib/pipeline.ts';
import type { ZoomBlocks } from '../lib/plan.ts';
import type { BlockFragments } from '../lib/block.ts';

const ctx = (over: Partial<PipelineCtx> = {}): PipelineCtx => ({
	src: '/nonexistent/source.tif',
	tmpdir: '/tmp/lcv-unused',
	resultsdir: '/tmp/lcv-unused',
	tilesdir: '/tmp/lcv-unused-tiles',
	concurrency: 4,
	...over,
});

// stages that record what they were asked to do; blocks finish in a jittered order on purpose
function fakeDeps(opts: { fail?: string[] } = {}) {
	const seen: string[] = [];
	const tiled: { z: number; fragments: BlockFragments[] }[] = [];
	const deps: PipelineDeps = {
		processBlock: async (z, bx, by) => {
			const id = `z${z}_${bx}_${by}`;
			// reverse-ish completion order: later blocks return first
			await new Promise((r) => setTimeout(r, (7 - ((bx + by) % 7)) * 2));
			seen.push(id);
			if (opts.fail?.includes(id)) throw new Error(`boom ${id}`);
			return { land: `${id}_land.fgb`, water: null };
		},
		tileZoom: async (z, fragments) => {
			tiled.push({ z, fragments: [...fragments] });
			return `z${z}.mbtiles`;
		},
	};
	return { deps, seen, tiled };
}

const plan = (z: number, n: number): ZoomBlocks[] => [
	{ z, blocks: Array.from({ length: n }, (_, i) => [i % 4, Math.floor(i / 4)] as [number, number]) },
];

describe('runZooms', () => {
	test('hands tippecanoe the fragments in block order, whatever order they finished in', async () => {
		const { deps, seen, tiled } = fakeDeps();
		const out = await runZooms(plan(7, 12), ctx(), deps);

		assert.deepEqual(out, ['z7.mbtiles']);
		assert.equal(tiled.length, 1);
		const order = tiled[0].fragments.map((f) => f.land);
		const expected = plan(7, 12)[0].blocks.map(([bx, by]) => `z7_${bx}_${by}_land.fgb`);
		assert.deepEqual(order, expected, 'fragment order must follow the plan, not completion');
		assert.notDeepEqual(
			seen,
			expected.map((f) => f.replace('_land.fgb', '')),
			'the fake should finish out of order',
		);
	});

	test('drops blocks that produced nothing', async () => {
		const deps: PipelineDeps = {
			processBlock: async (z, bx) => ({ land: bx === 0 ? null : `z${z}_${bx}_land.fgb`, water: null }),
			tileZoom: async (_z, fragments) => (fragments.length ? 'out.mbtiles' : null),
		};
		const tiled: BlockFragments[][] = [];
		await runZooms(plan(5, 8), ctx(), {
			...deps,
			tileZoom: async (z, fragments, dirs) => {
				tiled.push([...fragments]);
				return deps.tileZoom(z, fragments, dirs);
			},
		});
		assert.equal(tiled[0].length, 6, 'the two bx=0 blocks produced no fragment');
	});

	test('a failing block lets the zoom finish, then reports every failure together', async () => {
		const { deps, seen, tiled } = fakeDeps({ fail: ['z9_1_0', 'z9_3_1'] });
		const err = await runZooms(plan(9, 8), ctx({ logFile: '/tmp/blocks.log' }), deps).then(
			() => null,
			(e) => e as AggregateError,
		);

		assert.ok(err instanceof AggregateError);
		assert.equal(err.errors.length, 2);
		assert.match(err.message, /zoom 9: 2 of 8 blocks failed \(z9_1_0, z9_3_1\)/);
		assert.match(err.message, /see \/tmp\/blocks\.log/);
		assert.equal(seen.length, 8, 'every block was attempted — a failure must not stop the others');
		assert.equal(tiled.length, 0, 'a partial zoom must not be tiled');
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

	test('a cached zoom is reused without touching a single block', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-pipe-'));
		try {
			await fs.writeFile(path.join(dir, 'z4.mbtiles'), '');
			const { deps, seen, tiled } = fakeDeps();
			const ticks: number[] = [];
			const out = await runZooms(
				plan(4, 16),
				ctx({ tilesdir: dir, bar: { tick: (n = 1) => ticks.push(n), setLabel: () => {}, done: () => {} } }),
				deps,
			);
			assert.deepEqual(out, [path.join(dir, 'z4.mbtiles')]);
			assert.deepEqual(seen, [], 'no block was processed');
			assert.equal(tiled.length, 0, 'no tiling either');
			assert.deepEqual(ticks, [16], 'the progress bar still accounts for the skipped blocks');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('walks the zooms in plan order and labels them', async () => {
		const { deps, tiled } = fakeDeps();
		const labels: string[] = [];
		const out = await runZooms(
			[
				{ z: 2, blocks: [[0, 0]] },
				{ z: 3, blocks: [[0, 0]] },
				{ z: 4, blocks: [] },
			],
			ctx({
				label: (z) => `zoom ${z}`,
				bar: { tick: () => {}, setLabel: (s) => labels.push(s), done: () => {} },
			}),
			deps,
		);
		assert.deepEqual(
			tiled.map((t) => t.z),
			[2, 3, 4],
		);
		assert.deepEqual(labels, ['zoom 2', 'zoom 3', 'zoom 4']);
		assert.equal(out.length, 3);
	});

	test('an empty plan is not an error, it just produces nothing', async () => {
		const { deps } = fakeDeps();
		assert.deepEqual(await runZooms([], ctx(), deps), []);
	});
});
