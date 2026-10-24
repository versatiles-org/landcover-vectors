// The QGIS style is generated from the same channel table as the tiles, coloured from versatiles-style, so a
// kind versatiles-style does not fill or a malformed colour conversion would silently produce an unstyled layer.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { qgisColor, qgisVectorTileStyle, styledChannels, versatilesFills, filterKinds } from '../lib/style-qgis.ts';
import { channels } from '../config.ts';

describe('qgisColor', () => {
	test('converts #RRGGBB to QGIS ints plus floats, opaque', () => {
		assert.equal(qgisColor('#66AA44'), '102,170,68,255,rgb:0.4,0.6666666666666666,0.26666666666666666,1');
	});

	test('honours an alpha byte when present', () => {
		assert.equal(qgisColor('#00000080'), '0,0,0,128,rgb:0,0,0,0.5019607843137255');
	});

	test('handles the extremes', () => {
		assert.equal(qgisColor('#FFFFFF'), '255,255,255,255,rgb:1,1,1,1');
		assert.equal(qgisColor('#000000'), '0,0,0,255,rgb:0,0,0,1');
	});

	test('accepts lower case and a missing hash', () => {
		assert.equal(qgisColor('#ffffff'), qgisColor('FFFFFF'));
	});
});

describe('filterKinds', () => {
	test("reads the kinds of versatiles-style's two filter shapes", () => {
		assert.deepEqual(filterKinds(['==', ['get', 'kind'], 'glacier']), ['glacier']);
		assert.deepEqual(filterKinds(['in', ['get', 'kind'], ['literal', ['heath', 'scrub']]]), ['heath', 'scrub']);
	});

	test('ignores filters on anything else', () => {
		assert.deepEqual(filterKinds(['==', ['get', 'type'], 'x']), []);
		assert.deepEqual(filterKinds(undefined), []);
	});
});

describe('styledChannels', () => {
	test('is every emitting channel, and only those', () => {
		const styled = styledChannels();
		assert.equal(styled.length, channels.filter((c) => c.layer && c.kind).length);
		assert.ok(styled.every((c) => c.color && c.kind && c.layer));
		assert.ok(!styled.some((c) => c.layer === null));
	});

	test("takes each kind's colour from versatiles-style's colorful style, per layer", () => {
		const fills = versatilesFills();
		for (const c of styledChannels()) assert.equal(c.color, fills.get(`${c.layer}:${c.kind}`), c.kind);
		assert.match(fills.get('land:forest') ?? '', /^#[0-9A-F]{6}$/i);
	});

	test('a kind versatiles-style does not fill is an error', () => {
		assert.throws(() => styledChannels(channels, new Map()), /no fill for kind "forest" in layer "land"/);
	});
});

describe('qgisVectorTileStyle', () => {
	const xml = qgisVectorTileStyle(styledChannels());

	test('emits one rule per kind, scoped to its layer', () => {
		for (const c of styledChannels()) {
			assert.ok(
				xml.includes(`layer="${c.layer}" enabled="1" name="${c.kind}"`),
				`no rule for ${c.kind} in ${c.layer}`,
			);
			assert.ok(xml.includes(qgisColor(c.color)), `colour of ${c.kind} missing`);
		}
		assert.equal(xml.match(/<style /g)?.length, styledChannels().length);
	});

	test('filters on the kind attribute', () => {
		assert.ok(xml.includes(`expression="&quot;kind&quot; = 'forest'"`));
	});

	test('is balanced, self-contained XML', () => {
		assert.ok(xml.startsWith('<!DOCTYPE qgis'));
		assert.ok(xml.trimEnd().endsWith('</qgis>'));
		for (const tag of ['qgis', 'renderer', 'styles', 'symbols']) {
			assert.equal(
				xml.match(new RegExp(`<${tag}[ >]`, 'g'))?.length,
				xml.match(new RegExp(`</${tag}>`, 'g'))?.length,
				`${tag} tags are unbalanced`,
			);
		}
	});

	test('an empty channel list still yields a valid document', () => {
		const empty = qgisVectorTileStyle([]);
		assert.ok(empty.includes('<styles>'));
		assert.equal(empty.match(/<style /g), null);
	});
});
