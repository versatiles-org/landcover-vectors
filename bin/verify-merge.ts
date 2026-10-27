// Check the merge against real tiles: each kind from exactly one source per zoom, nothing lost on the way.
//
//   npm run verify-merge                                               # the two published containers
//   npm run verify-merge -- --landcover data/landcover-vectors.versatiles   # a local build before upload
//   npm run verify-merge -- --zoom 9-12 --point 9.0,50.6                 # one place, around the handover
//
// test/handover.test.ts checks that the filters are generated from `channels`; this checks what versatiles
// does with them. It opens five sources with @versatiles/versatiles-rs — both containers raw, each filtered,
// and the merge (lib/handover.ts) — reads the tile under each sample point at each zoom from all five, and counts the
// features per layer and `kind`. `channels` (config.ts) says which source owns a kind at a zoom; then per tile:
//
//   overlap    the other source still has features of the kind after its filter
//   over-drop  the owner's filter removed some of its own features (what versatiles 4.14 did to everything)
//   merge      the merged tile does not hold exactly the two filtered tiles' features
//
// Any of these fails the run. A kind whose non-owner had features that were dropped, in a tile where the
// owner has none, is a gap: reported, not failed, since that is the documented thinning at the handover.

import { parseArgs } from 'node:util';

import { TileSource, TileCoord } from '@versatiles/versatiles-rs';

import { mergePipeline, osmFilter, landcoverFilter } from '../lib/handover.ts';
import { channels, OSM_URL, LANDCOVER_URL } from '../config.ts';

