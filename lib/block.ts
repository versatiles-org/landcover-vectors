// Per-block wrapper: turns one BLOCK×BLOCK-tile region at zoom z into Shortbread `land` /
// `water_polygons` polygon fragments. Everything runs on the small (~window) raster in tmp,
// so memory stays bounded. See the README and the plan for the rationale of each step.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { runQuiet, atomic, presentValues, histogram } from './worldcover.ts';
import { seaShareWindow } from './ocean.ts';
import { timed } from './timing.ts';
import { windowVrt } from './window.ts';
import {
	channels,
	blockWindow,
	SIEVE_STAGES,
	SEA_SHARE_MIN,
	simplifyForLevel,
	type Rect,
	type Channel,
} from '../config.ts';

export type BlockCtx = {
	src: string;
	tmpdir: string;
	resultsdir: string;
	logFile?: string; // optional TSV log: one row per block (how it was processed, timing, sizes, histogram)
};
export type BlockFragments = { land: string | null; water: string | null };

// how a block was processed (recorded in the log)
type Branch = 'cached' | 'empty' | 'uniform' | 'full' | 'failed';

// per-block TSV log columns; bin/build.ts writes this header once per run, finish() appends a row per block
export const LOG_HEADER = [
	'timestamp',
	'id',
	'branch',
	'ms',
	'land_bytes',
	'water_bytes',
	'present', // distinct ESA values in the window — no-data excluded, see presentValues()
	'nodata_px', // ... which is exactly why this column exists: no-data pixels in the window
	'sea_px', // pixels of OSM's sea in the window (sea share ≥ SEA_SHARE_MIN), whatever ESA has under them
	'channels',
	'kind',
	'note', // error message on a `failed` row
].join('\t');

// gdal_calc expression: 1 where band A is one of the given ESA codes, else 0
const isAny = (esa: number[]) => `(${esa.map((c) => `(A==${c})`).join('|')})`;

// what a window holds, from its histograms: ESA's classes, and OSM's sea on top of them
export type WindowContent = {
	present: Set<number>; // distinct ESA values, no-data excluded (see presentValues)
	counted: number; // pixels the ESA histogram covers, i.e. all but ESA's no-data
	pixels: number;
	sea: number; // pixels whose sea share reaches SEA_SHARE_MIN
};
export type FastPath =
	{ branch: 'empty' } | { branch: 'uniform'; kind: Channel } | { branch: 'full'; classes: Channel[] };

// Which way a block goes, decided on its window's histograms before any raster work:
//   empty   — all sea, or no active kind anywhere: nothing to emit
//   uniform — one active kind fills the whole window and none of it is sea: emit the inner rectangle
//   full    — the chain, with a class index only for the kinds present (exact: an absent kind has no pixel)
// The sea is not burned into the window, so the ESA histogram still counts what lies under it: ESA's own
// sea is class 80 inside its coastal 3° tiles. Without the sea count, an open-sea block there would look
// like one class and go out as a water rectangle; with it, a block that is all sea is empty and one with
// any sea is never uniform.
export function fastPath(c: WindowContent, active: Channel[]): FastPath {
	if (c.sea === c.pixels) return { branch: 'empty' };
	const classes = active.filter((ch) => ch.esa.some((v) => c.present.has(v)));
	if (classes.length === 0) return { branch: 'empty' };
	// `counted === pixels`: the histogram accounted for every pixel, so there is no ESA no-data either
	if (c.sea === 0 && c.present.size === 1 && c.counted === c.pixels) return { branch: 'uniform', kind: classes[0] };
	return { branch: 'full', classes };
}

