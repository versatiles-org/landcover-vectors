// Per-block wrapper: turns one BLOCK×BLOCK-tile region at zoom z into the Shortbread `land` /
// `water_polygons` tiles of that region. Everything runs on the small (~window) raster in tmp,
// so memory stays bounded. See the README and the plan for the rationale of each step.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { runQuiet, presentValues, histogram } from './worldcover.ts';
import { seaShareWindow } from './ocean.ts';
import { tileBlock, tileCount, type Layer } from './assemble.ts';
import { timed } from './timing.ts';
import { windowVrt } from './window.ts';
import {
	channels,
	blockWindow,
	SIEVE_STAGES,
	SEA_SHARE_MIN,
	TILE_PX,
	simplifyForLevel,
	type Channel,
} from '../config.ts';

export type BlockCtx = {
	src: string;
	tmpdir: string;
	resultsdir: string;
	logFile?: string; // optional TSV log: one row per block (how it was processed, timing, sizes, histogram)
};

// Each tile's class codes are shifted by one of four multiples of this, by the parity of its column and row, so
// neighbouring tiles never share a code and every tile edge is an edge of the coverage (step 4). The class codes
// run from 1 (no-data) to the number of channels, so they must stay below it.
const TILE_CODE = 16;
if (channels.length >= TILE_CODE) throw new Error(`lib/block.ts: ${channels.length} channels do not fit TILE_CODE`);

// a block's tileset, and whether it was there already (a resumed build), which the progress bar counts apart
export type BlockResult = { tileset: string; cached: boolean };

// how a block was processed (recorded in the log)
type Branch = 'cached' | 'empty' | 'uniform' | 'full' | 'failed';

