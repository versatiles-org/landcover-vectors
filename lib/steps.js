// The landcover pipeline, one exported function per step. bin/build.js runs them; each
// can also be imported and called on its own.
//
// Every step writes its per-level result into its own folder under data/, level-prefixed
// (e.g. data/reproject/6_worldcover.tif), and is SKIPPED when that result already exists —
// so nothing is deleted and an interrupted build resumes where it left off. Tools used:
// GDAL (gdal_translate, gdalbuildvrt, gdalwarp, gdal_calc.py, the `gdal raster`/`gdal vector`
// subcommands, ogr2ogr), libvips (blur), tippecanoe + tile-join (tile/pack), versatiles (pack).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { run, runQuiet, pMap, commandExists, listSourceKeys, BUCKET, PREFIX } from './worldcover.js';
import { progress } from './progress.js';
import {
	dir,
	file,
	datadir,
	MERC,
	MAXLEVEL,
	meta,
	CPU_CORES,
	BLUR_RADIUS,
	channels as channelDefs,
	warpedPath,
	maskPath,
	blurPath,
	codePath,
	geometryPath,
	tilesPath,
	sizeForLevel,
	simplifyForLevel,
} from '../config.js';

// 1. Download a reduced-resolution local mirror of ESA WorldCover 2021 (v200).
//
// Each of the ~2651 source GeoTIFFs is downsampled by FACTOR on the way in (reading its
// matching internal overview, so only a fraction of the full 10 m data is transferred)
// into data/esa-worldcover-src in its native EPSG:4326. Downloads run in parallel, are
// retried, written atomically, and skipped if already present — robust and resumable.
export async function download() {
	const FACTOR = 8; // downsample each source tile by this factor on download
	const PERCENT = `${100 / FACTOR}%`;
	const CONCURRENCY = 8;
	const RETRIES = 3;
	const srcdir = dir.source;

	// fetch one source tile to the local mirror at reduced resolution, skipping if
	// already present; reads only the matching overview and writes atomically
	async function fetchTile(key) {
		const dest = path.join(srcdir, path.basename(key));
		if (existsSync(dest)) return false; // an existing file is complete (atomic rename below)
		const tmp = dest + '.part';
		const src = `/vsicurl/${BUCKET}/${key}`;
		for (let attempt = 1; ; attempt++) {
			try {
				await runQuiet('gdal_translate', [
					'-q',
					'-r',
					'nearest',
					'-outsize',
					PERCENT,
					PERCENT,
					'-of',
					'GTiff',
					'-co',
					'COMPRESS=DEFLATE',
					'-co',
					'TILED=YES',
					src,
					tmp,
				]);
				await fs.rename(tmp, dest); // atomic: only a complete file appears as dest
				return true;
			} catch (err) {
				await fs.rm(tmp, { force: true }); // never leave a partial file behind
				if (attempt >= RETRIES) throw new Error(`download ${key} failed: ${err.message}`);
				await sleep(attempt * 1000);
			}
		}
	}

	await fs.mkdir(srcdir, { recursive: true });
	console.error('Listing source tiles from s3://esa-worldcover/%s …', PREFIX);
	const keys = await listSourceKeys();
	console.error('Found %d source tiles', keys.length);

	let fetched = 0;
	const bar = progress(keys.length, 'Downloading');
	await pMap(keys, CONCURRENCY, async (key) => {
		if (await fetchTile(key)) fetched++;
		bar.tick();
	});
	bar.done();
	console.error('%d downloaded, %d already cached. Mirror in %s', fetched, keys.length - fetched, srcdir);
}

