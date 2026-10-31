// Experiments: build variants of the pipeline over a set of test regions, measure what the map shows around the
// handover, and compare.
//
//   npm run experiment                      # every variant (lib/variants.ts)
//   npm run experiment -- burn burn-z11     # just these
//   npm run experiment -- --report          # the tables of everything measured so far
//   npm run experiment -- --list            # the variants and the regions
//
// Each region gets its own small source (lib/regionsource.ts), cached in data/experiment/regions/: ESA from the
// bucket, OSM's sea from the download's water polygons (fetched here if missing), and OSM's land use imported from
// the planet, which `npm run download -- --landuse` fetches once (lib/osmland.ts). A variant builds
// z8–10 — the zooms around the handover — with the build's own pipeline (lib/pipeline.ts) into
// data/experiment/variants/<fingerprint>/, so variants with the same source share one build. The measurement
// (lib/measure.ts) goes to data/experiment/results/<variant>.json, and the tables to results/report.md.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { TileSource } from '@versatiles/versatiles-rs';

import { pMap, setGdalThreads } from '../lib/worldcover.ts';
import { requireTools } from '../lib/tools.ts';
import { coverageFromKeys } from '../lib/coverage.ts';
import { planBlocks, countBlocks, type ZoomBlocks } from '../lib/plan.ts';
import { runZooms } from '../lib/pipeline.ts';
import { joinTilesets } from '../lib/assemble.ts';
import { progress } from '../lib/progress.ts';
import { cacheValues, fingerprint } from '../lib/fingerprint.ts';
import { downloadOcean, seaShareValues } from '../lib/ocean.ts';
import { findLanduse } from '../lib/osmland.ts';
import { mergePipeline } from '../lib/handover.ts';
import { REGIONS, extentLonLat } from '../lib/regions.ts';
import { VARIANTS, channelsFor, burnsOf, type Variant } from '../lib/variants.ts';
import { measureRegion, KIND_ZOOMS, SHARP_TURN, type RegionMetrics, type KindCounts } from '../lib/measure.ts';
import {
	sourceKeys,
	regionKeys,
	regionGrid,
	prepareRegion,
	regionLand,
	regionLandPath,
	burnedSource,
	pyramidVrt,
	type Part,
} from '../lib/regionsource.ts';
import { datadir, file, OSM_URL, BLOCK_CONCURRENCY } from '../config.ts';

const { values: opt, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		report: { type: 'boolean', default: false },
		list: { type: 'boolean', default: false },
		concurrency: { type: 'string' },
		help: { type: 'boolean', default: false },
	},
});

if (opt.help) {
	console.log(
		[
			'Usage: npm run experiment -- [variant …] [options]',
			'  (no variant)       build and measure every variant',
			'  --report           print the tables of every measured variant, build nothing',
			'  --list             list the variants and the test regions',
			'  --concurrency <n>  blocks at once (default: one per core, or LANDCOVER_CONCURRENCY)',
		].join('\n'),
	);
	process.exit(0);
}

const root = path.join(datadir, 'experiment');
const resultsDir = path.join(root, 'results');
type Result = {
	variant: string;
	why: string;
	fingerprint: string | null;
	measured: string;
	regions: Record<string, RegionMetrics>;
};

if (opt.list) {
	console.log('Variants:');
	for (const [name, v] of Object.entries(VARIANTS)) console.log(`  ${name.padEnd(18)} ${v.why}`);
	console.log('Regions:');
	for (const [name, r] of Object.entries(REGIONS)) console.log(`  ${name.padEnd(18)} ${r.why}`);
	process.exit(0);
}

if (!opt.report) {
	const names = positionals.length ? positionals : Object.keys(VARIANTS);
	const unknown = names.filter((n) => !VARIANTS[n]);
	if (unknown.length) throw new Error(`unknown variant(s) ${unknown.join(', ')} — see --list`);
	if (names.some((n) => !VARIANTS[n].container)) {
		await requireTools(['gdal', 'gdal_calc', 'tippecanoe', 'versatiles', 'osmium', 'curl']);
		if (!(await findLanduse()))
			throw new Error('no OSM land use — run "npm run download -- --landuse" first (the planet, ~95 GB, once)');
		if (!existsSync(file.ocean)) await downloadOcean();
	}
	await fs.mkdir(resultsDir, { recursive: true });
	for (const name of names) {
		const result = await runVariant(name, VARIANTS[name]);
		await fs.writeFile(path.join(resultsDir, `${name}.json`), JSON.stringify(result, null, '\t') + '\n');
	}
}
await report();