// process block (bx,by) at zoom z → its land/water FlatGeobuf fragments (or nulls if the
// block is empty / a layer has no active kinds at this zoom). Fragments are written atomically
// to ctx.resultsdir and cached: a block whose fragments already exist there is skipped, so a
// build resumes where it left off. Intermediate scratch in ctx.tmpdir is cleaned up.
//
// Blocks without source coverage are expected to be gone already — the caller drops them (bin/build.ts,
// via lib/coverage.ts) so the progress total reflects real work. This runs the chain on whatever it gets.
export async function processBlock(z: number, bx: number, by: number, ctx: BlockCtx): Promise<BlockFragments> {
	const t0 = performance.now();
	const id = `z${z}_${bx}_${by}`;
	const win = blockWindow(z, bx, by);

	// append one TSV row describing how this block was processed, then return its fragments
	const finish = async (
		branch: Branch,
		frags: BlockFragments,
		opts: {
			present?: number[];
			nodata?: number;
			sea?: number;
			channels?: number;
			kind?: string | null;
			note?: string;
		} = {},
	) => {
		if (ctx.logFile) {
			const sizeOf = (f: string | null) =>
				f
					? fs.stat(f).then(
							(s) => s.size,
							() => null,
						)
					: Promise.resolve(null);
			const [landBytes, waterBytes] = await Promise.all([sizeOf(frags.land), sizeOf(frags.water)]);
			const row = [
				new Date().toISOString(),
				id,
				branch,
				Math.round(performance.now() - t0),
				landBytes ?? '',
				waterBytes ?? '',
				opts.present?.join(',') ?? '',
				opts.nodata ?? '',
				opts.sea ?? '',
				opts.channels ?? '',
				opts.kind ?? '',
				opts.note?.replace(/\s+/g, ' ').trim().slice(0, 300) ?? '', // keep it one TSV row
			].join('\t');
			await fs.appendFile(ctx.logFile, row + '\n');
		}
		return frags;
	};

	// channels active at this zoom; everything else (incl. ESA 0) folds into the no-data class.
	const active = channels.filter((c) => c.layer !== null && c.maxZoom >= z);

	const hasLand = active.some((c) => c.layer === 'land');
	const hasWater = active.some((c) => c.layer === 'water_polygons');
	const landFrag = path.join(ctx.resultsdir, `${id}_land.fgb`);
	const waterFrag = path.join(ctx.resultsdir, `${id}_water.fgb`);
	const frags: BlockFragments = { land: hasLand ? landFrag : null, water: hasWater ? waterFrag : null };

	// resume: if this block's fragments are already on disk, skip the work
	if ((!hasLand || existsSync(landFrag)) && (!hasWater || existsSync(waterFrag))) return finish('cached', frags);

	const p = (suffix: string) => path.join(ctx.tmpdir, `${id}_${suffix}`);
	const scratch: string[] = [];
	const tmp = (suffix: string) => {
		const f = p(suffix);
		scratch.push(f);
		return f;
	};

	try {
		// 1. this block's window of the EPSG:3857 source, straight from the pyramid level for this zoom: a VRT
		//    (lib/window.ts), read by the histogram and the class index below. ESA's 0 is no-data, as in the
		//    source, and uncovered pixels read as 0 too.
		const window = tmp('window.vrt');
		const { window3857: w, windowPx: px } = win;
		await timed('read', () => windowVrt(window, ctx.src, w, px.width, px.height, { nodata: 0 }));
		scratch.push(window + '.aux.xml'); // gdalinfo -hist (below) leaves a PAM sidecar — clean it up too

		// 1b. OSM's sea over the same window, read straight out of the sea-share pyramid at this zoom's level
		//     (lib/ocean.ts): a VRT, no raster is written. Pixels whose share reaches SEA_SHARE_MIN become no-data
		//     in the class index (2), so the land cover ends at OSM's coastline and ESA's coastal sea never
		//     becomes `water`.
		const share = tmp('share.vrt');
		await seaShareWindow(share, w, px.width, px.height);
		scratch.push(share + '.aux.xml');

		// Histogram-gate the work (see fastPath): which active kinds occur in this window (incl. margin, which
		// the sieve near the inner edge sees), and how much of it is sea?
		const [{ values: present, counted, pixels }, { buckets }] = await timed('histogram', () =>
			Promise.all([presentValues(window), histogram(share)]),
		);
		const sea = buckets.slice(SEA_SHARE_MIN).reduce((n, v) => n + v, 0);
		const content = { present: [...present], nodata: pixels - counted, sea };
		const route = fastPath({ present, counted, pixels, sea }, active);

		// write fragments directly from the inner rectangle (EPSG:4326 = win.innerLonLat): the
		// rectangle tagged `kind` for a uniform block's layer, an empty layer for everything else
		const emit = async (uniform: Channel | null): Promise<void> => {
			const { west, south, east, north } = win.innerLonLat;
			const ring = [
				[west, south],
				[east, south],
				[east, north],
				[west, north],
				[west, south],
			];
			const writeLayer = async (frag: string, layerName: 'land' | 'water_polygons') => {
				const features =
					uniform && uniform.layer === layerName
						? [
								{
									type: 'Feature',
									properties: { kind: uniform.kind },
									geometry: { type: 'Polygon', coordinates: [ring] },
								},
							]
						: [];
				const gj = tmp(`${layerName}.geojson`);
				await fs.writeFile(gj, JSON.stringify({ type: 'FeatureCollection', features }));
				await atomic(frag, (out) =>
					runQuiet(
						'ogr2ogr',
						['-f', 'FlatGeobuf'],
						['-lco', 'SPATIAL_INDEX=NO'],
						['-nlt', 'MULTIPOLYGON'],
						['-nln', layerName],
						out,
						gj,
					),
				);
			};
			if (hasLand) await writeLayer(landFrag, 'land');
			if (hasWater) await writeLayer(waterFrag, 'water_polygons');
		};

		if (route.branch === 'empty') {
			await timed('emit', () => emit(null)); // all sea, or nothing but no-data
			return finish('empty', frags, content);
		}
		if (route.branch === 'uniform') {
			await timed('emit', () => emit(route.kind)); // one kind fills the block
			return finish('uniform', frags, { ...content, kind: route.kind.kind });
		}
		const activePresent = route.classes;

		// 2. class index per pixel: 1 = no-data (ESA's, inactive kinds, and OSM's sea from B), 2.. =
		// activePresent[j]. Each pixel keeps its own class; only the sieve below generalizes. The codes of
		// different classes are disjoint, so at most one term is set.
		const index = tmp('index.tif');
		const classes = activePresent.map((c, j) => `${j + 1}*${isAny(c.esa)}`).join('+');
		await timed('classify', () =>
			runQuiet(
				'gdal_calc.py',
				['-A', window],
				['-B', share],
				['--calc', `1+(B<${SEA_SHARE_MIN})*(${classes})`],
				['--type', 'Byte'],
				'--hideNoData',
				['--co', 'COMPRESS=DEFLATE'],
				['--co', 'TILED=YES'],
				'--overwrite',
				'--quiet',
				['--outfile', index],
			),
		);

		// 3. sieve specks, in passes of growing size (SIEVE_STAGES)
		let sieved = index;
		await timed('sieve', async () => {
			for (const [stage, size] of SIEVE_STAGES.entries()) {
				const out = tmp(`sieved-${stage}.tif`);
				await runQuiet(
					'gdal',
					['raster', 'sieve'],
					['--size-threshold', size],
					['--co', 'COMPRESS=DEFLATE'],
					['--co', 'TILED=YES'],
					'--overwrite',
					['-i', sieved],
					['-o', out],
				);
				sieved = out;
			}
		});

		// 4. crop the classified raster to the block's exact inner BLOCK×BLOCK rectangle in EPSG:3857.
		// Block pixel grids are aligned (same pixel size; the inner offset is a whole number of margin
		// pixels), so a raster crop tiles perfectly with neighbours — and polygonizing the crop avoids
		// the GeometryCollection slivers a vector clip can produce along the boundary.
		const r: Rect = win.inner3857;
		const cropped = tmp('cropped.tif');
		await timed('crop', () =>
			runQuiet(
				'gdal_translate',
				'-q',
				['-projwin', r.minx, r.maxy, r.maxx, r.miny],
				['-co', 'COMPRESS=DEFLATE'],
				['-co', 'TILED=YES'],
				sieved,
				cropped,
			),
		);

		// 5. polygonize (field `code` = channel index) → a gap-free coverage of the whole block,
		// INCLUDING the no-data class (code 1). It must stay 100% filled for the next step.
		const poly = tmp('poly.fgb');
		await fs.rm(poly, { force: true });
		await timed('polygonize', () =>
			runQuiet(
				'gdal',
				['raster', 'polygonize'],
				['-i', cropped],
				['-o', poly],
				['-f', 'FlatGeobuf'],
				['--lco', 'SPATIAL_INDEX=NO'], // read sequentially by simplify-coverage; no index needed
				['--attribute-name', 'code'],
				['--output-layer', 'data'],
				'--overwrite',
			),
		);

		// 6. coverage-simplify. simplify-coverage only simplifies the *interior* edges shared between
		// adjacent polygons; --preserve-boundary keeps the *exterior* boundary fixed. So the input
		// MUST be a 100%-filled coverage with NO holes — the no-data polygons included — otherwise
		// every coastline is an exterior boundary and keeps its raw pixel staircase. We therefore
		// simplify the full polygonized coverage here and drop the no-data class only afterwards (7).
		const simplified = tmp('simplified.fgb');
		await fs.rm(simplified, { force: true });
		await timed('simplify', () =>
			runQuiet(
				'gdal',
				['vector', 'simplify-coverage'],
				'--overwrite',
				'--preserve-boundary',
				['--lco', 'SPATIAL_INDEX=NO'], // read sequentially by the split step; no index needed
				['--output-layer', 'data'],
				['-i', poly],
				['-o', simplified],
				simplifyForLevel(z),
			),
		);

		// 7. now drop the no-data class, tag each polygon's Shortbread `kind`, reproject to EPSG:4326
		// and split per layer; each fragment is written to a temp file and renamed on success (so a
		// finished fragment on disk means the block is done)
		const kindWhen = activePresent.map((c, j) => `WHEN ${j + 2} THEN '${c.kind}'`).join(' ');
		const codesFor = (layer: 'land' | 'water_polygons') =>
			activePresent.flatMap((c, j) => (c.layer === layer ? [j + 2] : []));
		const split = (out: string, layerName: string, codes: number[]) =>
			runQuiet(
				'ogr2ogr',
				['-t_srs', 'EPSG:4326'],
				['-f', 'FlatGeobuf'],
				['-lco', 'SPATIAL_INDEX=NO'],
				['-nlt', 'PROMOTE_TO_MULTI'],
				['-nln', layerName],
				['-dialect', 'SQLite'],
				// `-1` keeps the IN clause valid (→ empty fragment) when this layer has no present codes
				[
					'-sql',
					`SELECT *, CASE code ${kindWhen} END AS kind FROM data WHERE code IN (${codes.join(',') || '-1'})`,
				],
				out,
				simplified,
			);
		await timed('split', async () => {
			if (hasLand) await atomic(landFrag, (out) => split(out, 'land', codesFor('land')));
			if (hasWater) await atomic(waterFrag, (out) => split(out, 'water_polygons', codesFor('water_polygons')));
		});
		return finish('full', frags, { ...content, channels: activePresent.length });
	} catch (err) {
		// leave a row behind, then let the caller decide: bin/build.ts collects every failed block of a
		// zoom and reports them together, so one bad block no longer discards the whole zoom's work
		const note = err instanceof Error ? err.message : String(err);
		await finish('failed', { land: null, water: null }, { note }).catch(() => {}); // never mask `err`
		throw err;
	} finally {
		await Promise.all(scratch.map((f) => fs.rm(f, { force: true })));
	}
}
