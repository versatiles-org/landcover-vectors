// The experiment's yardstick (bin/experiment.ts): the test regions must sit where they claim, their sources must
// land on the build's pixel grid at every pyramid level, a variant's handover must reach the merge, and the
// measurement must paint and count the way versatiles-style draws.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { REGIONS, windowAt, extentTiles, extentLonLat, WINDOW_ZOOM } from '../lib/regions.ts';
import { regionGrid, regionKeys, pyramidVrt } from '../lib/regionsource.ts';
import { VARIANTS, channelsFor } from '../lib/variants.ts';
import {
	compare,
	paint,
	paintFills,
	opacityAt,
	kindsOf,
	kindRaster,
	kindBreakdown,
	KINDS,
	CATEGORIES,
} from '../lib/measure.ts';
import { rings } from '../lib/mvt.ts';
import { mergePipeline, landcoverKeepExpr } from '../lib/handover.ts';
import { channels, TILE_PX, FULL_PX } from '../config.ts';

describe('the test regions', () => {
	test('each window holds its centre, and its source extent holds the window', () => {
		for (const [name, r] of Object.entries(REGIONS)) {
			const [lon, lat] = r.center;
			const e = extentLonLat(r.window);
			assert.ok(e.west < lon && lon < e.east && e.south < lat && lat < e.north, `${name}: centre outside`);
			const t = extentTiles(r.window);
			const f = 2 ** (WINDOW_ZOOM - 10);
			assert.ok(t.x0 * f < r.window.x0 && r.window.x0 + r.window.side < t.x1 * f, `${name}: no padding in x`);
			assert.ok(t.y0 * f < r.window.y0 && r.window.y0 + r.window.side < t.y1 * f, `${name}: no padding in y`);
			assert.ok(r.why.length > 10, `${name}: says nothing about why it is a test region`);
		}
	});

	test('windowAt centres the window on the point', () => {
		// Berlin, z12 tile 2200/1343
		assert.deepEqual(windowAt(13.4, 52.52, 4), { x0: 2198, y0: 1341, side: 4 });
	});

	test("a region's grid is whole z10 tiles, so every overview level's pixels are the world's", () => {
		for (const r of Object.values(REGIONS)) {
			const g = regionGrid(r);
			for (const v of [g.x, g.y, g.width, g.height]) assert.equal(v % TILE_PX, 0);
		}
	});

	test('regionKeys picks the ESA tiles the extent touches', () => {
		const keys = ['N51E009', 'N51E012', 'N48E012', 'N54E012'].map(
			(c) => `v200/2021/map/ESA_WorldCover_10m_2021_v200_${c}_Map.tif`,
		);
		const picked = regionKeys(REGIONS['berlin-zehlendorf'], keys).map((k) => k.match(/_(N\d+E\d+)_/)![1]);
		assert.deepEqual(picked, ['N51E012']);
	});
});

test('pyramidVrt places a region at its offset on every level', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pyramid-'));
	const out = path.join(dir, 'world.vrt');
	await pyramidVrt(
		out,
		[{ file: 'region.tif', x: 3 * TILE_PX, y: 5 * TILE_PX, width: 2 * TILE_PX, height: TILE_PX }],
		0,
	);
	const base = await fs.readFile(out, 'utf8');
	assert.match(base, new RegExp(`rasterXSize="${FULL_PX}"`));
	assert.match(base, /<NoDataValue>0<\/NoDataValue>/);
	assert.match(base, new RegExp(`<DstRect xOff="${3 * TILE_PX}" yOff="${5 * TILE_PX}" xSize="${2 * TILE_PX}"`));
	const coarsest = await fs.readFile(path.join(out + '.levels', `1-${TILE_PX}.vrt`), 'utf8');
	assert.match(coarsest, /<OOI key="OVERVIEW_LEVEL">9<\/OOI>/);
	assert.match(coarsest, /<DstRect xOff="3" yOff="5" xSize="2" ySize="1"\/>/);
	await assert.rejects(
		pyramidVrt(out, [{ file: 'r.tif', x: 100, y: 0, width: TILE_PX, height: TILE_PX }]),
		/not aligned/,
	);
	await fs.rm(dir, { recursive: true, force: true });
});

describe('variants', () => {
	test("a variant's osmFrom reaches the merge, and nothing else changes", () => {
		const chans = channelsFor(VARIANTS['handover-z11']);
		assert.equal(chans.find((c) => c.kind === 'residential')!.osmFrom, 11);
		assert.equal(chans.find((c) => c.kind === 'water')!.osmFrom, 4);
		assert.match(landcoverKeepExpr('land'), /zoom >= 10 && kind in \['residential'\]/);
		assert.match(mergePipeline('o', 'l', chans), /zoom >= 11 && kind in \['residential'\]/);
		assert.deepEqual(channelsFor(VARIANTS.baseline), channels);
	});

	test('null hands a kind to the landcover at every zoom', () => {
		const chans = channelsFor({ why: '', osmFrom: { water: null } });
		assert.equal(chans.find((c) => c.kind === 'water')!.osmFrom, undefined);
	});
});

