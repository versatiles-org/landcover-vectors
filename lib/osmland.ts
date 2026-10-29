// OSM's land use, imported from the OSM planet: the polygons of Shortbread's `land` layer, by the same rules, but
// straight from the data instead of decoded out of the OSM container's tiles. The tiles are what a map draws from
// z11 on, but as a source they are generalised (nothing under a pixel at z11), lack what Shortbread starts later
// (cemeteries, z13), and would take decoding millions of tiles with GDAL's MVT reader, which trips over their
// invalid polygons. The planet is one file, the same everywhere, and imports in two steps:
//
//   downloadLanduse   the planet (~95 GB), checked against its MD5, then cut by `osmium tags-filter` to the areas
//                     the rules below accept (~16 GB), osm-landuse-<date>.osm.pbf; the planet itself is removed
//   extractBoxes      `osmium extract` of boxes out of that, for the experiment's regions (one pass for all)
//   importLand        osmium assembles the areas, and the rules below give each its kind, into FlatGeobufs in
//                     EPSG:3857 with a `kind` field, and a VRT that reads them as one layer `land`: what
//                     lib/landburn.ts burns from — the whole cut for the download (osm-landuse-<date>.vrt), each
//                     region's extract for the experiment
//
// The rules are planetiler-shortbread's (src/main/java/org/versatiles/shortbread/layers/Land.java), which builds
// the OSM container's `land` layer, and must follow it when it changes.

import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { run, runQuiet, spawnPiped, atomic } from './worldcover.ts';
import { timed } from './timing.ts';
import type { LonLat } from './coverage.ts';
import { dir, PLANET_DIR_URL } from '../config.ts';

// Land.java's table, in its order: the first rule a feature matches decides its kind, which is the tag's value
// unless the rule names one. (Land.java also sets each kind's minimum zoom, which is the style's business here.)
export type LandRule = { tags: Record<string, string[]>; kind?: string };
export const LAND_RULES: LandRule[] = [
	{ tags: { landuse: ['forest'], natural: ['wood'] }, kind: 'forest' },
	{
		tags: {
			landuse: [
				...['residential', 'industrial', 'commercial', 'retail', 'railway', 'landfill', 'brownfield'],
				...['greenfield', 'farmyard', 'farmland'],
			],
		},
	},
	{
		tags: {
			landuse: [
				...['grass', 'meadow', 'orchard', 'vineyard', 'allotments', 'village_green', 'recreation_ground'],
				...['greenhouse_horticulture', 'plant_nursery', 'quarry'],
			],
		},
	},
	{ tags: { natural: ['sand', 'beach'] } },
	{ tags: { natural: ['heath', 'scrub', 'grassland', 'bare_rock', 'scree', 'shingle'] } },
	{ tags: { wetland: ['swamp', 'bog', 'string_bog', 'wet_meadow', 'marsh'] } },
	{ tags: { amenity: ['grave_yard'] } },
	{ tags: { landuse: ['garages'] } },
	{ tags: { leisure: ['golf_course', 'park', 'garden', 'playground', 'miniature_golf'] } },
	{ tags: { landuse: ['cemetery'] } },
];

// every value the rules accept, per key, in first-seen order
function valuesByKey(rules = LAND_RULES): Map<string, string[]> {
	const keys = new Map<string, string[]>();
	for (const r of rules)
		for (const [k, vs] of Object.entries(r.tags)) {
			const all = keys.get(k) ?? [];
			for (const v of vs) if (!all.includes(v)) all.push(v);
			keys.set(k, all);
		}
	return keys;
}

// the kinds the rules can produce
export function landKinds(rules = LAND_RULES): string[] {
	return [...new Set(rules.flatMap((r) => (r.kind ? [r.kind] : Object.values(r.tags).flat())))];
}

// osmium tags-filter's expressions: areas (closed ways and multipolygons) with a value the rules accept, which is
// Land.java's own filter; the nodes and ways they reference come along
export function tagsFilterExpressions(rules = LAND_RULES): string[] {
	return [...valuesByKey(rules)].map(([k, vs]) => `a/${k}=${vs.join(',')}`);
}

// a feature's kind by the rules, from its tags; null if it has none
export function kindOf(tags: Record<string, unknown>, rules = LAND_RULES): string | null {
	for (const r of rules) {
		const entries = Object.entries(r.tags);
		if (!r.kind && entries.length > 1) throw new Error('a rule over several keys needs a kind');
		for (const [k, vs] of entries) {
			const v = tags[k];
			if (typeof v === 'string' && vs.includes(v)) return r.kind ?? v;
		}
	}
	return null;
}