// 2. Produce the EPSG:3857 world raster for the given zoom level → data/reproject/{z}_worldcover.tif.
//
// The top level (MAXLEVEL) is reprojected from the full source mirror: the tiles are
// mosaicked with a VRT and warped covering the standard Mercator square (±MERC m), resampled
// "mode" (dominant class — the only correct choice for categorical data). Lower levels are
// produced by halving the next-higher level's (kept) raster, which is far cheaper than
// re-warping every source tile — so the build runs the levels from MAXLEVEL down to 0. No
// nodata is set, so ESA 0 (the no-data/water channel) is counted in the mode (mode skips nodata).
export async function reproject(level) {
	const size = sizeForLevel(level);
	const out = warpedPath(level);
	if (existsSync(out)) return console.error('z%d reproject: cached', level);
	await fs.mkdir(dir.reproject, { recursive: true });

	// lower levels: downscale the next-higher level's raster by 50% (distinct files → no in-place issue)
	if (level < MAXLEVEL) {
		const src = warpedPath(level + 1);
		if (!existsSync(src)) throw new Error(`missing ${src} — reproject level ${level + 1} first`);
		console.error('Downscaling worldcover to z%d (%d×%d, mode) → %s', level, size, size, out);
		await run('gdal_translate', [
			'-r',
			'mode',
			'-outsize',
			String(size),
			String(size),
			'-co',
			'COMPRESS=DEFLATE',
			'-co',
			'TILED=YES',
			'-co',
			'BIGTIFF=YES',
			src,
			out,
		]);
		return;
	}

	// top level: reproject the full source mirror
	const tiles = (await fs.readdir(dir.source).catch(() => [])).filter((f) => f.endsWith('.tif'));
	if (tiles.length === 0) throw new Error(`no source tiles in ${dir.source} — run the download step first`);

	// mosaic via an input-file list (avoids command-line length limits and shell globbing)
	const listPath = path.join(dir.reproject, '_src.txt');
	const vrtPath = path.join(dir.reproject, '_src.vrt');
	await fs.writeFile(listPath, tiles.map((t) => path.join(dir.source, t)).join('\n') + '\n');

	console.error('Mosaicking %d source tiles → %s', tiles.length, vrtPath);
	await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listPath, vrtPath]);

	console.error('Warping z%d to EPSG:3857 %d×%d → %s', level, size, size, out);
	await run('gdalwarp', [
		'-t_srs',
		'EPSG:3857',
		'-te',
		String(-MERC),
		String(-MERC),
		String(MERC),
		String(MERC),
		'-ts',
		String(size),
		String(size),
		'-r',
		'mode',
		'-ot',
		'Byte',
		'-of',
		'GTiff',
		'-co',
		'COMPRESS=DEFLATE',
		'-co',
		'TILED=YES',
		'-co',
		'BIGTIFF=YES',
		'-multi',
		'-wo',
		'NUM_THREADS=ALL_CPUS',
		'-overwrite',
		vrtPath,
		out,
	]);
}

// 3. Split the level's world raster into one per-class membership mask per channel.
//
// For each entry in config.channels, gdal_calc.py writes a single Byte mask: 255 where the
// pixel belongs to that class, 0 elsewhere. The classes partition the legend, so across all
// masks every pixel is 255 in exactly one channel. Each mask is skipped if it already exists.
export async function channels(level) {
	if (channelDefs.every((_, i) => existsSync(maskPath(level, i)))) return console.error('z%d channels: cached', level);
	const CONCURRENCY = Math.max(1, Math.min(4, os.availableParallelism() - 1));
	const src = warpedPath(level);
	if (!existsSync(src)) throw new Error(`missing ${src} — run the reproject step first`);
	await fs.mkdir(dir.channels, { recursive: true });

	console.error('Building %d class masks for z%d (%d workers)', channelDefs.length, level, CONCURRENCY);
	const bar = progress(channelDefs.length, 'Channels');
	await pMap(
		channelDefs.map((c, i) => ({ c, i })),
		CONCURRENCY,
		async ({ c, i }) => {
			const out = maskPath(level, i);
			if (!existsSync(out)) {
				await runQuiet('gdal_calc.py', [
					'-A',
					src,
					'--calc',
					c.calc,
					'--type',
					'Byte',
					'--hideNoData', // 0 means "not this class", not nodata — keep it a real value for the blur
					'--co',
					'COMPRESS=DEFLATE',
					'--co',
					'TILED=YES',
					'--overwrite',
					'--quiet',
					'--outfile',
					out,
				]);
			}
			bar.tick();
		},
	);
	bar.done();
}

// 4. Gaussian-blur each class mask with libvips (GDAL has no Gaussian filter).
//
// Blurring turns the hard masks into smooth fields so the next step's argmax yields curved
// class boundaries with shared borders staying exact. vips streams and works in 8-bit;
// `approximate` precision is fastest. The blur only feeds an argmax, so the approximation is
// fine. vips strips the GeoTIFF georeferencing; the argmax step re-attaches it. Skip if present.
export async function blur(level) {
	if (channelDefs.every((_, i) => existsSync(blurPath(level, i)))) return console.error('z%d blur: cached', level);
	const CONCURRENCY = CPU_CORES;
	const PRECISION = 'approximate'; // vips gaussblur precision (fastest)
	if (!(await commandExists('vips'))) throw new Error('need libvips (vips) on PATH');
	for (let i = 0; i < channelDefs.length; i++) {
		if (!existsSync(maskPath(level, i)))
			throw new Error(`missing ${maskPath(level, i)} — run the channels step first`);
	}
	await fs.mkdir(dir.blur, { recursive: true });

	console.error(
		'Blurring %d masks for z%d (σ=%s px, %d workers)',
		channelDefs.length,
		level,
		BLUR_RADIUS,
		CONCURRENCY,
	);
	const bar = progress(channelDefs.length, 'Blur');
	await pMap(
		channelDefs.map((_, i) => i),
		CONCURRENCY,
		async (i) => {
			const out = blurPath(level, i);
			if (!existsSync(out)) {
				await runQuiet('vips', [
					'gaussblur',
					maskPath(level, i),
					`${out}[compression=deflate,predictor=horizontal]`,
					String(BLUR_RADIUS),
					'--precision',
					PRECISION,
				]);
			}
			bar.tick();
		},
	);
	bar.done();
}

