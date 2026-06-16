// Per-block wrapper: turns one BLOCK×BLOCK-tile region at zoom z into Shortbread `land` /
// `water_polygons` polygon fragments. Everything runs on the small (~window) raster in tmp,
// so memory stays bounded. See the README and the plan for the rationale of each step.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { runQuiet, atomic, presentValues } from './worldcover.ts';
import type { Coverage } from './coverage.ts';
import {
	channels,
	blockWindow,
	BLUR_RADIUS,
	SIEVE_THRESHOLD,
	simplifyForLevel,
	type Rect,
	type Channel,
} from '../config.ts';

export type BlockCtx = { src: string; coverage: Coverage; tmpdir: string; resultsdir: string };
export type BlockFragments = { land: string | null; water: string | null };

// gdal_calc expression: 255 where band A is one of the given ESA codes, else 0
const mask = (esa: number[]) => `255*(${esa.map((c) => `(A==${c})`).join('|')})`;
// creation options for the warp (legacy gdalwarp uses single-dash -co)
const co = ['-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', '-co', 'BIGTIFF=YES'];

// process block (bx,by) at zoom z → its land/water FlatGeobuf fragments (or nulls if the
// block is empty / a layer has no active kinds at this zoom). Fragments are written atomically
// to ctx.resultsdir and cached: a block whose fragments already exist there is skipped, so a
// build resumes where it left off. Intermediate scratch in ctx.tmpdir is cleaned up.
export async function processBlock(z: number, bx: number, by: number, ctx: BlockCtx): Promise<BlockFragments> {
	const win = blockWindow(z, bx, by);
	if (ctx.coverage.isEmpty(win.innerLonLat)) return { land: null, water: null }; // skip-empty

	// channels active at this zoom; everything else (incl. ESA 0) folds into the no-data class.
	const active = channels.filter((c) => c.layer !== null && c.maxZoom >= z);
	const nodataEsa = channels.filter((c) => c.layer === null || c.maxZoom < z).flatMap((c) => c.esa);

	const id = `z${z}_${bx}_${by}`;
	const hasLand = active.some((c) => c.layer === 'land');
	const hasWater = active.some((c) => c.layer === 'water_polygons');
	const landFrag = path.join(ctx.resultsdir, `${id}_land.fgb`);
	const waterFrag = path.join(ctx.resultsdir, `${id}_water.fgb`);
	const result: BlockFragments = { land: hasLand ? landFrag : null, water: hasWater ? waterFrag : null };

	// resume: if this block's fragments are already on disk, skip the work
	if ((!hasLand || existsSync(landFrag)) && (!hasWater || existsSync(waterFrag))) return result;

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

		// Histogram-gate the work: which active kinds actually occur in this window (incl. margin,
		// so blur bleed near the inner edge is accounted for)? Two short-circuits avoid the
		// blur→argmax→sieve→polygonize→simplify chain for low-diversity blocks (common at high zoom):
		//   A) no active kind present → the block is all no-data → empty fragments
		//   B) a single value fills the whole window → emit the inner rectangle as one polygon
		// Otherwise we build masks only for the present kinds. Pruning is exact: an absent channel's
		// mask is all-zero, blurs to all-zero, and can never win the argmax.
		const present = await presentValues(window);
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
					runQuiet('ogr2ogr', ['-f', 'FlatGeobuf'], ['-nlt', 'MULTIPOLYGON'], ['-nln', layerName], out, gj),
				);
			};
			if (hasLand) await writeLayer(landFrag, 'land');
			if (hasWater) await writeLayer(waterFrag, 'water_polygons');
		};

		if (activePresent.length === 0) {
			await emit(null); // A: nothing but no-data
			return result;
		}
		if (present.size === 1) {
			await emit(activePresent[0]); // B: one kind fills the block
			return result;
		}

		// channel order for argmax/code mapping: index 1 = no-data, 2.. = activePresent[j]
		const maskEsa = [nodataEsa, ...activePresent.map((c) => c.esa)];

		// 2-3. per-channel mask (gdal_calc) → blur (vips); blur strips geo, re-attached at argmax
		const blurred: string[] = [];
		for (let i = 0; i < maskEsa.length; i++) {
			const m = tmp(`ch${i}.tif`);
			await runQuiet(
				'gdal_calc.py',
				['-A', window],
				['--calc', mask(maskEsa[i])],
				['--type', 'Byte'],
				'--hideNoData',
				['--co', 'COMPRESS=DEFLATE'],
				['--co', 'TILED=YES'],
				'--overwrite',
				'--quiet',
				['--outfile', m],
			);
			const b = tmp(`ch${i}_blur.tif`);
			await runQuiet(
				'vips',
				'gaussblur',
				m,
				`${b}[compression=deflate,predictor=horizontal,bigtiff=true]`,
				BLUR_RADIUS,
				['--precision', 'approximate'],
			);
			blurred.push(b);
		}

		// 4. argmax → per-pixel winning channel index (1-based); re-attach the 3857 georeferencing
		const index = tmp('index.tif');
		const named = blurred.flatMap((b, i) => ['-i', `${String.fromCharCode(65 + i)}=${b}`]);
		await runQuiet(
			'gdal',
			['raster', 'calc'],
			['--dialect', 'builtin'],
			named,
			['--calc', 'argmax'],
			['--ot', 'UInt8'],
			'--no-check-crs',
			['--co', 'COMPRESS=DEFLATE'],
			['--co', 'TILED=YES'],
			'--overwrite',
			['-o', index],
		);
		await runQuiet(
			'gdal',
			['raster', 'edit'],
			['--crs', 'EPSG:3857'],
			['--bbox', `${w.minx},${w.miny},${w.maxx},${w.maxy}`],
			index,
		);

		// 5. sieve specks
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

		// 6. crop the classified raster to the block's exact inner BLOCK×BLOCK rectangle in EPSG:3857.
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

		// 7. polygonize (field `code` = channel index) → a gap-free coverage of the whole block,
		// INCLUDING the no-data class (code 1). It must stay 100% filled for the next step.
		const poly = tmp('poly.fgb');
		await fs.rm(poly, { force: true });
		await runQuiet(
			'gdal',
			['raster', 'polygonize'],
			['-i', cropped],
			['-o', poly],
			['-f', 'FlatGeobuf'],
			['--attribute-name', 'code'],
			['--output-layer', 'data'],
			'--overwrite',
		);

		// 8. coverage-simplify. simplify-coverage only simplifies the *interior* edges shared between
		// adjacent polygons; --preserve-boundary keeps the *exterior* boundary fixed. So the input
		// MUST be a 100%-filled coverage with NO holes — the no-data polygons included — otherwise
		// every coastline is an exterior boundary and keeps its raw pixel staircase. We therefore
		// simplify the full polygonized coverage here and drop the no-data class only afterwards (9).
		const simplified = tmp('simplified.fgb');
		await fs.rm(simplified, { force: true });
		await runQuiet(
			'gdal',
			['vector', 'simplify-coverage'],
			'--overwrite',
			'--preserve-boundary',
			['--output-layer', 'data'],
			['-i', poly],
			['-o', simplified],
			simplifyForLevel(z),
		);

		// 9. now drop the no-data class, tag each polygon's Shortbread `kind`, reproject to EPSG:4326
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
	} finally {
		await Promise.all(scratch.map((f) => fs.rm(f, { force: true })));
	}

	return result;
}
