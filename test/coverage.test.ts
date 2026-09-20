// Skip-empty decides which blocks are never processed, so a wrong "empty" is a permanent hole in the
// map. The test that matters is the conservative direction: overlapping an occupied cell must never
// be reported as empty.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseCorner, coverageFromKeys, type LonLat } from '../lib/coverage.ts';

const bbox = (west: number, south: number, east: number, north: number): LonLat => ({ west, south, east, north });

describe('parseCorner', () => {
	test('reads the SW corner out of an ESA tile name', () => {
		const name = 'v200/2021/map/ESA_WorldCover_10m_2021_v200_N51E009_Map.tif';
		assert.deepEqual(parseCorner(name), { lat: 51, lon: 9 });
	});

	test('handles both hemispheres', () => {
		assert.deepEqual(parseCorner('..._S06W072_Map.tif'), { lat: -6, lon: -72 });
		assert.deepEqual(parseCorner('..._S45E168_Map.tif'), { lat: -45, lon: 168 });
		assert.deepEqual(parseCorner('..._N00E000_Map.tif'), { lat: 0, lon: 0 });
	});

	test('rejects anything that is not a tile name', () => {
		for (const junk of ['', 'README.md', 'N51E9_Map.tif', '<Key>truncated']) {
			assert.equal(parseCorner(junk), null, junk);
		}
	});
});

describe('coverage', () => {
	// one 3-degree cell, 51..54 N / 9..12 E
	const one = coverageFromKeys(['ESA_WorldCover_10m_2021_v200_N51E009_Map.tif']);

	test('counts one cell per tile, ignoring junk lines', () => {
		assert.equal(one.cells, 1);
		assert.equal(coverageFromKeys(['', 'nonsense', '..._N51E009_Map.tif', '..._N51E009_Map.tif']).cells, 1);
		assert.equal(coverageFromKeys([]).cells, 0);
	});

	test('a bbox inside the cell is not empty', () => {
		assert.equal(one.isEmpty(bbox(10, 52, 11, 53)), false);
	});

	test('a bbox far away is empty', () => {
		assert.equal(one.isEmpty(bbox(-100, -40, -90, -30)), true);
	});

	test('partial overlap is never reported as empty (the conservative direction)', () => {
		for (const b of [
			bbox(8, 50, 10, 52), // overlaps the SW corner
			bbox(11, 53, 14, 56), // overlaps the NE corner
			bbox(-20, 40, 60, 70), // contains the cell entirely
			bbox(11.9, 53.9, 20, 60), // barely overlaps
		]) {
			assert.equal(one.isEmpty(b), false, JSON.stringify(b));
		}
	});

	test('a bbox that only touches the cell edge is empty', () => {
		assert.equal(one.isEmpty(bbox(12, 51, 15, 54)), true); // east of 12E
		assert.equal(one.isEmpty(bbox(9, 54, 12, 57)), true); // north of 54N
	});

	test('cells south and west of zero work (floor, not truncate)', () => {
		const south = coverageFromKeys(['..._S03W003_Map.tif']); // -3..0 lat, -3..0 lon
		assert.equal(south.isEmpty(bbox(-2, -2, -1, -1)), false);
		assert.equal(south.isEmpty(bbox(-2, 1, -1, 2)), true); // north of the cell
		assert.equal(south.isEmpty(bbox(1, -2, 2, -1)), true); // east of the cell
	});

	test('a full-world bbox finds any cell', () => {
		assert.equal(one.isEmpty(bbox(-180, -85.0511, 180, 85.0511)), false);
	});
});
