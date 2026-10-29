// OSM's land use from the planet (lib/osmland.ts): the rules must give the kinds Shortbread's schema has, in
// Land.java's precedence, and the import must turn real OSM areas — ways and multipolygons — into them. Runs
// osmium and GDAL on a tiny hand-made file, so it is skipped where they are not installed.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { skipWithout } from './tools.ts';
import {
	LAND_RULES,
	landKinds,
	tagsFilterExpressions,
	kindOf,
	toKindsCsv,
	exportConfig,
	importLand,
	extractBoxes,
	halve,
} from '../lib/osmland.ts';
import { runCapture } from '../lib/worldcover.ts';
import { KINDS } from '../lib/measure.ts';

describe('the rules', () => {
	test("give exactly Shortbread's land kinds", () => {
		const schema = KINDS.filter((k) => k.startsWith('land/')).map((k) => k.slice('land/'.length));
		assert.deepEqual(landKinds().toSorted(), schema.toSorted());
	});

	test('filter on every value they accept, as areas', () => {
		const filter = tagsFilterExpressions();
		assert.ok(filter.every((e) => e.startsWith('a/')));
		assert.ok(filter.includes('a/amenity=grave_yard'));
		const natural = filter
			.find((e) => e.startsWith('a/natural='))!
			.split('=')[1]
			.split(',');
		assert.deepEqual(natural.toSorted(), [
			'bare_rock',
			'beach',
			'grassland',
			'heath',
			'sand',
			'scree',
			'scrub',
			'shingle',
			'wood',
		]);
		assert.equal(filter.length, new Set(LAND_RULES.flatMap((r) => Object.keys(r.tags))).size);
	});

	test("pick the kind in Land.java's order", () => {
		assert.equal(kindOf({ landuse: 'farmland', natural: 'wood' }), 'forest');
		assert.equal(kindOf({ landuse: 'residential', leisure: 'park' }), 'residential');
		assert.equal(kindOf({ natural: 'wetland', wetland: 'marsh' }), 'marsh');
		assert.equal(kindOf({ amenity: 'grave_yard', landuse: 'cemetery' }), 'grave_yard');
		assert.equal(kindOf({ landuse: 'garages', leisure: 'park' }), 'garages');
		assert.equal(kindOf({ landuse: 'military' }), null);
		assert.equal(kindOf({}), null);
		assert.throws(() => kindOf({}, [{ tags: { a: ['x'], b: ['y'] } }]), /needs a kind/);
	});

	test('the export keeps only the keys, and every closed way is an area', () => {
		const conf = exportConfig() as Record<string, unknown>;
		assert.deepEqual(conf.include_tags, ['landuse', 'natural', 'wetland', 'amenity', 'leisure']);
		assert.equal(conf.area_tags, true);
		assert.equal(conf.linear_tags, false);
	});
});

const skip = await skipWithout('ogr2ogr', 'osmium');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-osmland-'));
after(() => fs.rm(tmp, { recursive: true, force: true }));

// a closed square way of 0.001° at (lon, lat), and its nodes; ids from `id`
function square(id: number, lon: number, lat: number, tags: Record<string, string>) {
	const d = 0.001;
	const corners = [
		[lon, lat],
		[lon + d, lat],
		[lon + d, lat + d],
		[lon, lat + d],
	];
	const nodes = corners.map(([x, y], i) => `<node id="${id + i}" version="1" lat="${y}" lon="${x}"/>`);
	const refs = [0, 1, 2, 3, 0].map((i) => `<nd ref="${id + i}"/>`).join('');
	const tag = Object.entries(tags)
		.map(([k, v]) => `<tag k="${k}" v="${v}"/>`)
		.join('');
	return { nodes, way: `<way id="${id}" version="1">${refs}${tag}</way>` };
}

test('import: kinds by precedence, multipolygons, and nothing else', { skip }, async () => {
	const shapes = [
		square(100, 13.0, 52.0, { landuse: 'farmland', natural: 'wood' }), // forest wins over farmland
		square(200, 13.01, 52.0, { landuse: 'residential', leisure: 'park' }), // landuse first
		square(300, 13.02, 52.0, { natural: 'wetland', wetland: 'marsh' }),
		square(400, 13.03, 52.0, { amenity: 'grave_yard', landuse: 'cemetery' }), // grave_yard before cemetery
		square(500, 13.04, 52.0, { leisure: 'park' }),
		square(600, 13.05, 52.0, { landuse: 'military' }), // no Shortbread kind
		square(700, 13.06, 52.0, {}), // the outer ring of the multipolygon below
	];
	const relation =
		'<relation id="1" version="1"><member type="way" ref="700" role="outer"/>' +
		'<tag k="type" v="multipolygon"/><tag k="landuse" v="allotments"/></relation>';
	const xml = path.join(tmp, 'in.osm');
	await fs.writeFile(
		xml,
		'<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6">\n' +
			shapes.flatMap((s) => s.nodes).join('\n') +
			'\n' +
			shapes.map((s) => s.way).join('\n') +
			'\n' +
			relation +
			'\n</osm>\n',
	);

	// the west part: everything but the last two, which lie east of 13.045°
	const west = path.join(tmp, 'west.osm.pbf');
	await extractBoxes(xml, [{ box: { west: 12.9, south: 51.9, east: 13.045, north: 52.1 }, out: west }], tmp);

	assert.deepEqual(await kinds(xml), ['allotments', 'forest', 'grave_yard', 'marsh', 'park', 'residential']);
	assert.deepEqual(await kinds(west), ['forest', 'grave_yard', 'marsh', 'park', 'residential']);
});