// 5. Reduce the blurred masks to a single-band code raster via per-pixel argmax.
//
// Stock `gdal raster` commands, streaming block by block: calc `--calc argmax` (1-based index
// of the strongest channel, ties to lowest index) → sieve (drop regions smaller than a circle
// of the blur radius) → reclassify index → code → edit (re-attach the EPSG:3857 georeferencing
// the blur stripped). The index/sieved rasters are kept alongside the result. Skip if present.
export async function argmax(level) {
	const out = codePath(level);
	if (existsSync(out)) return console.error('z%d argmax: cached', level);
	const inputs = channelDefs.map((_, i) => blurPath(level, i));
	for (const p of inputs) if (!existsSync(p)) throw new Error(`missing ${p} — run the blur step first`);
	await fs.mkdir(dir.argmax, { recursive: true });

	// name the inputs A, B, C … in channel order; argmax's index follows input order
	const named = inputs.flatMap((p, i) => ['-i', `${String.fromCharCode(65 + i)}=${p}`]);
	const mapping = channelDefs.map((c, i) => `${i + 1}=${c.code}`).join(';'); // index → code
	const sieveThreshold = 10 * Math.round(Math.PI * BLUR_RADIUS * BLUR_RADIUS);
	const indexTif = path.join(dir.argmax, `${level}_index.tif`);
	const sievedTif = path.join(dir.argmax, `${level}_sieved.tif`);

	console.error('argmax over %d channels → %s', inputs.length, indexTif);
	await run('gdal', [
		'raster',
		'calc',
		'--dialect',
		'builtin',
		...named,
		'--calc',
		'argmax',
		'--ot',
		'UInt8',
		'--no-check-crs', // the blurred masks carry no CRS (the blur stripped it) — that's expected
		'--co',
		'COMPRESS=DEFLATE',
		'--co',
		'TILED=YES',
		'--overwrite',
		'-o',
		indexTif,
	]);
	let toReclassify = indexTif;
	if (sieveThreshold >= 1) {
		console.error('Sieving regions < %d px (circle of r=%s) → %s', sieveThreshold, BLUR_RADIUS, sievedTif);
		await run('gdal', [
			'raster',
			'sieve',
			'--size-threshold',
			String(sieveThreshold),
			'--co',
			'COMPRESS=DEFLATE',
			'--co',
			'TILED=YES',
			'--overwrite',
			'-i',
			indexTif,
			'-o',
			sievedTif,
		]);
		toReclassify = sievedTif;
	}

	console.error('Reclassifying index → code → %s', out);
	await run('gdal', [
		'raster',
		'reclassify',
		'-m',
		mapping,
		'--ot',
		'UInt8',
		'--co',
		'COMPRESS=DEFLATE',
		'--co',
		'TILED=YES',
		'--overwrite',
		'-i',
		toReclassify,
		'-o',
		out,
	]);
	console.error('Re-attaching EPSG:3857 georeferencing');
	await run('gdal', ['raster', 'edit', '--crs', 'EPSG:3857', '--bbox', `${-MERC},${-MERC},${MERC},${MERC}`, out]);
}