// ---------------------------------------------------------------- one variant

async function runVariant(name: string, v: Variant): Promise<Result> {
	console.error('\n▸ %s — %s', name, v.why);
	let landcover = v.container;
	let fp: string | null = null;
	if (!landcover) ({ landcover, fp } = await build(v));

	const osm = await TileSource.fromPath(OSM_URL);
	const lc = await TileSource.fromPath(landcover);
	const merged = await TileSource.fromVpl(mergePipeline(OSM_URL, landcover, channelsFor(v)));
	const regions: Record<string, RegionMetrics> = {};
	for (const [r, region] of Object.entries(REGIONS)) {
		const cache = path.join(root, 'regions', r, 'osm-reference.bin.gz');
		await fs.mkdir(path.dirname(cache), { recursive: true });
		// a built variant is compared with its own source; a published container has none here
		const truth = fp
			? {
					classes: path.join(root, 'variants', fp, 'source', `${r}.tif`),
					seaShare: path.join(root, 'regions', r, 'seashare.tif'),
					scratch: path.join(root, 'tmp', 'measure'),
				}
			: undefined;
		regions[r] = await measureRegion(region.window, { osm, merged, landcover: lc }, cache, truth);
		const m = regions[r];
		console.error(
			'  %s handover %s %%, holes %s %%, towns z10 %s %%, sharp turns z10 %s %%, agreement z10 %s %%',
			r.padEnd(18),
			m.handover,
			m.holes,
			m.towns.z10,
			m.shape.z10?.sharpTurns ?? '–',
			m.agreement.z10 ?? '–',
		);
	}
	return { variant: name, why: v.why, fingerprint: fp, measured: new Date().toISOString(), regions };
}

// build the variant's z8–10 over every region, or reuse a build with the same fingerprint
async function build(v: Variant): Promise<{ landcover: string; fp: string }> {
	const keys = await sourceKeys(root);
	const regions = Object.entries(REGIONS).map(([name, region]) => ({
		name,
		region,
		dir: path.join(root, 'regions', name),
		keys: regionKeys(region, keys),
	}));
	await pMap(regions, 3, async (r) => {
		if (!r.keys.length) throw new Error(`region ${r.name}: no ESA tiles`);
		if (!existsSync(path.join(r.dir, 'seashare.tif'))) console.error('  preparing region %s …', r.name);
		await prepareRegion(r.dir, r.region, r.keys);
	});
	const landuse = (await findLanduse())!;
	await regionLand(regions, landuse, path.join(root, 'tmp'));

	// what the blocks depend on: the pipeline's settings, the sea and the land use, the burns, and which regions
	// share the source
	const fp = fingerprint({
		cache: cacheValues(),
		sea: await seaShareValues(),
		landuse: landuse.date,
		burn: burnsOf(v),
		smooth: v.smooth, // left out when unset, so the variants without one keep their builds
		regions: Object.fromEntries(regions.map((r) => [r.name, r.region.window])),
	});
	const dir = path.join(root, 'variants', fp);
	const landcover = path.join(dir, 'landcover.mbtiles');
	if (existsSync(landcover)) {
		console.error('  built already: %s', landcover);
		return { landcover, fp };
	}

	const sourceDir = path.join(dir, 'source');
	const tmpdir = path.join(dir, 'tmp');
	await fs.rm(tmpdir, { recursive: true, force: true });
	const [resultsdir, tilesdir] = [path.join(dir, '1_results'), path.join(dir, '2_tiles')];
	for (const d of [sourceDir, tmpdir, resultsdir, tilesdir]) await fs.mkdir(d, { recursive: true });
	const classes: Part[] = [];
	const sea: Part[] = [];
	for (const r of regions) {
		const tif = path.join(sourceDir, `${r.name}.tif`);
		await burnedSource(r.dir, regionLandPath(r.dir, landuse.date), burnsOf(v), tif, tmpdir);
		classes.push({ file: tif, ...regionGrid(r.region) });
		sea.push({ file: path.join(r.dir, 'seashare.tif'), ...regionGrid(r.region) });
	}
	const src = path.join(sourceDir, 'worldcover-3857.vrt');
	const seaShare = path.join(sourceDir, 'seashare-3857.vrt');
	await pyramidVrt(src, classes, 0);
	await pyramidVrt(seaShare, sea);

	// the blocks of z8–10 that touch a region, row-major per zoom like planBlocks
	const coverage = coverageFromKeys(regions.flatMap((r) => r.keys));
	const plan: ZoomBlocks[] = [];
	for (const r of regions)
		for (const { z, blocks } of planBlocks(coverage, {
			minZoom: 8,
			maxZoom: 10,
			bbox: extentLonLat(r.region.window),
		})) {
			let zb = plan.find((p) => p.z === z);
			if (!zb) plan.push((zb = { z, blocks: [] }));
			for (const b of blocks) if (!zb.blocks.some(([x, y]) => x === b[0] && y === b[1])) zb.blocks.push(b);
		}
	plan.sort((a, b) => a.z - b.z);
	for (const zb of plan) zb.blocks.sort((a, b) => a[1] - b[1] || a[0] - b[0]);

	const bar = progress(countBlocks(plan), 'blocks');
	setGdalThreads(1); // one block per core, one GDAL thread each — as in the build
	const zooms = await runZooms(plan, {
		src,
		seaShare,
		tmpdir,
		resultsdir,
		tilesdir,
		logFile: path.join(dir, 'blocks.log'),
		smooth: v.smooth,
		concurrency: Number(opt.concurrency ?? BLOCK_CONCURRENCY),
		bar,
		label: (z) => `zoom ${z}`,
	});
	bar.done();
	setGdalThreads('ALL_CPUS');
	if (!(await joinTilesets(zooms, landcover))) throw new Error('the variant has no tiles');
	await fs.rm(tmpdir, { recursive: true, force: true });
	return { landcover, fp };
}

