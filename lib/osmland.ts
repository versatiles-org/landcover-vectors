// OSM's land use, imported from the OSM planet: the polygons of Shortbread's `land` layer, by the same rules, but
// straight from the data instead of decoded out of the OSM container's tiles. The tiles are what a map draws from
// z11 on, but as a source they are generalised (nothing under a pixel at z11), lack what Shortbread starts later
// (cemeteries, z13), and would take decoding millions of tiles with GDAL's MVT reader, which trips over their
// invalid polygons. The planet is one file, the same everywhere, and imports in two steps:
//
//   downloadLanduse   the planet (~95 GB), checked against its MD5, then cut by `osmium tags-filter` to the areas
//                     the rules below accept (~16 GB), osm-landuse-<date>.osm.pbf; the planet itself is removed
//   extractBoxes      `osmium extract` of boxes out of that, for the experiment's regions (one pass for all)
//   importLand        GDAL's OSM driver assembles the areas, and one SQL CASE picks each one's kind, into a
//                     FlatGeobuf in EPSG:3857 with a `kind` field: what lib/regionsource.ts burns from
//
// The rules are planetiler-shortbread's (src/main/java/org/versatiles/shortbread/layers/Land.java), which builds
// the OSM container's `land` layer, and must follow it when it changes.

import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { run, runQuiet, runProgress, atomic, type Arg } from './worldcover.ts';
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

// the SELECT that turns `layer`'s features, with the rules' keys as fields, into `kind` and geometry
export function kindSql(layer: string, rules = LAND_RULES): string {
	const field = (k: string) => `"${k}"`; // `natural` is an SQL keyword
	const list = (vs: string[]) => vs.map((v) => `'${v}'`).join(',');
	const when = rules.map((r) => {
		const tags = Object.entries(r.tags);
		const cond = tags.map(([k, vs]) => `${field(k)} IN (${list(vs)})`).join(' OR ');
		const kind = r.kind ? `'${r.kind}'` : field(tags[0][0]);
		if (!r.kind && tags.length > 1) throw new Error('a rule over several keys needs a kind');
		return `WHEN ${cond} THEN ${kind}`;
	});
	return `SELECT * FROM (SELECT geometry, CASE ${when.join(' ')} END AS kind FROM ${layer}) WHERE kind IS NOT NULL`;
}

// GDAL's OSM driver configuration: closed ways with one of the keys are areas, and the keys are the fields of its
// `multipolygons` layer, which holds both those and the multipolygon relations. Nothing else is read.
export function osmconf(rules = LAND_RULES): string {
	const keys = [...valuesByKey(rules).keys()].join(',');
	const none = (layer: string) => `[${layer}]\nosm_id=no\nattributes=\nother_tags=no\n`;
	return [
		`[general]\nclosed_ways_are_polygons=${keys}\nreport_all_nodes=no\nreport_all_ways=no\n`,
		none('points'),
		none('lines'),
		`[multipolygons]\nosm_id=no\nattributes=${keys}\nother_tags=no\n`,
		none('multilinestrings'),
		none('other_relations'),
	].join('\n');
}

// ---------------------------------------------------------------- the planet

const LANDUSE_PREFIX = 'osm-landuse-';
const landusePath = (date: string) => path.join(dir.source, `${LANDUSE_PREFIX}${date}.osm.pbf`);

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
export async function downloadLanduse(): Promise<string> {
	const present = await findLanduse();
	if (present) {
		console.error('OSM land use present: %s (delete it to refresh)', present.file);
		return present.file;
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
	return out;
}

// ---------------------------------------------------------------- extracts and the import

export type Box = { box: LonLat; out: string };

// cut boxes out of a PBF in one pass. `smart` completes every multipolygon that reaches into a box, so an area
// is never cut off at the edge.
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
	await runQuiet('osmium', 'extract', '--overwrite', ['-s', 'smart'], ['-c', config], pbf);
	for (const b of boxes) await fs.rename(tmp(b), b.out);
	await fs.rm(config, { force: true });
}

// Assemble a PBF's areas and give each its kind: `out`, a FlatGeobuf (EPSG:3857, layer `land`, field `kind`).
// The driver keeps its node index in temp files, which go to `tmpdir`.
export async function importLand(pbf: string, out: string, tmpdir: string, opts: { progress?: boolean } = {}) {
	await fs.mkdir(tmpdir, { recursive: true });
	const conf = path.join(tmpdir, 'osmconf.ini');
	await fs.writeFile(conf, osmconf());
	const args: Arg[] = [
		['--config', 'CPL_TMPDIR', tmpdir],
		['-oo', `CONFIG_FILE=${conf}`],
		['-f', 'FlatGeobuf'],
		['-t_srs', 'EPSG:3857'],
		['-nln', 'land'],
		['-nlt', 'PROMOTE_TO_MULTI'],
		['-dialect', 'SQLite'],
		['-sql', kindSql('multipolygons')],
	];
	await atomic(out, (tmp) =>
		opts.progress
			? runProgress('land use', 'ogr2ogr', '-progress', ...args, tmp, pbf)
			: runQuiet('ogr2ogr', ...args, tmp, pbf),
	);
}