describe('the measurement', () => {
	test('opacity: numbers, and linear zoom interpolations', () => {
		const fade = ['interpolate', ['linear'], ['zoom'], 10, 0, 11, 1];
		assert.equal(opacityAt(undefined, 5), 1);
		assert.equal(opacityAt(0.4, 5), 0.4);
		assert.equal(opacityAt(fade, 9), 0);
		assert.equal(opacityAt(fade, 10.5), 0.5);
		assert.equal(opacityAt(fade, 12), 1);
	});

	test('kindsOf reads the two filter shapes versatiles-style uses', () => {
		assert.deepEqual(kindsOf(['in', ['get', 'kind'], ['literal', ['a', 'b']]]), ['a', 'b']);
		assert.deepEqual(kindsOf(['==', ['get', 'kind'], 'glacier']), ['glacier']);
		assert.deepEqual(kindsOf(undefined), []);
	});

	test("paint draws in the style's order: forest over residential, and parks only from z11", () => {
		const one = () => new Uint8Array([1]);
		const masks = new Map([
			['land/residential', one()],
			['land/forest', one()],
		]);
		assert.equal(CATEGORIES[paint(masks, 10, 1)[0]], 'forest');
		const park = new Map([['land/park', one()]]);
		assert.equal(CATEGORIES[paint(park, 10, 1)[0]], 'none');
		assert.equal(CATEGORIES[paint(park, 11, 1)[0]], 'green');
		assert.equal(CATEGORIES[paint(new Map([['water_polygons/glacier', one()]]), 10, 1)[0]], 'bare');
	});

	test('compare counts against OSM at z11', () => {
		const c = (...names: string[]) => new Uint8Array(names.map((n) => CATEGORIES.indexOf(n as never)));
		const m = compare({
			11: c('urban', 'urban', 'forest', 'none'),
			10: c('urban', 'forest', 'forest', 'urban'),
			9: c('urban', 'urban', 'forest', 'none'),
			8: c('none', 'none', 'forest', 'none'),
		});
		assert.equal(m.osmMapped, 75);
		assert.equal(m.handover, 66.7); // 2 of the 3 mapped pixels
		assert.equal(m.holes, 0);
		assert.deepEqual(m.towns, { z8: 0, z9: 100, z10: 50 });
		assert.equal(m.overreach, 50); // one of z10's two urban pixels is not urban at z11
		assert.equal(m.forestKept, 100);
		assert.deepEqual(m.unmapped, { urban: 100 });
	});
});

describe('per kind', () => {
	const one = () => new Uint8Array([1, 1, 1, 1]); // a 2×2 grid
	test('where two kinds overlap, the one drawn on top counts; undrawn kinds lose to drawn ones', () => {
		const kinds = kindRaster(
			new Map([
				['land/forest', one()],
				['land/residential', one()],
				['land/brownfield', new Uint8Array([1, 0, 0, 0])],
			]),
			2,
		);
		assert.deepEqual(new Set([...kinds].map((k) => KINDS[k - 1])), new Set(['land/forest']));
		const alone = kindRaster(new Map([['land/brownfield', one()]]), 2);
		assert.equal(KINDS[alone[0] - 1], 'land/brownfield');
	});

	test('kindBreakdown counts own fill, category and the handover per kind', () => {
		const allotments = kindRaster(new Map([['land/allotments', one()]]), 2);
		const at = (z: number, masks: [string, Uint8Array][]) => paintFills(new Map(masks), z, 2);
		const forest10 = at(10, [['land/forest', new Uint8Array([1, 0, 0, 0])]]); // one pixel forest, the rest nothing
		const garden = (z: number) => at(z, [['land/allotments', one()]]);
		const fills = { 8: forest10, 9: forest10, 10: forest10, 11: garden(11), 12: garden(12), 13: garden(13) };
		const c = kindBreakdown(allotments, fills)['land/allotments'];
		assert.equal(c.px, 4);
		assert.equal(c.own.z10, 0);
		assert.equal(c.own.z11, 4); // garden fades in from z11 to z12: half opaque at z11.5 counts
		assert.equal(c.handover, 0); // forest and nothing at z10, green at z11
		assert.deepEqual(c.z10, { 'land-forest': 1, none: 3 });
	});
});

test('mvt rings: move-to starts a ring, close-path ends it', () => {
	// a 2×2 square: MoveTo(1,1) LineTo(+2,0)(0,+2)(-2,0) ClosePath
	const z = (n: number) => (n << 1) ^ (n >> 31);
	const geometry = [9, z(1), z(1), (3 << 3) | 2, z(2), z(0), z(0), z(2), z(-2), z(0), 15];
	assert.deepEqual(rings(geometry), [
		[
			[1, 1],
			[3, 1],
			[3, 3],
			[1, 3],
		],
	]);
});