// ---------------------------------------------------------------- report

// one table per metric: a row per region, a column per variant (in lib/variants.ts order)
async function report(): Promise<void> {
	const files = existsSync(resultsDir) ? await fs.readdir(resultsDir) : [];
	const results = new Map<string, Result>();
	for (const f of files.filter((f) => f.endsWith('.json'))) {
		const r = JSON.parse(await fs.readFile(path.join(resultsDir, f), 'utf8')) as Result;
		results.set(r.variant, r);
	}
	const variants = [...Object.keys(VARIANTS), ...results.keys()].filter(
		(v, i, a) => results.has(v) && a.indexOf(v) === i,
	);
	if (!variants.length) {
		console.error('nothing measured yet — run "npm run experiment"');
		return;
	}
	const metrics: [string, string, (m: RegionMetrics) => number | null][] = [
		['handover', 'where OSM paints at z11, z10 shows the same category (%) — higher is better', (m) => m.handover],
		['holes', 'where OSM paints at z11, z10 shows nothing (%) — lower is better', (m) => m.holes],
		['towns z10', "OSM's z11 urban shown as urban at z10 (%)", (m) => m.towns.z10],
		['towns z8', "OSM's z11 urban shown as urban at z8 (%)", (m) => m.towns.z8],
		['forest kept', "OSM's z11 forest shown as forest at z10 (%) — must not drop", (m) => m.forestKept],
		['overreach', "z10's urban that z11 does not call urban (%)", (m) => m.overreach],
		['tiles z10', "the landcover's z10 tiles over the window (KB)", (m) => m.tiles.z10?.kb ?? null],
		[
			'agreement z10',
			"the landcover's z10 tiles against the variant's source, per tile pixel (%) — higher is better",
			(m) => m.agreement?.z10 ?? null,
		],
		['agreement z8', '… and its z8 tiles (%)', (m) => m.agreement?.z8 ?? null],
		[
			'sharp turns z10',
			`vertices of the landcover's z10 outlines that turn by more than ${SHARP_TURN}° (%) — lower is smoother`,
			(m) => m.shape?.z10?.sharpTurns ?? null,
		],
		['sharp turns z8', '… and of its z8 outlines (%)', (m) => m.shape?.z8?.sharpTurns ?? null],
		[
			'turning z10',
			"degrees the landcover's z10 outlines turn per rendered px — lower is smoother",
			(m) => m.shape?.z10?.turning ?? null,
		],
		[
			'axis-aligned z10',
			"of the landcover's z10 outline length, the share within 3° of horizontal or vertical (%) — a smooth curve: ~7",
			(m) => m.shape?.z10?.axisAligned ?? null,
		],
		['vertices z10', "vertices of the landcover's z10 outlines in the window", (m) => m.shape?.z10?.vertices ?? null],
	];
	const lines: string[] = [];
	for (const [title, what, get] of metrics) {
		lines.push(`### ${title}`, '', what, '');
		lines.push(`| region | ${variants.join(' | ')} |`, `|---|${variants.map(() => '---:').join('|')}|`);
		for (const region of Object.keys(REGIONS)) {
			const cells = variants.map((v) => {
				const m = results.get(v)!.regions[region];
				const value = m ? get(m) : null;
				return value === null || value === undefined ? '–' : String(value);
			});
			lines.push(`| ${region} | ${cells.join(' | ')} |`);
		}
		lines.push('');
	}
	lines.push(...kindTables(variants.map((v) => results.get(v)!)));
	const text = lines.join('\n');
	await fs.writeFile(path.join(resultsDir, 'report.md'), text);
	console.log('\n' + text);
}

