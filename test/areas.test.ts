// The probe areas are the yardstick for every parameter change, so they have to stay valid rectangles
// that actually contain the terrain they claim.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AREAS, LAT_LIMIT, resolveArea, parseZoomRange, areaSlug, previewPaths } from '../lib/areas.ts';
import { MAXLEVEL } from '../config.ts';

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

describe('parseZoomRange', () => {
	test('a range, a single level, or the whole build', () => {
		assert.deepEqual(parseZoomRange('4-10'), [4, 10]);
		assert.deepEqual(parseZoomRange('7'), [7, 7]);
		assert.deepEqual(parseZoomRange(undefined), [0, MAXLEVEL]);
		assert.deepEqual(parseZoomRange('0-0'), [0, 0]);
	});

	test('refuses ranges that cannot be built', () => {
		assert.throws(() => parseZoomRange('10-4'), /min \(10\) is above max \(4\)/);
		assert.throws(() => parseZoomRange(String(MAXLEVEL + 1)), new RegExp(`only builds up to z${MAXLEVEL}`));
		assert.throws(() => parseZoomRange('4..10'), /expected "min-max"/);
		assert.throws(() => parseZoomRange('z4'), /expected "min-max"/);
	});
});

describe('areaSlug', () => {
	test('a preset keeps its name, so existing preview tilesets keep theirs', () => {
		assert.equal(areaSlug('hudson-bay'), 'hudson_bay');
		assert.equal(areaSlug('greenland-coast'), 'greenland_coast');
		assert.equal(areaSlug(undefined), 'world');
	});

	test('an explicit box is keyed by its numbers, sign and decimal point included', () => {
		assert.equal(areaSlug('4,58,12,64'), 'bbox_4_58_12_64');
		assert.equal(areaSlug('-92,52,-84,58'), 'bbox_m92_52_m84_58');
		assert.equal(areaSlug('1.5,-2.25,3,4'), 'bbox_1p5_m2p25_3_4');
	});

	test('never lets two different areas share a cache', () => {
		// two valid, different boxes that the version dropping minus signs keyed both as 5_10_20_30
		assert.notEqual(areaSlug('-5,10,20,30'), areaSlug('5,10,20,30'));
		// the decimal point moved one number over
		assert.notEqual(areaSlug('1.2,3,4,5'), areaSlug('1,2.3,4,5'));
		// a box that happens to equal a preset still is not that preset's cache
		const { west, south, east, north } = AREAS['norway'].bbox;
		assert.notEqual(areaSlug(`${west},${south},${east},${north}`), areaSlug('norway'));
		// every preset is distinct
		const slugs = Object.keys(AREAS).map(areaSlug);
		assert.equal(new Set(slugs).size, slugs.length);
	});

	test('the same box spelled differently is the same area', () => {
		assert.equal(areaSlug(' 4 , 58 , 12 , 64 '), areaSlug('4,58,12,64'));
		assert.equal(areaSlug('4.0,58,12,64'), areaSlug('4,58,12,64'));
	});

	test('an invalid box is refused rather than turned into a key', () => {
		assert.throws(() => areaSlug('10,0,5,1'), /west/);
	});
});

describe('previewPaths', () => {
	const dir = '/data/preview/fe043f8a';

	test('areas share block tilesets but never per-zoom tilesets or scratch', () => {
		// the regression: a Sahara run's z8 tileset was reused for Hudson Bay under one fingerprint
		const sahara = previewPaths(dir, 'sahara');
		const hudson = previewPaths(dir, 'hudson-bay');
		assert.equal(sahara.results, hudson.results, 'tilesets are per block, so sharing them is correct');
		assert.notEqual(sahara.tiles, hudson.tiles);
		assert.notEqual(sahara.tmp, hudson.tmp, 'a build wipes its scratch on start');
		assert.equal(sahara.log, hudson.log);
	});

	test('everything stays under the fingerprinted directory', () => {
		for (const p of Object.values(previewPaths(dir, '-92,52,-84,58'))) assert.ok(p.startsWith(dir + '/'), p);
		assert.equal(previewPaths(dir, 'hudson-bay').tiles, `${dir}/2_tiles/hudson_bay`);
		assert.equal(previewPaths(dir, undefined).tiles, `${dir}/2_tiles/world`);
	});
});
