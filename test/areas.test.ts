// The probe areas are the yardstick for every parameter change, so they have to stay valid rectangles
// that actually contain the terrain they claim.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AREAS, LAT_LIMIT, resolveArea } from '../lib/areas.ts';

describe('the presets', () => {
	test('are well-formed rectangles inside the Mercator range', () => {
		for (const [name, { bbox, why }] of Object.entries(AREAS)) {
			assert.ok(bbox.west < bbox.east, `${name}: west >= east`);
			assert.ok(bbox.south < bbox.north, `${name}: south >= north`);
			assert.ok(bbox.west >= -180 && bbox.east <= 180, `${name}: longitude out of range`);
			assert.ok(bbox.south >= -LAT_LIMIT && bbox.north <= LAT_LIMIT, `${name}: latitude beyond Mercator`);
			assert.ok(why.length > 10, `${name}: says nothing about why it is a probe`);
		}
	});

	test('hudson-bay contains the measured worst tile of the z0–10 build', () => {
		// z9 129/159, the 60.5 KB tile — the reason this preset exists
		const { bbox } = AREAS['hudson-bay'];
		const lon = -88.95;
		const lat = 55.97;
		assert.ok(lon > bbox.west && lon < bbox.east, 'longitude outside the preset');
		assert.ok(lat > bbox.south && lat < bbox.north, 'latitude outside the preset');
	});
});

describe('resolveArea', () => {
	test('resolves a preset by name', () => {
		assert.deepEqual(resolveArea('norway'), AREAS['norway'].bbox);
	});

	test('parses an explicit bbox, with or without spaces', () => {
		assert.deepEqual(resolveArea('4,58,12,64'), { west: 4, south: 58, east: 12, north: 64 });
		assert.deepEqual(resolveArea(' -5 , -10 , 5 , 10 '), { west: -5, south: -10, east: 5, north: 10 });
	});

	test('an unknown name lists what is available', () => {
		assert.throws(() => resolveArea('atlantis'), /unknown area "atlantis".*hudson-bay/s);
	});

	test('rejects malformed boxes with a reason', () => {
		assert.throws(() => resolveArea('1,2,3'), /four numbers/);
		assert.throws(() => resolveArea('1,2,3,x'), /four numbers/);
		assert.throws(() => resolveArea('10,0,5,1'), /west \(10\) must be less than east \(5\)/);
		assert.throws(() => resolveArea('0,10,5,5'), /south \(10\) must be less than north \(5\)/);
		assert.throws(() => resolveArea('-200,0,5,1'), /outside ±180/);
		assert.throws(() => resolveArea('0,86,5,89'), /outside the Mercator range/);
	});
});
