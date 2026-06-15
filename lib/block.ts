// Per-block wrapper: turns one BLOCK×BLOCK-tile region at zoom z into Shortbread `land` /
// `water_polygons` polygon fragments. Everything runs on the small (~window) raster in tmp,
// so memory stays bounded. See the README and the plan for the rationale of each step.

import fs from 'node:fs/promises';
import path from 'node:path';

import { runQuiet } from './worldcover.ts';
import type { Coverage } from './coverage.ts';
import { channels, blockWindow, BLUR_RADIUS, SIEVE_THRESHOLD, simplifyForLevel, type Rect } from '../config.ts';

export type BlockCtx = { srcVrt: string; coverage: Coverage; tmpdir: string };
export type BlockFragments = { land: string | null; water: string | null };

// gdal_calc expression: 255 where band A is one of the given ESA codes, else 0
const mask = (esa: number[]) => `255*(${esa.map((c) => `(A==${c})`).join('|')})`;
// creation options for the warp (legacy gdalwarp uses single-dash -co)
const co = ['-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', '-co', 'BIGTIFF=YES'];

// process block (bx,by) at zoom z → its land/water FlatGeobuf fragments (or nulls if the
// block is empty / a layer has no active kinds at this zoom). Scratch is cleaned up; the
// returned fragments live until the per-zoom tiling consumes them.
export async function processBlock(z: number, bx: number, by: number, ctx: BlockCtx): Promise<BlockFragments> {
	const win = blockWindow(z, bx, by);
	if (ctx.coverage.isEmpty(win.innerLonLat)) return { land: null, water: null }; // skip-empty

	// channels active at this zoom; everything else (incl. ESA 0) folds into the no-data class.
	const active = channels.filter((c) => c.layer !== null && c.maxZoom >= z);
	const nodataEsa = channels.filter((c) => c.layer === null || c.maxZoom < z).flatMap((c) => c.esa);
	const maskEsa = [nodataEsa, ...active.map((c) => c.esa)]; // index 1 = no-data, 2.. = active

	const id = `z${z}_${bx}_${by}`;
	const p = (suffix: string) => path.join(ctx.tmpdir, `${id}_${suffix}`);
	const scratch: string[] = [];
	const tmp = (suffix: string) => {
		const f = p(suffix);
		scratch.push(f);
		return f;
	};

	const landFrag = p('land.fgb');
	const waterFrag = p('water.fgb');
	const hasLand = active.some((c) => c.layer === 'land');
	const hasWater = active.some((c) => c.layer === 'water_polygons');

	try {
		// 1. warp the source mirror → the window raster (mode); uncovered pixels stay 0 (= no-data)
		const window = tmp('window.tif');
		const { window3857: w, windowPx: px } = win;
		await runQuiet('gdalwarp', [
			'-t_srs',
			'EPSG:3857',
			'-te',
			`${w.minx}`,
			`${w.miny}`,
			`${w.maxx}`,
			`${w.maxy}`,
			'-ts',
			`${px.width}`,
			`${px.height}`,
			'-r',
			'mode',
			'-ot',
			'Byte',
			'-of',
			'GTiff',
			'-multi', // multithreaded warp
			'-wo',
			'NUM_THREADS=ALL_CPUS',
			...co,
			'-overwrite',
			ctx.srcVrt,
			window,
		]);

		// 2-3. per-channel mask (gdal_calc) → blur (vips); blur strips geo, re-attached at argmax
		const blurred: string[] = [];
		for (let i = 0; i < maskEsa.length; i++) {
			const m = tmp(`ch${i}.tif`);
			await runQuiet('gdal_calc.py', [
				'-A',
				window,
				'--calc',
				mask(maskEsa[i]),
				'--type',
				'Byte',
				'--hideNoData',
				'--co',
				'COMPRESS=DEFLATE',
				'--co',
				'TILED=YES',
				'--overwrite',
				'--quiet',
				'--outfile',
				m,
			]);
			const b = tmp(`ch${i}_blur.tif`);
			await runQuiet('vips', [
				'gaussblur',
				m,
				`${b}[compression=deflate,predictor=horizontal,bigtiff=true]`,
				`${BLUR_RADIUS}`,
				'--precision',
				'approximate',
			]);
			blurred.push(b);
		}

		// 4. argmax → per-pixel winning channel index (1-based); re-attach the 3857 georeferencing
		const index = tmp('index.tif');
		const named = blurred.flatMap((b, i) => ['-i', `${String.fromCharCode(65 + i)}=${b}`]);
		await runQuiet('gdal', [
			'raster',
			'calc',
			'--dialect',
			'builtin',
			...named,
			'--calc',
			'argmax',
			'--ot',
			'UInt8',
			'--no-check-crs',
			'--co',
			'COMPRESS=DEFLATE',
			'--co',
			'TILED=YES',
			'--overwrite',
			'-o',
			index,
		]);
		await runQuiet('gdal', [
			'raster',
			'edit',
			'--crs',
			'EPSG:3857',
			'--bbox',
			`${w.minx},${w.miny},${w.maxx},${w.maxy}`,
			index,
		]);

		// 5. sieve specks
		const sieved = tmp('sieved.tif');
		await runQuiet('gdal', [
			'raster',
			'sieve',
			'--size-threshold',
			`${SIEVE_THRESHOLD}`,
			'--co',
			'COMPRESS=DEFLATE',
			'--co',
			'TILED=YES',
			'--overwrite',
			'-i',
			index,
			'-o',
			sieved,
		]);

		// 6. polygonize (field `code` = channel index) → tag kind+layer, drop the no-data class (code 1)
		const poly = tmp('poly.fgb');
		await fs.rm(poly, { force: true });
		await runQuiet('gdal', [
			'raster',
			'polygonize',
			'-i',
			sieved,
			'-o',
			poly,
			'-f',
			'FlatGeobuf',
			'--attribute-name',
			'code',
			'--output-layer',
			'poly',
			'--overwrite',
		]);
		const kindWhen = active.map((c, j) => `WHEN ${j + 2} THEN '${c.kind}'`).join(' ');
		const layerWhen = active.map((c, j) => `WHEN ${j + 2} THEN '${c.layer}'`).join(' ');
		const codes = active.map((_, j) => j + 2).join(',');
		const sql = `SELECT *, CASE code ${kindWhen} END AS kind, CASE code ${layerWhen} END AS layer FROM poly WHERE code IN (${codes})`;
		const tagged = tmp('tagged.fgb');
		await fs.rm(tagged, { force: true });
		await runQuiet('ogr2ogr', ['-f', 'FlatGeobuf', '-nln', 'data', '-dialect', 'SQLite', '-sql', sql, tagged, poly]);

		// 7. clip to the exact inner BLOCK×BLOCK rectangle in EPSG:3857 (pixel-aligned → exact seam)
		const r: Rect = win.inner3857;
		const clipped = tmp('clipped.fgb');
		await fs.rm(clipped, { force: true });
		await runQuiet('ogr2ogr', [
			'-f',
			'FlatGeobuf',
			'-nln',
			'data',
			'-clipsrc',
			`${r.minx}`,
			`${r.miny}`,
			`${r.maxx}`,
			`${r.maxy}`,
			clipped,
			tagged,
		]);

		// 8. coverage-simplify (per block → bounded memory); preserve the clipped edge so neighbours match
		const simplified = tmp('simplified.fgb');
		await fs.rm(simplified, { force: true });
		await runQuiet('gdal', [
			'vector',
			'simplify-coverage',
			'--overwrite',
			'--preserve-boundary',
			'--output-layer',
			'data',
			'-i',
			clipped,
			'-o',
			simplified,
			`${simplifyForLevel(z)}`,
		]);

		// 9. reproject to EPSG:4326 and split by target layer
		if (hasLand) {
			await fs.rm(landFrag, { force: true });
			await runQuiet('ogr2ogr', [
				'-t_srs',
				'EPSG:4326',
				'-f',
				'FlatGeobuf',
				'-nln',
				'land',
				'-where',
				"layer='land'",
				landFrag,
				simplified,
			]);
		}
		if (hasWater) {
			await fs.rm(waterFrag, { force: true });
			await runQuiet('ogr2ogr', [
				'-t_srs',
				'EPSG:4326',
				'-f',
				'FlatGeobuf',
				'-nln',
				'water_polygons',
				'-where',
				"layer='water_polygons'",
				waterFrag,
				simplified,
			]);
		}
	} finally {
		await Promise.all(scratch.map((f) => fs.rm(f, { force: true })));
	}

	return { land: hasLand ? landFrag : null, water: hasWater ? waterFrag : null };
}
