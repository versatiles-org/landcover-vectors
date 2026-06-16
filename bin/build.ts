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
import { buildCoverage } from '../lib/coverage.ts';
import { processBlock, type BlockFragments } from '../lib/block.ts';
import { tileZoom, pack } from '../lib/assemble.ts';
import { dir, file, MAXLEVEL, CPU_CORES, blocksPerAxis } from '../config.ts';

// run this many blocks at once; each block already fans GTiff (de)compression across cores
// via GDAL_NUM_THREADS, so keep block-level parallelism below the core count to avoid
// pathological oversubscription
const BLOCK_CONCURRENCY = Math.max(1, Math.floor(CPU_CORES / 2));

// fail fast (before the long build) if any external tool is missing
await requireCommands([
	'gdal',
	'gdalwarp',
	'gdal_translate',
	'gdal_calc.py',
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
await fs.mkdir(dir.tmp, { recursive: true });
await fs.mkdir(dir.results, { recursive: true });
await fs.mkdir(dir.tiles, { recursive: true });

const coverage = await buildCoverage();
console.error('Source: %s — %d occupied 3° cells', file.source, coverage.cells);

const zMbtiles: string[] = [];
for (let z = 0; z <= MAXLEVEL; z++) {
	// resume: a cached per-zoom tileset means the whole level is done — skip its blocks entirely
	const zMb = path.join(dir.tiles, `z${z}.mbtiles`);
	if (existsSync(zMb)) {
		console.error('\n══════ zoom %d / %d — cached ══════', z, MAXLEVEL);
		zMbtiles.push(zMb);
		continue;
	}

	const n = blocksPerAxis(z);
	const blocks: [number, number][] = [];
	for (let by = 0; by < n; by++) for (let bx = 0; bx < n; bx++) blocks.push([bx, by]);

	console.error('\n══════ zoom %d / %d — %d×%d blocks ══════', z, MAXLEVEL, n, n);
	const fragments: BlockFragments[] = [];
	let done = 0;
	await pMap(blocks, BLOCK_CONCURRENCY, async ([bx, by]) => {
		const f = await processBlock(z, bx, by, { src: file.source, coverage, tmpdir: dir.tmp, resultsdir: dir.results });
		if (f.land || f.water) fragments.push(f);
		if (++done % 100 === 0 || done === blocks.length)
			console.error('  blocks %d/%d (%d non-empty)', done, blocks.length, fragments.length);
	});

	const mb = await tileZoom(z, fragments);
	if (mb) zMbtiles.push(mb);
}

await pack(zMbtiles);
console.error('\n✓ done');
