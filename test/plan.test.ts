// planBlocks replaced an inline loop in bin/build.ts and is now shared with preview/probe runs, so it
// is pinned against a reference implementation of that loop.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planBlocks, countBlocks } from '../lib/plan.ts';
import { coverageFromKeys, type Coverage, type LonLat } from '../lib/coverage.ts';
import { MAXLEVEL, blocksPerAxis, blockWindow } from '../config.ts';

// a spread-out synthetic coverage: every 3-degree cell where (lat + lon) is a multiple of 9
const synthetic: Coverage = {
	cells: 0,
	isEmpty(b) {
		for (let lat = Math.floor(b.south / 3) * 3; lat < b.north; lat += 3)
			for (let lon = Math.floor(b.west / 3) * 3; lon < b.east; lon += 3)
				if ((((lat + lon) % 9) + 9) % 9 === 0) return false;
		return true;
	},
};

// the loop planBlocks replaced, kept verbatim as the reference
function reference(coverage: Coverage): [number, number][][] {
	const out: [number, number][][] = [];
	for (let z = 0; z <= MAXLEVEL; z++) {
		const n = blocksPerAxis(z);
		const list: [number, number][] = [];
		for (let by = 0; by < n; by++)
			for (let bx = 0; bx < n; bx++) if (!coverage.isEmpty(blockWindow(z, bx, by).innerLonLat)) list.push([bx, by]);
		out.push(list);
	}
	return out;
}

const overlaps = (a: LonLat, b: LonLat) => a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;

describe('planBlocks', () => {
	test('matches the enumeration it replaced, zoom for zoom', () => {
		const plan = planBlocks(synthetic);
		assert.deepEqual(
			plan.map((p) => p.blocks),
			reference(synthetic),
		);
		assert.deepEqual(
			plan.map((p) => p.z),
			Array.from({ length: MAXLEVEL + 1 }, (_, z) => z),
		);
	});

	test('counts what it lists', () => {
		const plan = planBlocks(synthetic);
		assert.equal(
			countBlocks(plan),
			plan.reduce((s, p) => s + p.blocks.length, 0),
		);
		assert.equal(countBlocks([]), 0);
	});

	test('blocks come out row-major, which is what keeps builds reproducible', () => {
		for (const { blocks } of planBlocks(synthetic, { minZoom: 6, maxZoom: 8 })) {
			const keys = blocks.map(([bx, by]) => by * 10000 + bx);
			assert.deepEqual(
				keys,
				[...keys].sort((a, b) => a - b),
			);
		}
	});

	test('honours a zoom range and clamps it to what exists', () => {
		assert.deepEqual(
			planBlocks(synthetic, { minZoom: 8, maxZoom: 9 }).map((p) => p.z),
			[8, 9],
		);
		const clamped = planBlocks(synthetic, { minZoom: -5, maxZoom: MAXLEVEL + 5 });
		assert.equal(clamped[0].z, 0);
		assert.equal(clamped.at(-1)?.z, MAXLEVEL);
		assert.deepEqual(planBlocks(synthetic, { minZoom: 5, maxZoom: 4 }), []);
	});

	test('a bbox keeps exactly the overlapping blocks', () => {
		const bbox = { west: 4, south: 58, east: 12, north: 64 }; // the 'norway' probe area
		for (const z of [4, 6, 8]) {
			const all = planBlocks(synthetic, { minZoom: z, maxZoom: z })[0].blocks;
			const sub = planBlocks(synthetic, { minZoom: z, maxZoom: z, bbox })[0].blocks;
			const want = all.filter(([bx, by]) => overlaps(blockWindow(z, bx, by).innerLonLat, bbox));
			assert.deepEqual(sub, want, `z${z}`);
			assert.ok(sub.length < all.length, `z${z} bbox should narrow the plan`);
		}
	});

	test('an empty coverage plans no work at all', () => {
		const plan = planBlocks(coverageFromKeys([]));
		assert.equal(countBlocks(plan), 0);
		assert.equal(plan.length, MAXLEVEL + 1); // every zoom still listed, just empty
	});
});
