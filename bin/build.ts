// Run the whole landcover build pipeline.
//
// Builds zoom levels 0..MAXLEVEL. Each zoom is split into BLOCK×BLOCK-tile blocks; every
// non-empty block is turned into Shortbread land/water_polygons geometry independently
// (lib/block.ts, bounded memory), then the zoom's blocks are tiled in one tippecanoe run
// (lib/assemble.ts). Finally the per-zoom tilesets are merged and packed to versatiles.
// The single EPSG:3857 source raster is built once by bin/download.ts (`npm run download`).

import fs from 'node:fs/promises';

import { requireCommands } from '../lib/worldcover.ts';
import { requireOcean } from '../lib/ocean.ts';
import { progress } from '../lib/progress.ts';
import { buildCoverage } from '../lib/coverage.ts';
import { planBlocks, countBlocks } from '../lib/plan.ts';
import { runZooms } from '../lib/pipeline.ts';
import { cacheValues, sourceValues, readStamp, writeStamp, stampMismatch } from '../lib/fingerprint.ts';
import { LOG_HEADER } from '../lib/block.ts';
import { readRunSummary, formatSummary } from '../lib/summary.ts';
import { pack } from '../lib/assemble.ts';
import { datadir, dir, file, MAXLEVEL, CPU_CORES } from '../config.ts';

// run this many blocks at once; each block already fans GTiff (de)compression across cores
// via GDAL_NUM_THREADS, so keep block-level parallelism below the core count to avoid
// pathological oversubscription
const BLOCK_CONCURRENCY = Math.max(1, Math.floor(CPU_CORES / 1.5));

// fail fast (before the long build) if any external tool is missing
const started = Date.now();

await requireCommands([
	'gdal',
	'gdalwarp',
	'gdal_translate',
	'gdal_calc.py',
	'gdalinfo', // lib/block.ts reads the window histogram through it
	'gdal_rasterize', // lib/ocean.ts burns OSM's sea into each window
	'ogr2ogr',
	'tippecanoe',
	'tile-join',
	'versatiles',
]);

// the single reprojected source raster (with overview pyramid) is built by `npm run download`;
// blocks read their window from it — coarse levels at low zoom, full detail at high zoom
const haveSource = await fs.stat(file.source).then(
	() => true,
	() => false,
);
if (!haveSource) throw new Error(`missing ${file.source} — run "npm run download" first`);
await requireOcean();

// The source raster is built for one specific FULL_PX; a stamped mismatch means it was produced by a
// different config and every block would read the wrong resolution. Sources from before stamping
// exist, so only an actual mismatch is an error.
const srcStamp = await readStamp(dir.source);
const srcDiff = srcStamp && stampMismatch(srcStamp, sourceValues());
if (srcDiff)
	throw new Error(
		`the source raster in ${dir.source} was built for other parameters:\n${srcDiff}\n\n` +
			'Re-run "npm run download" to rebuild it for the current config.',
	);

// Refuse to mix caches: the fragments and per-zoom tilesets are keyed on zoom + block position only,
// so nothing about their names would reveal that they came from another channel table or sieve.
const cacheStamp = await readStamp(datadir);
const cacheDiff = cacheStamp && stampMismatch(cacheStamp, cacheValues());
if (cacheDiff)
	throw new Error(
		`the cache in ${datadir} was built with other parameters:\n${cacheDiff}\n\n` +
			'Per-block fragments and per-zoom tilesets are keyed on zoom + block position only, so they cannot be ' +
			'mixed. Run "npm run clean" to rebuild (keeps the download), or set LANDCOVER_DATA_DIR to a fresh directory.',
	);
if (!cacheStamp) {
	// nothing to compare against: adopt what is there, but say so if it is not an empty directory
	const leftovers = await Promise.all([dir.results, dir.tiles].map((d) => fs.readdir(d).catch(() => [] as string[])));
	if (leftovers.some((l) => l.length > 0))
		console.error(
			'! adopting an unstamped cache in %s — if it predates a config change, run "npm run clean"',
			datadir,
		);
}

await fs.rm(dir.tmp, { recursive: true, force: true }); // tmp is scratch only — start from a clean slate
await fs.mkdir(dir.tmp, { recursive: true });
await fs.mkdir(dir.results, { recursive: true });
await fs.mkdir(dir.tiles, { recursive: true });
await fs.appendFile(file.log, LOG_HEADER + '\n'); // header row marks the start of this run; rows appended per block
const fp = await writeStamp(datadir, cacheValues());
console.error('Config fingerprint: %s — data dir: %s', fp, datadir);
console.error('Per-block log: %s', file.log);

const coverage = await buildCoverage();
console.error('Source: %s — %d occupied 3° cells', file.source, coverage.cells);

// determine up front, per zoom, the blocks that actually have source data (skip-empty), so the
// progress total reflects real work rather than the mostly-empty ocean blocks
const plan = planBlocks(coverage);

// one progress bar (with ETA) across every non-empty block; cached zooms tick through at once
const bar = progress(countBlocks(plan), 'blocks');

const zMbtiles = await runZooms(plan, {
	src: file.source,
	tmpdir: dir.tmp,
	resultsdir: dir.results,
	tilesdir: dir.tiles,
	logFile: file.log,
	concurrency: BLOCK_CONCURRENCY,
	bar,
	label: (z) => `zoom ${z}/${MAXLEVEL}`,
});
bar.done();

await pack(zMbtiles);
await fs.rm(dir.tmp, { recursive: true, force: true }); // scratch no longer needed

// what actually happened, from the log this run appended — branch counts included, so a fast path that
// never fires (or a block that failed and got retried) is visible instead of buried in 8000 TSV rows
const summary = await readRunSummary(file.log);
if (summary) console.error('%s', formatSummary(summary, Date.now() - started));
console.error('✓ done: %s', file.container);