// osmium export's configuration: every closed way and multipolygon is an area (the cut holds only those with a
// value the rules accept), and the rules' keys are its only properties
export function exportConfig(rules = LAND_RULES): object {
	const attributes = ['type', 'id', 'version', 'changeset', 'timestamp', 'uid', 'user', 'way_nodes'];
	return {
		attributes: Object.fromEntries(attributes.map((a) => [a, false])),
		format_options: {},
		linear_tags: false,
		area_tags: true,
		include_tags: [...valuesByKey(rules).keys()],
	};
}

// ---------------------------------------------------------------- the planet

const LANDUSE_PREFIX = 'osm-landuse-';
const landusePath = (date: string) => path.join(dir.source, `${LANDUSE_PREFIX}${date}.osm.pbf`);
// its import (importLand), what the download burns into the source
export const landuseImport = (date: string) => path.join(dir.source, `${LANDUSE_PREFIX}${date}.vrt`);

// the newest land-use file downloaded, and its planet's date (YYMMDD), or null
export async function findLanduse(): Promise<{ file: string; date: string } | null> {
	const files = existsSync(dir.source) ? await fs.readdir(dir.source) : [];
	const dates = files.flatMap((f) => f.match(/^osm-landuse-(\d{6})\.osm\.pbf$/)?.[1] ?? []).sort();
	const date = dates.at(-1);
	return date ? { file: landusePath(date), date } : null;
}