const { values: opt } = parseArgs({
	options: {
		osm: { type: 'string', default: OSM_URL },
		landcover: { type: 'string', default: LANDCOVER_URL },
		zoom: { type: 'string', default: '0-14' },
		point: { type: 'string', multiple: true }, // "lon,lat", replaces the default samples
		unfiltered: { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
});

if (opt.help) {
	console.log(
		[
			'Usage: npm run verify-merge -- [options]',
			'  --osm <path|url>        OSM Shortbread container (default: the published one)',
			'  --landcover <path|url>  landcover container (default: the published one)',
			'  --zoom <min-max>        zooms to check (default 0-14)',
			'  --point <lon,lat>       sample point, repeatable (default: one per landscape below)',
			'  --unfiltered            merge without the filters — a self-test: the check must fail',
		].join('\n'),
	);
	process.exit(0);
}

// one point per landscape, so every kind turns up somewhere: [lon, lat, what it is there for]
const SAMPLES: [number, number, string][] = [
	[9.0, 50.6, 'Hesse: forest, farmland, OSM land use wall to wall'],
	[13.4, 52.52, 'Berlin: residential, urban kinds'],
	[12.68, 53.43, 'Müritz: a lake'],
	[16.5, 78.6, 'Spitsbergen: glacier'],
	[-88, 55, 'Hudson Bay: marsh'],
	[89.2, 21.9, 'Sundarbans: swamp'],
	[70, 68, 'Yamal: heath'],
	[134, -25, 'Australian outback: scrub'],
	[4, 23, 'Sahara: bare_rock'],
	[-93.5, 42, 'Iowa: farmland OSM rarely maps'],
	[31.0, 30.8, 'Nile delta: farmland, residential, water'],
	[114.5, 0.5, 'Borneo: forest'],
	[-55.5, -12.5, 'Mato Grosso: grassland, farmland'],
];

const points: [number, number, string][] = opt.point
	? opt.point.map((p) => {
			const [lon, lat] = p.split(',').map(Number);
			if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(`bad --point "${p}" — expected lon,lat`);
			return [lon, lat, p];
		})
	: SAMPLES;
const m = opt.zoom.match(/^(\d+)(?:-(\d+))?$/);
if (!m) throw new Error(`bad --zoom "${opt.zoom}" — expected "min-max"`);
const [minZoom, maxZoom] = [Number(m[1]), Number(m[2] ?? m[1])];

// --- a minimal MVT reader: per layer, the number of features per `kind` --------------------------------

type Counts = Map<string, number>; // "layer/kind" → features

function readTile(buf: Uint8Array): Counts {
	let pos = 0;
	const varint = (): number => {
		let v = 0;
		for (let shift = 0; ; shift += 7) {
			const b = buf[pos++];
			v += (b & 0x7f) * 2 ** shift;
			if (b < 0x80) return v;
		}
	};
	// calls `field` for each field up to `end`; a field it does not read is skipped
	const fields = (end: number, field: (tag: number, end: number) => void): void => {
		while (pos < end) {
			const key = varint();
			const [tag, wire] = [key >>> 3, key & 7];
			if (wire === 2) {
				const len = varint();
				const fieldEnd = pos + len;
				field(tag, fieldEnd);
				pos = fieldEnd;
			} else if (wire === 0) varint();
			else if (wire === 1) pos += 8;
			else if (wire === 5) pos += 4;
			else throw new Error(`unexpected wire type ${wire}`);
		}
	};
	const text = (end: number): string => new TextDecoder().decode(buf.subarray(pos, end));

	const counts: Counts = new Map();
	fields(buf.length, (tag, end) => {
		if (tag !== 3) return; // Tile.layers
		let name = '';
		const keys: string[] = [];
		const values: (string | undefined)[] = [];
		const featureTags: number[][] = [];
		fields(end, (tag, end) => {
			if (tag === 1) name = text(end);
			else if (tag === 3) keys.push(text(end));
			else if (tag === 4) {
				let value: string | undefined;
				fields(end, (tag, end) => {
					if (tag === 1) value = text(end); // only string values can be a kind
				});
				values.push(value);
			} else if (tag === 2) {
				const tags: number[] = [];
				fields(end, (tag, end) => {
					if (tag === 2) while (pos < end) tags.push(varint()); // packed key/value index pairs
				});
				featureTags.push(tags);
			}
		});
		const kindKey = keys.indexOf('kind');
		for (const tags of featureTags) {
			let kind = '';
			for (let i = 0; i < tags.length; i += 2) if (tags[i] === kindKey) kind = values[tags[i + 1]] ?? '';
			const k = `${name}/${kind}`;
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
	});
	return counts;
}

// --- who should supply a kind at a zoom -------------------------------------------------------------

type Owner = 'osm' | 'landcover';

// the landcover up to its cutoff, unless OSM maps the kind better from `osmFrom` on; every other kind is OSM's
function owner(key: string, z: number): Owner {
	const c = channels.find((c) => c.layer && c.kind && `${c.layer}/${c.kind}` === key);
	if (!c || z > c.maxZoom) return 'osm';
	if (c.osmFrom !== undefined && z >= c.osmFrom) return 'osm';
	return 'landcover';
}

// --- open the five sources -----------------------------------------------------------------------------

// The package is pinned in package.json, so it is ≥ MIN_VERSATILES (lib/handover.ts) — no version check needed.
const SOURCES = ['osm', 'landcover', 'osm_kept', 'landcover_kept', 'merged'] as const;
type Source = (typeof SOURCES)[number];
// --unfiltered: the merge the README warns about, to see that this check catches it
const filtered = (filename: string, filter: string): string =>
	`from_container filename="${filename}"` + (opt.unfiltered ? '' : ` | ${filter}`);
const merged = opt.unfiltered
	? `from_merged_vector [ ${filtered(opt.osm, '')}, ${filtered(opt.landcover, '')} ]`
	: mergePipeline(opt.osm, opt.landcover);
const source: Record<Source, TileSource> = {
	osm: await TileSource.fromPath(opt.osm),
	landcover: await TileSource.fromPath(opt.landcover),
	osm_kept: await TileSource.fromVpl(filtered(opt.osm, osmFilter())),
	landcover_kept: await TileSource.fromVpl(filtered(opt.landcover, landcoverFilter())),
	merged: await TileSource.fromVpl(merged),
};

// getTile returns the tile decompressed, whatever metadata().tileCompression says
async function counts(s: Source, z: number, x: number, y: number): Promise<Counts> {
	const buf = await source[s].getTile(z, x, y);
	if (!buf || buf.length === 0) return new Map();
	if (buf[0] !== 0x1a) throw new Error(`${s} ${z}/${x}/${y}: not an uncompressed vector tile`);
	return readTile(buf);
}

// --- check every tile -----------------------------------------------------------------------------------

const tiles = new Map<string, { z: number; x: number; y: number; where: string }>();
for (let z = minZoom; z <= maxZoom; z++)
	for (const [lon, lat, where] of points) {
		const { x, y } = TileCoord.fromGeo(lon, lat, z);
		const id = `${z}/${x}/${y}`;
		if (!tiles.has(id)) tiles.set(id, { z, x, y, where: where.split(':')[0] });
	}

const failures: string[] = [];
// "layer/kind" → zoom → which sources the merge drew it from, and in how many tiles it was dropped for nothing
const seen = new Map<string, Map<number, Set<Owner>>>();
const gaps = new Map<string, Map<number, string[]>>();
const note = <T>(map: Map<string, Map<number, T>>, key: string, z: number, init: () => T): T => {
	if (!map.has(key)) map.set(key, new Map());
	const byZoom = map.get(key)!;
	if (!byZoom.has(z)) byZoom.set(z, init());
	return byZoom.get(z)!;
};

let done = 0;
const queue = [...tiles.values()];
async function worker(): Promise<void> {
	for (let t = queue.shift(); t; t = queue.shift()) {
		const { z, x, y, where } = t;
		const id = `${z}/${x}/${y} (${where})`;
		const c = Object.fromEntries(
			await Promise.all(SOURCES.map(async (s) => [s, await counts(s, z, x, y)] as const)),
		) as Record<Source, Counts>;
		const n = (s: Source, key: string): number => c[s].get(key) ?? 0;
		const keys = new Set(SOURCES.flatMap((s) => [...c[s].keys()]));
		for (const key of keys) {
			const own = owner(key, z);
			const other: Owner = own === 'osm' ? 'landcover' : 'osm';
			if (n(`${other}_kept`, key) > 0)
				failures.push(
					`overlap    ${id} ${key}: ${n(`${other}_kept`, key)} ${other} features left beside the ${own}'s`,
				);
			if (n(`${own}_kept`, key) < n(own, key))
				failures.push(`over-drop  ${id} ${key}: ${own} kept ${n(`${own}_kept`, key)} of its ${n(own, key)}`);
			const sum = n('osm_kept', key) + n('landcover_kept', key);
			if (n('merged', key) !== sum)
				failures.push(`merge      ${id} ${key}: merged has ${n('merged', key)}, sources ${sum}`);

			if (!key.startsWith('land/') && !key.startsWith('water_polygons/')) continue;
			const from = note(seen, key, z, () => new Set<Owner>());
			for (const s of ['osm', 'landcover'] as const) if (n(`${s}_kept`, key) > 0) from.add(s);
			if (n(other, key) > 0 && n(own, key) === 0) note(gaps, key, z, () => []).push(`${x}/${y} ${where}`);
		}
		process.stderr.write(`\r${++done}/${tiles.size} tiles`);
	}
}
await Promise.all(Array.from({ length: 6 }, worker));
process.stderr.write('\n');

// --- report -------------------------------------------------------------------------------------------

// rows: every kind of land and water_polygons; columns: zooms. L = landcover, O = OSM, ! = both, · = none
const zooms = Array.from({ length: maxZoom - minZoom + 1 }, (_, i) => minZoom + i);
const rows = [...seen.keys()].sort();
const width = Math.max(...rows.map((r) => r.length), 4);
console.log('\nwhere the merge takes each kind from (L landcover, O OSM, ! both, · neither; * unexpected)\n');
console.log(`${'zoom'.padEnd(width)}  ${zooms.map((z) => String(z).padStart(4)).join('')}`);
for (const key of rows) {
	const cells = zooms.map((z) => {
		const from = seen.get(key)?.get(z) ?? new Set();
		const got = from.size === 2 ? '!' : from.has('landcover') ? 'L' : from.has('osm') ? 'O' : '·';
		const want = owner(key, z) === 'landcover' ? 'L' : 'O';
		return got === want || got === '·' ? `  ${got} ` : `  ${got}*`; // * = not the expected source
	});
	console.log(`${key.padEnd(width)}  ${cells.join('')}`);
}

if (gaps.size > 0) {
	console.log('\ngaps: the kind was dropped from one source and the other has none in that tile\n');
	for (const [key, byZoom] of [...gaps].sort())
		for (const [z, at] of [...byZoom].sort((a, b) => a[0] - b[0]))
			console.log(`  z${String(z).padEnd(3)}${key.padEnd(width)}  ${at.length} tile(s): ${at.join(', ')}`);
}

console.log();
if (failures.length > 0) {
	for (const f of failures) console.log(`✗ ${f}`);
	console.log(`\n✗ ${failures.length} problem(s) in ${tiles.size} tiles`);
	process.exitCode = 1;
} else console.log(`✓ ${tiles.size} tiles, z${minZoom}–${maxZoom}: every kind from one source, nothing lost`);
