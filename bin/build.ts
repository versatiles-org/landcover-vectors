// Run the whole landcover build pipeline.
//
// Builds zoom levels 0..MAXLEVEL. Each zoom is split into BLOCK×BLOCK-tile blocks; every
// non-empty block is turned into Shortbread land/water_polygons geometry independently
// (lib/block.ts, bounded memory), then the zoom's blocks are tiled in one tippecanoe run
// (lib/assemble.ts). Finally the per-zoom tilesets are merged and packed to versatiles.
// The single EPSG:3857 source raster is built once by bin/download.ts (`npm run download`).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { requireCommands, pMap } from '../lib/worldcover.ts';
import { progress } from '../lib/progress.ts';
import { buildCoverage } from '../lib/coverage.ts';
import { planBlocks, countBlocks } from '../lib/plan.ts';
import { cacheValues, sourceValues, readStamp, writeStamp, stampMismatch } from '../lib/fingerprint.ts';
import { processBlock, LOG_HEADER, type BlockFragments } from '../lib/block.ts';
import { tileZoom, pack } from '../lib/assemble.ts';
import { datadir, dir, file, MAXLEVEL, CPU_CORES } from '../config.ts';

// run this many blocks at once; each block already fans GTiff (de)compression across cores
// via GDAL_NUM_THREADS, so keep block-level parallelism below the core count to avoid
// pathological oversubscription
const BLOCK_CONCURRENCY = Math.max(1, Math.floor(CPU_CORES / 1.5));

// fail fast (before the long build) if any external tool is missing
await requireCommands([
	'gdal',
	'gdalwarp',
	'gdal_translate',
	'gdal_calc.py',
	'gdalinfo', // lib/block.ts reads the window histogram through it
	'ogr2ogr',
	'vips',
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
// so nothing about their names would reveal that they came from another channel table or blur radius.
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

const zMbtiles: string[] = [];
for (const { z, blocks } of plan) {
	bar.setLabel(`zoom ${z}/${MAXLEVEL}`);

	// resume: a cached per-zoom tileset means the whole level is done — skip its blocks entirely
	const zMb = path.join(dir.tiles, `z${z}.mbtiles`);
	if (existsSync(zMb)) {
		zMbtiles.push(zMb);
		bar.tick(blocks.length);
		continue;
	}

	// collect by block index, not by completion order: this order is the order the fragments are
	// unioned in and handed to tippecanoe, so keeping it stable makes two runs of the same config
	// produce identical tiles
	const collected: (BlockFragments | null)[] = blocks.map(() => null);
	const failed: { id: string; err: unknown }[] = [];
	await pMap(
		blocks.map((_, i) => i),
		BLOCK_CONCURRENCY,
		async (i) => {
			const [bx, by] = blocks[i];
			try {
				const f = await processBlock(z, bx, by, {
					src: file.source,
					tmpdir: dir.tmp,
					resultsdir: dir.results,
					logFile: file.log,
				});
				if (f.land || f.water) collected[i] = f;
			} catch (err) {
				// one bad block must not discard the zoom's other few thousand: every finished block is
				// cached, so a rerun retries just the failures. processBlock already logged a `failed` row.
				failed.push({ id: `z${z}_${bx}_${by}`, err });
			}
			bar.tick();
		},
	);

	// a partial zoom must never be tiled — report every failure of this zoom at once and stop here
	if (failed.length) {
		const ids = failed.slice(0, 8).map((f) => f.id);
		throw new AggregateError(
			failed.map((f) => f.err),
			`zoom ${z}: ${failed.length} of ${blocks.length} blocks failed (${ids.join(', ')}` +
				`${failed.length > ids.length ? ', …' : ''}) — see ${file.log}; finished blocks are cached, ` +
				`so rerunning retries only the failures`,
		);
	}
	const fragments = collected.filter((f): f is BlockFragments => f !== null);

	const mb = await tileZoom(z, fragments);
	if (mb) zMbtiles.push(mb);
}
bar.done();

await pack(zMbtiles);
await fs.rm(dir.tmp, { recursive: true, force: true }); // scratch no longer needed
console.error('✓ done');
