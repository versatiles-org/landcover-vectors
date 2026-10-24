// Per-block wrapper: turns one BLOCK×BLOCK-tile region at zoom z into Shortbread `land` /
// `water_polygons` polygon fragments. Everything runs on the small (~window) raster in tmp,
// so memory stays bounded. See the README and the plan for the rationale of each step.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { runQuiet, atomic, presentValues } from './worldcover.ts';
import { maskOcean } from './ocean.ts';
import { channels, blockWindow, SIEVE_THRESHOLD, simplifyForLevel, type Rect, type Channel } from '../config.ts';

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
	'channels',
	'kind',
	'note', // error message on a `failed` row
].join('\t');

// gdal_calc expression: 1 where band A is one of the given ESA codes, else 0
const isAny = (esa: number[]) => `(${esa.map((c) => `(A==${c})`).join('|')})`;
// creation options for the warp (legacy gdalwarp uses single-dash -co)
const co = ['-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', '-co', 'BIGTIFF=YES'];

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
		opts: { present?: number[]; nodata?: number; channels?: number; kind?: string | null; note?: string } = {},
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
		// 1. read this block's window from the EPSG:3857 source (mode-resampled via its overviews;
		//    uncovered pixels stay 0 = no-data)
		const window = tmp('window.tif');
		const { window3857: w, windowPx: px } = win;
		await runQuiet(
			'gdalwarp',
			['-t_srs', 'EPSG:3857'],
			['-te', w.minx, w.miny, w.maxx, w.maxy],
			['-ts', px.width, px.height],
			['-r', 'mode'],
			['-ot', 'Byte'],
			['-of', 'GTiff'],
			'-multi', // multithreaded warp
			['-wo', 'NUM_THREADS=ALL_CPUS'],
			co,
			'-overwrite',
			ctx.src,
			window,
		);
		scratch.push(window + '.aux.xml'); // gdalinfo -hist (below) leaves a PAM sidecar — clean it up too

		// 1b. blank OSM's sea out of the window (→ no-data), so the land cover ends at OSM's coastline and
		//     ESA's coastal sea never becomes `water`. Before the histogram, so the fast paths see the masked
		//     window: an all-sea block turns empty, and a coastal block is no longer mistaken for uniform.
		await maskOcean(window, w, px.width, tmp('sea.fgb'));

		// Histogram-gate the work: which active kinds actually occur in this window (incl. margin,
		// which the sieve near the inner edge sees)? Two short-circuits avoid the
		// classify→sieve→polygonize→simplify chain for low-diversity blocks (common at high zoom):
		//   A) no active kind present → the block is all no-data → empty fragments
		//   B) one value fills the whole window, no-data included → emit the inner rectangle as one polygon
		// Otherwise only the present kinds get a class index. Pruning is exact: an absent kind has no
		// pixel to classify.
		const { values: present, counted, pixels } = await presentValues(window);
		const nodataPx = pixels - counted;
		const activePresent = active.filter((c) => c.esa.some((v) => present.has(v)));

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

		if (activePresent.length === 0) {
			await emit(null); // A: nothing but no-data
			return finish('empty', frags, { present: [...present], nodata: nodataPx });
		}
		// `counted === pixels` is what makes this safe: the histogram accounted for every pixel, so the
		// window really is one single class. GDAL omits no-data from the histogram, so without that test a
		// mostly-ocean coastal block whose only land class is, say, grassland would look uniform here and
		// get its entire inner rectangle — ocean included — emitted as grassland.
		if (present.size === 1 && counted === pixels) {
			await emit(activePresent[0]); // B: one kind fills the block
			return finish('uniform', frags, { present: [...present], nodata: nodataPx, kind: activePresent[0].kind });
		}

		// 2. class index per pixel: 1 = no-data, 2.. = activePresent[j]. Each pixel keeps its own class; only the
		// sieve below generalizes. The codes of different classes are disjoint, so at most one term is set.
		const index = tmp('index.tif');
		const expr = ['1', ...activePresent.map((c, j) => `${j + 1}*${isAny(c.esa)}`)].join('+');
		await runQuiet(
			'gdal_calc.py',
			['-A', window],
			['--calc', expr],
			['--type', 'Byte'],
			'--hideNoData',
			['--co', 'COMPRESS=DEFLATE'],
			['--co', 'TILED=YES'],
			'--overwrite',
			'--quiet',
			['--outfile', index],
		);

		// 3. sieve specks
		const sieved = tmp('sieved.tif');
		await runQuiet(
			'gdal',
			['raster', 'sieve'],
			['--size-threshold', SIEVE_THRESHOLD],
			['--co', 'COMPRESS=DEFLATE'],
			['--co', 'TILED=YES'],
			'--overwrite',
			['-i', index],
			['-o', sieved],
		);

		// 4. crop the classified raster to the block's exact inner BLOCK×BLOCK rectangle in EPSG:3857.
		// Block pixel grids are aligned (same pixel size; the inner offset is a whole number of margin
		// pixels), so a raster crop tiles perfectly with neighbours — and polygonizing the crop avoids
		// the GeometryCollection slivers a vector clip can produce along the boundary.
		const r: Rect = win.inner3857;
		const cropped = tmp('cropped.tif');
		await runQuiet(
			'gdal_translate',
			'-q',
			['-projwin', r.minx, r.maxy, r.maxx, r.miny],
			['-co', 'COMPRESS=DEFLATE'],
			['-co', 'TILED=YES'],
			sieved,
			cropped,
		);

		// 5. polygonize (field `code` = channel index) → a gap-free coverage of the whole block,
		// INCLUDING the no-data class (code 1). It must stay 100% filled for the next step.
		const poly = tmp('poly.fgb');
		await fs.rm(poly, { force: true });
		await runQuiet(
			'gdal',
			['raster', 'polygonize'],
			['-i', cropped],
			['-o', poly],
			['-f', 'FlatGeobuf'],
			['--lco', 'SPATIAL_INDEX=NO'], // read sequentially by simplify-coverage; no index needed
			['--attribute-name', 'code'],
			['--output-layer', 'data'],
			'--overwrite',
		);

		// 6. coverage-simplify. simplify-coverage only simplifies the *interior* edges shared between
		// adjacent polygons; --preserve-boundary keeps the *exterior* boundary fixed. So the input
		// MUST be a 100%-filled coverage with NO holes — the no-data polygons included — otherwise
		// every coastline is an exterior boundary and keeps its raw pixel staircase. We therefore
		// simplify the full polygonized coverage here and drop the no-data class only afterwards (7).
		const simplified = tmp('simplified.fgb');
		await fs.rm(simplified, { force: true });
		await runQuiet(
			'gdal',
			['vector', 'simplify-coverage'],
			'--overwrite',
			'--preserve-boundary',
			['--lco', 'SPATIAL_INDEX=NO'], // read sequentially by the split step; no index needed
			['--output-layer', 'data'],
			['-i', poly],
			['-o', simplified],
			simplifyForLevel(z),
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
		if (hasLand) await atomic(landFrag, (out) => split(out, 'land', codesFor('land')));
		if (hasWater) await atomic(waterFrag, (out) => split(out, 'water_polygons', codesFor('water_polygons')));
		return finish('full', frags, { present: [...present], nodata: nodataPx, channels: activePresent.length });
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
