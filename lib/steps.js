// The landcover pipeline, one exported function per step, plus an ordered `steps`
// registry. bin/build.js runs them; each can also be imported and called on its own.
//
// Every step reads the previous step's output from data/ and writes its own, so the
// pipeline is resumable. Tools used: GDAL (gdal_translate, gdalbuildvrt, gdalwarp,
// gdal_calc.py, the `gdal raster`/`gdal vector` subcommands, ogr2ogr), libvips or
// ImageMagick (blur), tippecanoe (tile) and versatiles (pack).

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
	SIZE,
	MERC,
	meta,
	CPU_CORES,
	BLUR_RADIUS,
	channels as channelDefs,
	maskPath,
	blurPath,
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

// 2. Render the mirror into one global Web Mercator raster.
//
// The source tiles are mosaicked with a VRT and reprojected to EPSG:3857 at SIZE×SIZE
// pixels covering the standard Mercator square (±MERC m), resampled "mode" (dominant
// class — the only correct choice for categorical data). data/worldcover-3857.tif is a
// single Byte band with class codes {0,10,…,100}.
export async function reproject() {
	const tiles = (await fs.readdir(dir.source).catch(() => [])).filter((f) => f.endsWith('.tif'));
	if (tiles.length === 0) throw new Error(`no source tiles in ${dir.source} — run the download step first`);
	await fs.mkdir(datadir, { recursive: true });

	// mosaic via an input-file list (avoids command-line length limits and shell globbing)
	const listPath = path.join(datadir, '_src.txt');
	const vrtPath = path.join(datadir, '_src.vrt');
	await fs.writeFile(listPath, tiles.map((t) => path.join(dir.source, t)).join('\n') + '\n');

	console.error('Mosaicking %d source tiles → %s', tiles.length, vrtPath);
	await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listPath, vrtPath]);

	console.error('Warping to EPSG:3857 %d×%d → %s', SIZE, SIZE, file.warped);
	await run('gdalwarp', [
		'-t_srs',
		'EPSG:3857',
		'-te',
		String(-MERC),
		String(-MERC),
		String(MERC),
		String(MERC),
		'-ts',
		String(SIZE),
		String(SIZE),
		'-r',
		'mode',
		'-ot',
		'Byte',
		'-dstnodata',
		'0',
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
		file.warped,
	]);
	await fs.rm(listPath, { force: true });
	await fs.rm(vrtPath, { force: true });
}