// Per OSM kind, summed over the regions: how each zoom paints where OSM has the kind (at z14). The first table is
// the reference variant's (baseline, if measured) by zoom — above z10 that is OSM's own drawing, the same in every
// variant; the second compares z10 across the variants.
function kindTables(results: Result[]): string[] {
	const sum = (r: Result) => {
		const all = new Map<string, KindCounts & { regions: number }>();
		for (const m of Object.values(r.regions))
			for (const [kind, c] of Object.entries(m.kinds ?? {})) {
				const a = all.get(kind) ?? { px: 0, handover: 0, own: {}, same: {}, z10: {}, regions: 0 };
				a.px += c.px;
				a.handover += c.handover;
				a.regions++;
				for (const key of ['own', 'same', 'z10'] as const)
					for (const [k, v] of Object.entries(c[key])) a[key][k] = (a[key][k] ?? 0) + v;
				all.set(kind, a);
			}
		return all;
	};
	const sums = results.map(sum);
	const ref = Math.max(
		0,
		results.findIndex((r) => r.variant === 'baseline'),
	);
	const total = [...sums[ref].values()].reduce((n, c) => n + c.px, 0);
	if (!total) return [];
	// kinds covering at least 0.02 % of all windows, largest first
	const kinds = [...sums[ref].entries()].filter(([, c]) => c.px / total >= 0.0002).sort((a, b) => b[1].px - a[1].px);
	const p = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);
	const lines = [
		`### kinds, by zoom (${results[ref].variant})`,
		'',
		"Where OSM has the kind (its z14 tiles), the share each zoom paints with the kind's own fill (%), and what z10 " +
			'paints there instead. A kind versatiles-style does not fill has no own share.',
		'',
		`| kind | area % | regions | ${KIND_ZOOMS.map((z) => `z${z}`).join(' | ')} | z10 paints |`,
		`|---|---:|---:|${KIND_ZOOMS.map(() => '---:').join('|')}|---|`,
	];
	for (const [kind, c] of kinds) {
		const drawn = Object.values(c.own).some((v) => v > 0) || Object.values(c.same).some((v) => v > 0);
		const own = KIND_ZOOMS.map((z) => (drawn ? String(p(c.own[`z${z}`], c.px)) : '–'));
		const top = Object.entries(c.z10)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([fill, n]) => `${fill.replace(/^(land|water)-/, '')} ${p(n, c.px)}`)
			.join(', ');
		const area = Math.round((1000 * c.px) / total) / 10;
		lines.push(`| ${kind.replace('land/', '')} | ${area} | ${c.regions} | ${own.join(' | ')} | ${top} |`);
	}
	lines.push(
		'',
		'### kinds at the handover, per variant',
		'',
		'Where OSM has the kind, the share z10 paints in the same category as z11 (urban, forest, green, agri, water, ' +
			'bare, or nothing) (%): the jump at the handover, kind by kind.',
		'',
		`| kind | ${results.map((r) => r.variant).join(' | ')} |`,
		`|---|${results.map(() => '---:').join('|')}|`,
	);
	for (const [kind] of kinds) {
		const cells = sums.map((s) => {
			const k = s.get(kind);
			return k?.handover !== undefined ? String(p(k.handover, k.px)) : '–';
		});
		lines.push(`| ${kind.replace('land/', '')} | ${cells.join(' | ')} |`);
	}
	lines.push('');
	return lines;
}
