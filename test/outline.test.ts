// Rounding a polygonized coverage's outlines: the polygons must stay a coverage.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { edgeMask, parseWkt, roundRing, type Point } from '../lib/outline.ts';

const grid = { width: 12, height: 12 };
const box = (x0: number, y0: number, x1: number, y1: number): Point[] => [
	[x0, y0],
	[x1, y0],
	[x1, y1],
	[x0, y1],
	[x0, y0],
];
const key = (p: number[]) => p.join(',');

// each segment of a ring, independent of direction
const segments = (ring: Point[]) => {
	const out = new Set<string>();
	for (let i = 0; i + 1 < ring.length; i++) out.add([key(ring[i]), key(ring[i + 1])].sort().join(' '));
	return out;
};

test('a ring without a node is rounded the same from any start', () => {
	const a = box(2, 2, 6, 6);
	const b: Point[] = [[6, 2], [6, 6], [2, 6], [2, 2], [6, 2]]; // prettier-ignore
	const mask = edgeMask([a], grid);
	const params = { cap: 10, passes: 1 };
	assert.deepEqual(segments(roundRing(a, mask, grid, params)), segments(roundRing(b, mask, grid, params)));
	assert.equal(roundRing(a, mask, grid, params).length, 5, "a square's midpoints: a diamond");
});

test('two polygons along a border get the same points, and the T-junctions stay', () => {
	// a staircase between A (upper left) and B, inside a surrounding polygon C that A and B both touch
	const a: Point[] = [[2, 2], [6, 2], [6, 4], [4, 4], [4, 6], [2, 6], [2, 2]]; // prettier-ignore
	const b: Point[] = [[6, 2], [8, 2], [8, 6], [4, 6], [4, 4], [6, 4], [6, 2]]; // prettier-ignore
	const c: Point[] = [[0, 0], [12, 0], [12, 12], [0, 12], [0, 0]]; // prettier-ignore
	const hole: Point[] = [[2, 2], [2, 6], [8, 6], [8, 2], [2, 2]]; // prettier-ignore
	const mask = edgeMask([a, b, c, hole], grid);
	const params = { cap: 10, passes: 2 };
	const [ra, rb] = [roundRing(a, mask, grid, params), roundRing(b, mask, grid, params)];
	const shared = [...segments(ra)].filter((s) => segments(rb).has(s));
	assert.ok(shared.length >= 3, 'the rounded border is in both');
	for (const node of ['6,2', '4,6']) {
		assert.ok(ra.some((p) => key(p) === node), `A keeps ${node}`); // prettier-ignore
		assert.ok(rb.some((p) => key(p) === node), `B keeps ${node}`); // prettier-ignore
	}
	assert.ok(!ra.some((p) => key(p) === '6,4'), 'the corner is cut');
});

test('a T-junction on a long straight edge splits it on the other polygon too', () => {
	const top = box(0, 0, 12, 4);
	const left = box(0, 4, 6, 12);
	const right = box(6, 4, 12, 12);
	const mask = edgeMask([top, left, right], grid);
	const r = roundRing(top, mask, grid, { cap: 1, passes: 1 });
	assert.ok(r.some((p) => key(p) === '6,4'), 'the node the straight edge passes through'); // prettier-ignore
});

test('the window edge and its corners stay', () => {
	const whole = box(0, 0, 12, 12);
	const r = roundRing(whole, edgeMask([whole], grid), grid, { cap: 1, passes: 3 });
	assert.ok(['0,0', '12,0', '12,12', '0,12'].every((c) => r.some((p) => key(p) === c)));
});

test('a long segment keeps its middle: only `cap` is cut from its ends', () => {
	const r = roundRing(box(1, 1, 11, 3), edgeMask([box(1, 1, 11, 3)], grid), grid, { cap: 1, passes: 1 });
	assert.ok(r.some((p) => key(p) === '2,1') && r.some((p) => key(p) === '10,1'));
	assert.ok(!r.some((p) => key(p) === '1,1'));
});

test('a diagonal edge is no polygonized ring', () => {
	assert.throws(() => edgeMask([[[0, 0], [1, 1]]], grid), /diagonal/); // prettier-ignore
});

test("parseWkt reads ogr2ogr's polygons, holes included", () => {
	assert.deepEqual(parseWkt('POLYGON ((0 0,1 0,1 1,0 0),(2 2,3 2,3 3,2 2))'), [
		[[0, 0], [1, 0], [1, 1], [0, 0]], // prettier-ignore
		[[2, 2], [3, 2], [3, 3], [2, 2]], // prettier-ignore
	]);
});