// 3. Split the world raster into one per-class membership mask per channel.
//
// For each entry in config.channels, gdal_calc.py writes a single Byte mask: 255 where
// the pixel belongs to that class, 0 elsewhere. The classes partition the legend, so
// across all masks every pixel is 255 in exactly one channel. Resumable: existing masks
// are skipped.
export async function channels() {
	const CONCURRENCY = Math.max(1, Math.min(4, os.availableParallelism() - 1));
	if (!existsSync(file.warped)) throw new Error(`missing ${file.warped} — run the reproject step first`);
	await fs.mkdir(dir.channels, { recursive: true });

	console.error('Building %d class masks (%d workers)', channelDefs.length, CONCURRENCY);
	const bar = progress(channelDefs.length, 'Channels');
	await pMap(
		channelDefs.map((c, i) => ({ c, i })),
		CONCURRENCY,
		async ({ c, i }) => {
			const out = maskPath(i);
			if (!existsSync(out)) {
				await runQuiet('gdal_calc.py', [
					'-A',
					file.warped,
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

// 4. Gaussian-blur each class mask.
//
// Blurring turns the hard masks into smooth fields so the next step's argmax yields
// curved class boundaries with shared borders staying exact. Uses libvips when present
// (fast: streams, works in 8-bit), else ImageMagick. The blur is approximate either way
// — fine, since the result only feeds an argmax. Both strip the GeoTIFF georeferencing;
// the argmax step re-attaches it. Resumable: existing blurred masks are skipped.
export async function blur() {
	const CONCURRENCY = CPU_CORES;
	const PRECISION = 'approximate'; // vips gaussblur precision (fastest)
	const useVips = await commandExists('vips');
	if (!useVips && !(await commandExists('magick')))
		throw new Error('need libvips (vips) or ImageMagick (magick) on PATH');

	for (let i = 0; i < channelDefs.length; i++) {
		if (!existsSync(maskPath(i))) throw new Error(`missing ${maskPath(i)} — run the channels step first`);
	}
	await fs.mkdir(dir.blurred, { recursive: true });

	// vips writes a deflate-compressed 8-bit TIFF; ImageMagick is the fallback
	function blurOne(src, out) {
		if (useVips) {
			return runQuiet('vips', [
				'gaussblur',
				src,
				`${out}[compression=deflate,predictor=horizontal]`,
				String(BLUR_RADIUS),
				'--precision',
				PRECISION,
			]);
		}
		return runQuiet('magick', [src, '-blur', `0x${BLUR_RADIUS}`, '-depth', '8', '-compress', 'Zip', out]);
	}

	console.error(
		'Blurring %d masks with %s (σ=%s px, %d workers)',
		channelDefs.length,
		useVips ? 'vips' : 'ImageMagick',
		BLUR_RADIUS,
		CONCURRENCY,
	);
	const bar = progress(channelDefs.length, 'Blur');
	await pMap(
		channelDefs.map((_, i) => i),
		CONCURRENCY,
		async (i) => {
			const out = blurPath(i);
			if (!existsSync(out)) await blurOne(maskPath(i), out);
			bar.tick();
		},
	);
	bar.done();
}

// 5. Reduce the blurred masks to a single-band code raster via per-pixel argmax.
//
// Stock `gdal raster` commands, streaming block by block: calc `--calc argmax` (1-based
// index of the strongest channel, ties to lowest index) → sieve (drop regions smaller
// than a circle of the blur radius) → reclassify index → code → edit (re-attach the
// EPSG:3857 georeferencing the blur stripped).
export async function argmax() {
	const inputs = channelDefs.map((_, i) => blurPath(i));
	for (const p of inputs) if (!existsSync(p)) throw new Error(`missing ${p} — run the blur step first`);

	// name the inputs A, B, C … in channel order; argmax's index follows input order
	const named = inputs.flatMap((p, i) => ['-i', `${String.fromCharCode(65 + i)}=${p}`]);
	const mapping = channelDefs.map((c, i) => `${i + 1}=${c.code}`).join(';'); // index → code
	const sieveThreshold = 10 * Math.round(Math.PI * BLUR_RADIUS * BLUR_RADIUS);
	const indexTif = path.join(datadir, '_index.tif');
	const sievedTif = path.join(datadir, '_sieved.tif');

	try {
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

		console.error('Reclassifying index → code → %s', file.code);
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
			file.code,
		]);
		console.error('Re-attaching EPSG:3857 georeferencing');
		await run('gdal', [
			'raster',
			'edit',
			'--crs',
			'EPSG:3857',
			'--bbox',
			`${-MERC},${-MERC},${MERC},${MERC}`,
			file.code,
		]);
	} finally {
		await fs.rm(indexTif, { force: true });
		await fs.rm(sievedTif, { force: true });
	}
}

// 6. Vectorize the code raster into the final polygon geometry.
//
// A single global vectorization (no per-tile seams): polygonize → tag each polygon with
// its Shortbread `kind` and drop the no-data class → coverage-simplify (topology-
// preserving, --preserve-boundary keeps the world edge exact) → reproject to EPSG:4326
// for tippecanoe. Result: data/landcover.fgb.
export async function polygonize() {
	const SIMPLIFY = '2000'; // coverage-simplification tolerance in metres (EPSG:3857)
	const kept = channelDefs.filter((c) => c.kind);
	const whens = kept.map((c) => `WHEN ${c.code} THEN '${c.kind}'`).join(' ');
	const SQL = `SELECT *, CASE code ${whens} END AS kind FROM landcover WHERE code IN (${kept.map((c) => c.code).join(',')})`;
	if (!existsSync(file.code)) throw new Error(`missing ${file.code} — run the argmax step first`);

	const codeFgb = path.join(datadir, '_code.fgb');
	const taggedFgb = path.join(datadir, '_tagged.fgb');
	const simplifiedFgb = path.join(datadir, '_simplified.fgb');
	try {
		console.error('Polygonizing → %s', codeFgb);
		await fs.rm(codeFgb, { force: true });
		await run('gdal', [
			'raster',
			'polygonize',
			'-i',
			file.code,
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
			'--preserve-boundary',
			'--output-layer',
			'landcover',
			'-i',
			taggedFgb,
			'-o',
			simplifiedFgb,
			SIMPLIFY,
		]);
		console.error('Reprojecting to EPSG:4326 → %s', file.geometry);
		await fs.rm(file.geometry, { force: true });
		await run('ogr2ogr', [
			'-t_srs',
			'EPSG:4326',
			'-f',
			'FlatGeobuf',
			'-nln',
			'landcover',
			file.geometry,
			simplifiedFgb,
		]);
	} finally {
		await fs.rm(codeFgb, { force: true });
		await fs.rm(taggedFgb, { force: true });
		await fs.rm(simplifiedFgb, { force: true });
	}
}

// 7. Build the vector tile pyramid with tippecanoe → data/landcover.mbtiles.
//
// Oversized tiles stay coverage-complete by simplifying harder and merging the smallest
// polygons (--coalesce-smallest-as-needed) rather than dropping features.
export async function tile(zoom = '6') {
	const [minZoom, maxZoom] = zoom.includes('-') ? zoom.split('-') : [zoom, zoom];
	if (!existsSync(file.geometry)) throw new Error(`missing ${file.geometry} — run the polygonize step first`);

	// keep tippecanoe's multi-GB feature store on the data disk, not a RAM-backed /tmp
	const tmpdir = path.join(datadir, 'tippecanoe-tmp');
	await fs.mkdir(tmpdir, { recursive: true });

	console.error('Tiling zoom %s → %s', zoom, file.tiles);
	await run('tippecanoe', [
		'-o',
		file.tiles,
		'--force',
		'--temporary-directory',
		tmpdir,
		'--minimum-zoom',
		minZoom,
		'--maximum-zoom',
		maxZoom,
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
		file.geometry,
	]);
}

// 8. Pack the tiles into a brotli-compressed versatiles container at the repo root.
export async function pack() {
	if (!existsSync(file.tiles)) throw new Error(`missing ${file.tiles} — run the tile step first`);
	const out = path.join(path.dirname(datadir), 'landcover-vectors.versatiles');
	console.error('Packing → %s', out);
	await run('versatiles', ['convert', '-c', 'brotli', file.tiles, out]);
}

// the pipeline in order; bin/build.js runs these (optionally a named subset)
export const steps = [
	{ name: 'download', run: download },
	{ name: 'reproject', run: reproject },
	{ name: 'channels', run: channels },
	{ name: 'blur', run: blur },
	{ name: 'argmax', run: argmax },
	{ name: 'polygonize', run: polygonize },
	{ name: 'tile', run: tile },
	{ name: 'pack', run: pack },
];