// per-block TSV log columns; bin/build.ts writes this header once per run, finish() appends a row per block
export const LOG_HEADER = [
	'timestamp',
	'id',
	'branch',
	'ms',
	'tiles',
	'bytes', // the block's tileset
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

// process block (bx,by) at zoom z → its tileset, an mbtiles of the block's own tiles (none if the block is
// empty). It is written atomically to ctx.resultsdir and cached: a block whose tileset already exists there is
// skipped, so a build resumes where it left off. Intermediate scratch in ctx.tmpdir is cleaned up.
//
// Blocks without source coverage are expected to be gone already — the caller drops them (bin/build.ts,
// via lib/coverage.ts) so the progress total reflects real work. This runs the chain on whatever it gets.
export async function processBlock(z: number, bx: number, by: number, ctx: BlockCtx): Promise<BlockResult> {
	const t0 = performance.now();
	const id = `z${z}_${bx}_${by}`;
	const win = blockWindow(z, bx, by);

	const tileset = path.join(ctx.resultsdir, `${id}.mbtiles`);

	// append one TSV row describing how this block was processed, then return its tileset
	const finish = async (
		branch: Branch,
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
			const ok = branch !== 'failed' && branch !== 'cached';
			const row = [
				new Date().toISOString(),
				id,
				branch,
				Math.round(performance.now() - t0),
				ok ? tileCount(tileset) : '',
				ok ? (await fs.stat(tileset)).size : '',
				opts.present?.join(',') ?? '',
				opts.nodata ?? '',
				opts.sea ?? '',
				opts.channels ?? '',
				opts.kind ?? '',
				opts.note?.replace(/\s+/g, ' ').trim().slice(0, 300) ?? '', // keep it one TSV row
			].join('\t');
			await fs.appendFile(ctx.logFile, row + '\n');
		}
		return { tileset, cached: branch === 'cached' };
	};

	// channels active at this zoom; everything else (incl. ESA 0) folds into the no-data class.
	const active = channels.filter((c) => c.layer !== null && c.maxZoom >= z);

	// resume: if this block's tileset is already on disk, skip the work
	if (existsSync(tileset)) return finish('cached');

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

		// tile the polygons of `layers` into the block's tileset (lib/assemble.ts)
		const tile = (layers: Layer[]) => timed('tile', () => tileBlock(z, win.tiles, layers, tileset, ctx.tmpdir));

		if (route.branch === 'empty') {
			await tile([]); // all sea, or nothing but no-data
			return finish('empty', content);
		}
		if (route.branch === 'uniform') {
			// one kind fills the window: its rectangle (EPSG:3857), margin included, so the edge tiles get their
			// buffer too
			const { minx, miny, maxx, maxy } = w;
			const ring = [
				[minx, miny],
				[maxx, miny],
				[maxx, maxy],
				[minx, maxy],
				[minx, miny],
			];
			const feature = {
				type: 'Feature',
				properties: { kind: route.kind.kind },
				geometry: { type: 'Polygon', coordinates: [ring] },
			};
			const gj = tmp('uniform.geojson');
			await timed('emit', () =>
				fs.writeFile(gj, JSON.stringify({ type: 'FeatureCollection', features: [feature] })),
			);
			await tile([{ name: route.kind.layer as Layer['name'], file: gj }]);
			return finish('uniform', { ...content, kind: route.kind.kind });
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

		// 4. cut at the tile edges: a VRT over the sieved window that shifts the codes of every tile by TILE_CODE
		// times 0–3, by the parity of its column and row, so no polygon crosses a tile edge. tippecanoe then never
		// has to cut a polygon down to its tile, which it can get wrong: clipping one with thousands of holes, it
		// lost the outer ring and kept the holes (94 % of the forest of a z6 tile in Hudson Bay). The margin's pixels
		// belong to the neighbouring tiles, and their polygons become the buffer of the block's edge tiles. As every
		// edge of the coverage, the tile edges stay straight in simplify-coverage (6), and the points where a border
		// crosses one stay on its pixel corners, which a neighbouring block has too. Whole pixels are copied.
		const { x: ix, y: iy } = win.innerPx;
		const span = (from: number, size: number) => {
			// the window's pixel ranges, one per tile, as [tile index relative to the block, start, size]
			const out: [number, number, number][] = [];
			for (let t = -Math.ceil(from / TILE_PX); from + t * TILE_PX < size; t++) {
				const a = Math.max(0, from + t * TILE_PX);
				out.push([t, a, Math.min(size, from + (t + 1) * TILE_PX) - a]);
			}
			return out;
		};
		const sources = span(iy, px.height).flatMap(([ty, y, h]) =>
			span(ix, px.width).map(([tx, x, wd]) => {
				const shift = TILE_CODE * (((win.tiles.x0 + tx) & 1) + 2 * ((win.tiles.y0 + ty) & 1));
				return `    <ComplexSource>
      <SourceFilename relativeToVRT="0">${path.resolve(sieved)}</SourceFilename>
      <SourceBand>1</SourceBand>
      <SrcRect xOff="${x}" yOff="${y}" xSize="${wd}" ySize="${h}"/>
      <DstRect xOff="${x}" yOff="${y}" xSize="${wd}" ySize="${h}"/>
      <ScaleOffset>${shift}</ScaleOffset>
      <ScaleRatio>1</ScaleRatio>
    </ComplexSource>`;
			}),
		);
		const cut = tmp('cut.vrt');
		await fs.writeFile(
			cut,
			`<VRTDataset rasterXSize="${px.width}" rasterYSize="${px.height}">
  <SRS>EPSG:3857</SRS>
  <GeoTransform>${w.minx}, ${(w.maxx - w.minx) / px.width}, 0, ${w.maxy}, 0, ${-(w.maxy - w.miny) / px.height}</GeoTransform>
  <VRTRasterBand dataType="Byte" band="1">
${sources.join('\n')}
  </VRTRasterBand>
</VRTDataset>
`,
		);

		// 5. polygonize (field `code` = channel index + the tile's shift) → a gap-free coverage of the whole
		// window, INCLUDING the no-data class (code 1). It must stay 100% filled for the next step.
		const poly = tmp('poly.fgb');
		await fs.rm(poly, { force: true });
		await timed('polygonize', () =>
			runQuiet(
				'gdal',
				['raster', 'polygonize'],
				['-i', cut],
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

		// 7. now drop the no-data class, tag each polygon's Shortbread `kind` and split per layer, keeping only the
		// layers with a kind present. The polygons stay in EPSG:3857, which tippecanoe reads as it is: reprojected
		// to EPSG:4326, straight edges bend, and a hole touching its shell at a point could cross it instead.
		const kindWhen = activePresent.map((c, j) => `WHEN ${j + 2} THEN '${c.kind}'`).join(' ');
		const layers: Layer[] = [];
		await timed('split', async () => {
			for (const name of ['land', 'water_polygons'] as const) {
				const codes = activePresent.flatMap((c, j) => (c.layer === name ? [j + 2] : []));
				if (codes.length === 0) continue;
				const out = tmp(`${name}.fgb`);
				await runQuiet(
					'ogr2ogr',
					['-f', 'FlatGeobuf'],
					['-lco', 'SPATIAL_INDEX=NO'],
					['-nlt', 'PROMOTE_TO_MULTI'],
					['-nln', name],
					['-dialect', 'SQLite'],
					[
						'-sql',
						`SELECT *, CASE code % ${TILE_CODE} ${kindWhen} END AS kind FROM data ` +
							`WHERE code % ${TILE_CODE} IN (${codes.join(',')})`,
					],
					out,
					simplified,
				);
				layers.push({ name, file: out });
			}
		});

		// 8. tile the block
		await tile(layers);
		return finish('full', { ...content, channels: activePresent.length });
	} catch (err) {
		// leave a row behind, then let the caller decide: bin/build.ts collects every failed block of a
		// zoom and reports them together, so one bad block no longer discards the whole zoom's work
		const note = err instanceof Error ? err.message : String(err);
		await finish('failed', { note }).catch(() => {}); // never mask `err`
		throw err;
	} finally {
		await Promise.all(scratch.map((f) => fs.rm(f, { force: true })));
	}
}