// the kinds of an import of `input`, through its VRT
async function kinds(input: string, partBytes?: number): Promise<string[]> {
	const out = path.join(tmp, path.basename(input) + '.vrt');
	await importLand(input, out, path.join(tmp, 'osm'), { partBytes });
	const json = JSON.parse(await runCapture('ogr2ogr', ['-f', 'GeoJSON'], '/vsistdout/', out, 'land'));
	return json.features.map((f: { properties: { kind: string } }) => f.properties.kind).toSorted();
}

test('import: a large input is split in halves, one area across the cut in both', { skip }, async () => {
	const shapes = [
		square(100, -10, 52.0, { landuse: 'forest' }), // west of the cut at 0°
		square(200, -0.0005, 52.0, { landuse: 'residential' }), // across it
		square(300, 10, 52.0, { landuse: 'meadow' }), // east of it
	];
	// and a boundary relation across it, tagged as land use like national parks often are, whose ring has a way
	// east of the cut only: the west part has the area only if the extract completes boundaries too
	const ring = [
		[-0.002, 52.0],
		[0.002, 52.0],
		[0.002, 52.001],
		[-0.002, 52.001],
	];
	const ringNodes = ring.map(([x, y], i) => `<node id="${900 + i}" version="1" lat="${y}" lon="${x}"/>`);
	const way = (id: number, refs: number[]) =>
		`<way id="${id}" version="1">${refs.map((r) => `<nd ref="${900 + r}"/>`).join('')}</way>`;
	const ways = [way(910, [3, 0, 1]), way(911, [1, 2]), way(912, [2, 3])]; // 911 lies east of the cut
	const boundary =
		'<relation id="920" version="1">' +
		[910, 911, 912].map((id) => `<member type="way" ref="${id}" role="outer"/>`).join('') +
		'<tag k="type" v="boundary"/><tag k="boundary" v="national_park"/><tag k="natural" v="grassland"/></relation>';
	const xml = path.join(tmp, 'split.osm');
	await fs.writeFile(
		xml,
		'<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6">\n' +
			[...shapes.flatMap((s) => s.nodes), ...ringNodes].join('\n') +
			'\n' +
			[...shapes.map((s) => s.way), ...ways].join('\n') +
			'\n' +
			boundary +
			'\n</osm>\n',
	);
	// just below the input's size: one split, into parts that are small enough
	const size = (await fs.stat(xml)).size;
	assert.deepEqual(await kinds(xml, size - 1), [
		'forest',
		'grassland',
		'grassland',
		'meadow',
		'residential',
		'residential',
	]);
	assert.deepEqual(await fs.readdir(path.join(tmp, 'split.osm.vrt.parts')), ['0.fgb', '1.fgb']);
	assert.deepEqual(await kinds(xml), ['forest', 'grassland', 'meadow', 'residential']);
});

test('import: no areas at all is an empty layer the burns can filter', { skip }, async () => {
	const xml = path.join(tmp, 'none.osm');
	const { nodes, way } = square(100, 13, 52, { landuse: 'military' });
	await fs.writeFile(xml, `<?xml version="1.0"?>\n<osm version="0.6">\n${nodes.join('\n')}\n${way}\n</osm>\n`);
	assert.deepEqual(await kinds(xml), []);
	const out = path.join(tmp, 'none.osm.vrt');
	const info = await runCapture('ogrinfo', '-so', '-where', "kind IN ('forest')", out, 'land');
	assert.match(info, /Feature Count: 0/);
});

test('GeoJSON lines become CSV of WKT and kind, without the areas that have none', async () => {
	const ring = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 0],
	];
	const lines = [
		{ properties: { landuse: 'forest' }, geometry: { type: 'Polygon', coordinates: [ring] } },
		{ properties: { landuse: 'military' }, geometry: { type: 'Polygon', coordinates: [ring] } },
		{ properties: { leisure: 'park' }, geometry: { type: 'MultiPolygon', coordinates: [[ring], [ring, ring]] } },
	];
	const input = Readable.from([lines.map((l) => JSON.stringify(l)).join('\n') + '\n']);
	let csv = '';
	const output = new Writable({
		write(chunk, _, done) {
			csv += chunk;
			done();
		},
	});
	await toKindsCsv(input, output);
	const r = '(0 0,1 0,1 1,0 0)';
	assert.equal(csv, `WKT,kind\n"MULTIPOLYGON((${r}))",forest\n"MULTIPOLYGON((${r}),(${r},${r}))",park\n`);
});

test('halve splits a box across its longer side', () => {
	assert.deepEqual(halve({ west: -180, south: -90, east: 180, north: 90 }), [
		{ west: -180, south: -90, east: 0, north: 90 },
		{ west: 0, south: -90, east: 180, north: 90 },
	]);
	assert.deepEqual(halve({ west: 0, south: -90, east: 90, north: 90 })[0], {
		west: 0,
		south: -90,
		east: 90,
		north: 0,
	});
});