// 6. Vectorize the code raster into the level's polygon geometry.
//
// A single global vectorization (no per-tile seams): polygonize → tag each polygon with its
// Shortbread `kind` and drop the no-data class → coverage-simplify (topology-preserving,
// --preserve-boundary keeps the world edge exact) → reproject to EPSG:4326 for tippecanoe. The
// intermediate FlatGeobufs are kept alongside the result. Skip if the result already exists.
export async function polygonize(level) {
	const out = geometryPath(level);
	const code = codePath(level);
	if (!existsSync(code)) throw new Error(`missing ${code} — run the argmax step first`);
	if (existsSync(out)) return console.error('z%d polygonize: cached', level);
	await fs.mkdir(dir.polygonize, { recursive: true });

	const SIMPLIFY = String(simplifyForLevel(level)); // coverage-simplification tolerance in metres (EPSG:3857)
	const kept = channelDefs.filter((c) => c.kind);
	const whens = kept.map((c) => `WHEN ${c.code} THEN '${c.kind}'`).join(' ');
	const SQL = `SELECT *, CASE code ${whens} END AS kind FROM landcover WHERE code IN (${kept.map((c) => c.code).join(',')})`;
	const codeFgb = path.join(dir.polygonize, `${level}_code.fgb`);
	const taggedFgb = path.join(dir.polygonize, `${level}_tagged.fgb`);
	const simplifiedFgb = path.join(dir.polygonize, `${level}_simplified.fgb`);

	console.error('Polygonizing → %s', codeFgb);
	await fs.rm(codeFgb, { force: true }); // a FlatGeobuf can't be overwritten in place
	await run('gdal', [
		'raster',
		'polygonize',
		'-i',
		code,
		'-o',
		codeFgb,
		'-f',
		'FlatGeobuf',
		'--attribute-name',
		'code',
		'--output-layer',
		'landcover',
		'--overwrite',
	]);
	console.error('Tagging kind and dropping no-data → %s', taggedFgb);
	await fs.rm(taggedFgb, { force: true });
	await run('ogr2ogr', [
		'-f',
		'FlatGeobuf',
		'-nln',
		'landcover',
		'-dialect',
		'SQLite',
		'-sql',
		SQL,
		taggedFgb,
		codeFgb,
	]);

	console.error('Coverage-simplifying (tolerance %s m) → %s', SIMPLIFY, simplifiedFgb);
	await run('gdal', [
		'vector',
		'simplify-coverage',
		'--overwrite',
		'--output-layer',
		'landcover',
		'-i',
		taggedFgb,
		'-o',
		simplifiedFgb,
		SIMPLIFY,
	]);
	console.error('Reprojecting to EPSG:4326 → %s', out);
	await fs.rm(out, { force: true });
	await run('ogr2ogr', ['-t_srs', 'EPSG:4326', '-f', 'FlatGeobuf', '-nln', 'landcover', out, simplifiedFgb]);
}

// 7. Build the single-zoom tileset for the level → data/tile/{level}_landcover.mbtiles.
//
// One zoom per call (the pack step merges them). Oversized tiles stay coverage-complete by
// simplifying harder and merging the smallest polygons (--coalesce-smallest-as-needed) rather
// than dropping features. Skip if the tileset already exists.
export async function tile(level) {
	const out = tilesPath(level);
	const geom = geometryPath(level);
	if (!existsSync(geom)) throw new Error(`missing ${geom} — run the polygonize step first`);
	if (existsSync(out)) return console.error('z%d tile: cached', level);
	await fs.mkdir(dir.tile, { recursive: true });

	// keep tippecanoe's multi-GB feature store on the data disk, not a RAM-backed /tmp
	const tmpdir = path.join(datadir, 'tippecanoe-tmp');
	await fs.mkdir(tmpdir, { recursive: true });

	console.error('Tiling zoom %d → %s', level, out);
	await run('tippecanoe', [
		'-o',
		out,
		'--force',
		'--temporary-directory',
		tmpdir,
		'--minimum-zoom',
		String(level),
		'--maximum-zoom',
		String(level),
		'--layer',
		meta.layer,
		'--attribute-type',
		'kind:string',
		'--include',
		'kind',
		'--simplification',
		'10',
		'--coalesce-smallest-as-needed',
		'--name',
		meta.name,
		'--attribution',
		meta.attribution,
		'--description',
		meta.description,
		geom,
	]);
}

// 8. Merge the per-level tilesets and pack them into a brotli versatiles container.
//
// tile-join concatenates the single-zoom mbtiles (z0..MAXLEVEL) into one z0..z6 pyramid
// (data/landcover.mbtiles), which versatiles then compresses into the repo-root container.
export async function pack() {
	const inputs = [];
	for (let z = 0; z <= MAXLEVEL; z++) {
		const p = tilesPath(z);
		if (!existsSync(p)) throw new Error(`missing ${p} — run the build (tile step) for every level first`);
		inputs.push(p);
	}

	console.error('Merging %d per-level tilesets → %s', inputs.length, file.tiles);
	await run('tile-join', [
		'-f',
		'--name',
		meta.name,
		'--attribution',
		meta.attribution,
		'--description',
		meta.description,
		'-o',
		file.tiles,
		...inputs,
	]);

	const out = path.join(path.dirname(datadir), 'landcover-vectors.versatiles');
	console.error('Packing → %s', out);
	await run('versatiles', ['convert', '-c', 'brotli', file.tiles, out]);
}