// the newest dated planet in the planet directory: planet-<YYMMDD>.osm.pbf. The dated name, not planet-latest,
// so a download resumed after the weekly update still fetches the same file.
export async function latestPlanet(): Promise<{ date: string; url: string }> {
	const res = await fetch(PLANET_DIR_URL);
	if (!res.ok) throw new Error(`${PLANET_DIR_URL}: HTTP ${res.status}`);
	const dates = [...(await res.text()).matchAll(/planet-(\d{6})\.osm\.pbf"/g)].map((m) => m[1]).sort();
	const date = dates.at(-1);
	if (!date) throw new Error(`${PLANET_DIR_URL}: no planet-YYMMDD.osm.pbf listed`);
	return { date, url: new URL(`planet-${date}.osm.pbf`, PLANET_DIR_URL).href };
}

async function md5(file: string): Promise<string> {
	const hash = createHash('md5');
	for await (const chunk of createReadStream(file, { highWaterMark: 1 << 24 })) hash.update(chunk);
	return hash.digest('hex');
}

// Fetch the newest planet and cut it to the land use (an hour or two, most of it the download), unless a land-use
// file is there already. Needs ~110 GB on the way: the planet and the cut, before the planet is removed. A broken
// download resumes where it stopped; one that does not match its MD5 is removed.
export async function downloadLanduse(): Promise<{ file: string; date: string }> {
	const present = await findLanduse();
	if (present) {
		console.error('OSM land use present: %s (delete it to refresh)', present.file);
		return present;
	}
	const { date, url } = await latestPlanet();
	const planet = path.join(dir.source, `planet-${date}.osm.pbf`);
	await fs.mkdir(dir.source, { recursive: true });
	await timed('planet', async () => {
		const part = planet + '.part';
		if (!existsSync(planet)) {
			console.error('Downloading the OSM planet %s …', url);
			await run('curl', '-fL', ['-C', '-'], ['--retry', 5], ['--retry-delay', 2], ['-o', part], url);
			await fs.rename(part, planet);
		}
		const want = (await (await fetch(url + '.md5')).text()).split(/\s/)[0];
		console.error('Checking %s against its MD5 …', planet);
		const got = await md5(planet);
		if (got !== want) {
			await fs.rm(planet, { force: true });
			throw new Error(`${planet}: MD5 ${got}, expected ${want} — removed, run again to download it anew`);
		}
	});
	const out = landusePath(date);
	console.error('Cutting the planet to its land use → %s …', out);
	await timed('landuse', () =>
		atomic(out, (tmp) =>
			run(
				'osmium',
				'tags-filter',
				'--overwrite',
				['-f', 'pbf'], // the temp file's name does not end in .pbf
				['-o', tmp],
				planet,
				tagsFilterExpressions(),
			),
		),
	);
	await fs.rm(planet, { force: true });
	console.error('✓ OSM land use ready: %s', out);
	return { file: out, date };
}

// ---------------------------------------------------------------- extracts and the import

export type Box = { box: LonLat; out: string };

// cut boxes out of a PBF in one pass. `smart` completes every multipolygon that reaches into a box, so an area
// is never cut off at the edge — and, told to, every boundary: osmium export makes areas of those too, and some,
// national parks above all, carry a land use (the Lower Oder Valley is natural=grassland).
export async function extractBoxes(pbf: string, boxes: Box[], tmpdir: string): Promise<void> {
	if (!boxes.length) return;
	await fs.mkdir(tmpdir, { recursive: true });
	const config = path.join(tmpdir, 'extracts.json');
	const tmp = (b: Box) => path.join(path.dirname(b.out), '.tmp-' + path.basename(b.out));
	const extracts = boxes.map((b) => ({
		output: tmp(b),
		output_format: 'pbf',
		bbox: [b.box.west, b.box.south, b.box.east, b.box.north],
	}));
	await fs.writeFile(config, JSON.stringify({ extracts }));
	await runQuiet(
		'osmium',
		'extract',
		'--overwrite',
		['-s', 'smart'],
		['-S', 'types=multipolygon,boundary'],
		['-c', config],
		pbf,
	);
	for (const b of boxes) await fs.rename(tmp(b), b.out);
	await fs.rm(config, { force: true });
}

// Assemble a PBF's areas and give each its kind: `out`, a VRT that reads them as one layer `land` (EPSG:3857, field
// `kind`) from FlatGeobufs in `out`.parts/. osmium assembles the areas, with every node's location in an index in
// memory, 16 bytes a node. The planet's cut has 2.2 billion: ~35 GB, more than a machine of this pipeline's size
// has, and with the index as a file the export waits on the disk: ~17 hours at the rate it ran. So a PBF larger than
// `partBytes` is split first, in halves of its box, again and again, until each part's index fits (~4.5 GB at the
// default): about 16 parts for the planet. `osmium extract` keeps every area that reaches into a half whole, so
// one across a cut is in both parts, and burns the same pixels twice. The halves go to `tmpdir`, each removed once
// it is split or imported.
export async function importLand(
	pbf: string,
	out: string,
	tmpdir: string,
	opts: { progress?: boolean; partBytes?: number } = {},
): Promise<void> {
	const partBytes = opts.partBytes ?? PART_BYTES;
	const partsDir = out + '.parts';
	await fs.rm(partsDir, { recursive: true, force: true });
	await fs.mkdir(partsDir, { recursive: true });
	await fs.mkdir(tmpdir, { recursive: true });
	const parts: string[] = [];
	const log = (...args: unknown[]) => opts.progress && console.error(...args);

	// split `file` (of `box`) until it is small enough, and import each part; `file` is removed unless it is the input
	const importPart = async (file: string, box: LonLat, depth: number): Promise<void> => {
		const size = (await fs.stat(file)).size;
		if (size > partBytes && depth < MAX_SPLITS) {
			const halves = halve(box);
			const files = halves.map((_, i) => path.join(tmpdir, `part-${depth + 1}-${parts.length}-${i}.osm.pbf`));
			log('  splitting %s (%s GB) …', boxName(box), (size / 1e9).toFixed(1));
			await extractBoxes(
				file,
				halves.map((b, i) => ({ box: b, out: files[i] })),
				tmpdir,
			);
			if (file !== pbf) await fs.rm(file, { force: true });
			for (const [i, b] of halves.entries()) await importPart(files[i], b, depth + 1);
			return;
		}
		const part = path.join(partsDir, `${parts.length}.fgb`);
		log('  importing part %d, %s (%s GB) …', parts.length, boxName(box), (size / 1e9).toFixed(1));
		await exportKinds(file, part, tmpdir);
		parts.push(part);
		if (file !== pbf) await fs.rm(file, { force: true });
	};
	await importPart(pbf, WORLD, 0);
	await atomic(out, (tmp) => fs.writeFile(tmp, unionVrt(parts, path.dirname(out))));
}

const PART_BYTES = 1.5e9; // ~200 million nodes: osmium peaked at 4.4 GB on Europe's 1.5 GB part
const MAX_SPLITS = 12; // a part that is still too large then is imported as it is
const WORLD: LonLat = { west: -180, south: -90, east: 180, north: 90 };
const boxName = (b: LonLat) => `${b.west},${b.south},${b.east},${b.north}`;

// the two halves of a box, across its longer side (in degrees)
export function halve(b: LonLat): [LonLat, LonLat] {
	if (b.east - b.west >= b.north - b.south) {
		const mid = (b.west + b.east) / 2;
		return [
			{ ...b, east: mid },
			{ ...b, west: mid },
		];
	}
	const mid = (b.south + b.north) / 2;
	return [
		{ ...b, north: mid },
		{ ...b, south: mid },
	];
}

// One part's areas, with their kinds, as a FlatGeobuf `out` (with a layer and its field even if it has none):
// osmium's GeoJSON lines, each given its kind here and handed on as CSV, WKT and kind, to ogr2ogr. A pipe all the
// way: GDAL's own GeoJSON reader holds a whole file in memory, about four times its size, ~35 GB for Europe's part.
async function exportKinds(pbf: string, out: string, tmpdir: string): Promise<void> {
	const config = path.join(tmpdir, 'export.json');
	await fs.writeFile(config, JSON.stringify(exportConfig()));
	await atomic(out, async (tmp) => {
		const osmium = spawnPiped(
			'osmium',
			{ stdout: true },
			'export',
			['-c', config],
			'--geometry-types=polygon',
			['-f', 'geojsonseq'],
			['-x', 'print_record_separator=false'],
			['-o', '-'],
			pbf,
		);
		const ogr = spawnPiped(
			'ogr2ogr',
			{ stdin: true },
			['-f', 'FlatGeobuf'],
			['-oo', 'GEOM_POSSIBLE_NAMES=WKT'],
			['-oo', 'KEEP_GEOM_COLUMNS=NO'],
			['-s_srs', 'EPSG:4326'],
			['-t_srs', 'EPSG:3857'],
			['-nln', 'land'],
			['-nlt', 'MULTIPOLYGON'],
			tmp,
			'CSV:/vsistdin/',
		);
		try {
			await Promise.all([osmium.done, ogr.done, toKindsCsv(osmium.child.stdout!, ogr.child.stdin!)]);
		} catch (err) {
			osmium.child.kill();
			ogr.child.kill();
			throw err;
		}
	});
	await fs.rm(config, { force: true });
}

// GeoJSON lines of areas → CSV of WKT (always a MULTIPOLYGON) and kind; areas without a kind are left out
export async function toKindsCsv(input: Readable, output: Writable): Promise<void> {
	const ring = (r: number[][]) => '(' + r.map((c) => `${c[0]} ${c[1]}`).join(',') + ')';
	const polygon = (p: number[][][]) => '(' + p.map(ring).join(',') + ')';
	let buffer = 'WKT,kind\n';
	const flush = async () => {
		if (!output.write(buffer)) await new Promise((resolve) => output.once('drain', resolve));
		buffer = '';
	};
	for await (const line of createInterface({ input, crlfDelay: Infinity })) {
		if (!line) continue;
		const f = JSON.parse(line) as {
			properties: Record<string, unknown>;
			geometry: { type: string; coordinates: unknown };
		};
		const kind = kindOf(f.properties);
		if (!kind) continue;
		const g = f.geometry;
		const polygons = g.type === 'Polygon' ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][]);
		buffer += `"MULTIPOLYGON(${polygons.map(polygon).join(',')})",${kind}\n`;
		if (buffer.length > 1 << 20) await flush();
	}
	await flush();
	output.end();
}

// a VRT that reads the parts as one layer `land`, paths relative to the VRT's folder `base`
export function unionVrt(parts: string[], base: string): string {
	const layers = parts.map(
		(p, i) =>
			`    <OGRVRTLayer name="part${i}"><SrcDataSource relativeToVRT="1">${path.relative(base, p)}</SrcDataSource><SrcLayer>land</SrcLayer></OGRVRTLayer>`,
	);
	return [
		'<OGRVRTDataSource>',
		'  <OGRVRTUnionLayer name="land">',
		...layers,
		'    <GeometryType>wkbMultiPolygon</GeometryType>',
		'    <LayerSRS>EPSG:3857</LayerSRS>',
		'  </OGRVRTUnionLayer>',
		'</OGRVRTDataSource>',
		'',
	].join('\n');
}
