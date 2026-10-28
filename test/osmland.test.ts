// OSM's land use from the planet (lib/osmland.ts): the rules must give the kinds Shortbread's schema has, in
// Land.java's precedence, and the import must turn real OSM areas — ways and multipolygons — into them. Runs GDAL's
// OSM driver and osmium on a tiny hand-made file, so it is skipped where they are not installed.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { skipWithout } from './tools.ts';
import {
	LAND_RULES,
	landKinds,
	tagsFilterExpressions,
	kindSql,
	osmconf,
	importLand,
	extractBoxes,
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

	test('the SQL quotes the keys and keeps the order', () => {
		const sql = kindSql('lu');
		assert.match(
			sql,
			/^SELECT \* FROM \(SELECT geometry, CASE WHEN "landuse" IN \('forest'\) OR "natural" IN \('wood'\) THEN 'forest' WHEN "landuse" IN \('residential',/,
		);
		assert.ok(sql.indexOf("'garages'") < sql.indexOf("'golf_course'"));
		assert.match(sql, /FROM lu\) WHERE kind IS NOT NULL$/);
		assert.throws(() => kindSql('lu', [{ tags: { a: ['x'], b: ['y'] } }]), /needs a kind/);
	});

	test('the driver reads only the keys, and closed ways with them are areas', () => {
		const conf = osmconf();
		assert.match(conf, /closed_ways_are_polygons=landuse,natural,wetland,amenity,leisure\n/);
		assert.match(
			conf,
			/\[multipolygons\]\nosm_id=no\nattributes=landuse,natural,wetland,amenity,leisure\nother_tags=no/,
		);
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

	const kinds = async (pbf: string) => {
		const out = path.join(tmp, path.basename(pbf) + '.fgb');
		await importLand(pbf, out, path.join(tmp, 'osm'));
		const json = JSON.parse(await runCapture('ogr2ogr', ['-f', 'GeoJSON'], '/vsistdout/', out));
		return json.features.map((f: { properties: { kind: string } }) => f.properties.kind).toSorted();
	};
	assert.deepEqual(await kinds(xml), ['allotments', 'forest', 'grave_yard', 'marsh', 'park', 'residential']);
	assert.deepEqual(await kinds(west), ['forest', 'grave_yard', 'marsh', 'park', 'residential']);
});
