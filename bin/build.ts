// Run the whole landcover build pipeline.
//
// Builds zoom levels 0..MAXLEVEL. Each zoom is split into BLOCK×BLOCK-tile blocks; every
// non-empty block is turned into its Shortbread land/water_polygons tiles independently
// (lib/block.ts, bounded memory), and once a zoom's blocks are done, their tiles are joined into one tileset
// of the zoom. Finally the zooms are joined and packed to versatiles (lib/assemble.ts).
// The single EPSG:3857 source raster is built once by bin/download.ts (`npm run download`).

import fs from 'node:fs/promises';

import { setGdalThreads } from '../lib/worldcover.ts';
import { requireTools } from '../lib/tools.ts';
import { startTimingLog, timed } from '../lib/timing.ts';
import { requireSeaShare } from '../lib/ocean.ts';
import { requireClasses } from '../lib/landburn.ts';
import { progress } from '../lib/progress.ts';
import { buildCoverage } from '../lib/coverage.ts';
import { planBlocks, countBlocks } from '../lib/plan.ts';
import { runZooms } from '../lib/pipeline.ts';
import { cacheValues, sourceValues, readStamp, writeStamp, stampMismatch } from '../lib/fingerprint.ts';
import { LOG_HEADER } from '../lib/block.ts';
import { readRunSummary, formatSummary } from '../lib/summary.ts';
import { pack, gitCommit } from '../lib/assemble.ts';
import { datadir, dir, file, MAXLEVEL, BLOCK_CONCURRENCY, CPU_CORES } from '../config.ts';

// fail fast (before the long build) if any external tool is missing or too old
const started = Date.now();

await requireTools(['node', 'gdal', 'gdal_calc', 'tippecanoe', 'versatiles']);
// the commit stamped into the container, read now: the checkout may move on during an hours-long build
const commit = await gitCommit();

// the classes — the reprojected source raster with OSM's land use burned in, with its overview pyramid — are built
// by `npm run download`; blocks read their window from them — coarse levels at low zoom, full detail at high zoom
await requireClasses();
await requireSeaShare();

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

// Refuse to mix caches: the block and zoom tilesets are keyed on zoom + block position only,
// so nothing about their names would reveal that they came from another channel table or sieve.
const cacheStamp = await readStamp(datadir);
const cacheDiff = cacheStamp && stampMismatch(cacheStamp, cacheValues());
if (cacheDiff)
	throw new Error(
		`the cache in ${datadir} was built with other parameters:\n${cacheDiff}\n\n` +
			'Per-block and per-zoom tilesets are keyed on zoom + block position only, so they cannot be ' +
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
startTimingLog(file.timings, 'build', { fingerprint: fp, cores: CPU_CORES, concurrency: BLOCK_CONCURRENCY });
console.error('Config fingerprint: %s — data dir: %s', fp, datadir);
console.error('Per-block log: %s', file.log);

const coverage = await buildCoverage();
console.error('Source: %s — %d occupied 3° cells', file.classes, coverage.cells);

// determine up front, per zoom, the blocks that actually have source data (skip-empty), so the
// progress total reflects real work rather than the mostly-empty ocean blocks
const plan = planBlocks(coverage);

// one progress bar (with ETA) across every non-empty block; cached zooms tick through at once
const bar = progress(countBlocks(plan), 'blocks');

// one block per core (BLOCK_CONCURRENCY), so each block's GDAL calls get one thread instead of all cores
setGdalThreads(1);
const zooms = await timed('build', () =>
	runZooms(plan, {
		src: file.classes,
		tmpdir: dir.tmp,
		resultsdir: dir.results,
		tilesdir: dir.tiles,
		logFile: file.log,
		concurrency: BLOCK_CONCURRENCY,
		bar,
		label: (z) => `zoom ${z}/${MAXLEVEL}`,
	}),
);
bar.done();

await timed('pack', () => pack(zooms, { fingerprint: fp, commit, buildtime: new Date(started) }, dir.tmp));
await fs.rm(dir.tmp, { recursive: true, force: true }); // scratch no longer needed

// what actually happened, from the log this run appended — branch counts included, so a fast path that
// never fires (or a block that failed and got retried) is visible instead of buried in 8000 TSV rows
const summary = await readRunSummary(file.log);
if (summary) console.error('%s', formatSummary(summary, Date.now() - started));
console.error('✓ done: %s', file.container);
