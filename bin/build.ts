// Run the whole landcover build pipeline.
//
// Builds zoom levels 0..MAXLEVEL. Each zoom is split into BLOCK×BLOCK-tile blocks; every
// non-empty block is turned into Shortbread land/water_polygons geometry independently
// (lib/block.ts, bounded memory), then the zoom's blocks are tiled in one tippecanoe run
// (lib/assemble.ts). Finally the per-zoom tilesets are merged and packed to versatiles.
// The one-time source-mirror fetch is a separate script, bin/download.ts (`npm run download`).

import fs from 'node:fs/promises';
import path from 'node:path';

import { run, requireCommands, pMap } from '../lib/worldcover.ts';
import { buildCoverage } from '../lib/coverage.ts';
import { processBlock, type BlockFragments } from '../lib/block.ts';
import { tileZoom, pack } from '../lib/assemble.ts';
import { dir, MAXLEVEL, CPU_CORES, blocksPerAxis } from '../config.ts';

// run this many blocks at once; each block already fans GTiff (de)compression across cores
// via GDAL_NUM_THREADS, so keep block-level parallelism below the core count to avoid
// pathological oversubscription
const BLOCK_CONCURRENCY = Math.max(1, Math.floor(CPU_CORES / 2));

// fail fast (before the long build) if any external tool is missing
await requireCommands([
	'gdal',
	'gdalbuildvrt',
	'gdalwarp',
	'gdal_calc.py',
	'ogr2ogr',
	'vips',
	'tippecanoe',
	'tile-join',
	'versatiles',
]);

// mosaic the source mirror into a single virtual raster the blocks warp from
const tiles = (await fs.readdir(dir.source).catch(() => [] as string[])).filter((f) => f.endsWith('.tif'));
if (tiles.length === 0) throw new Error(`no source tiles in ${dir.source} — run "npm run download" first`);
await fs.mkdir(dir.tmp, { recursive: true });
const srcVrt = path.join(dir.tmp, '_src.vrt');
const listFile = path.join(dir.tmp, '_src.txt');
await fs.writeFile(listFile, tiles.map((t) => path.join(dir.source, t)).join('\n') + '\n');
await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listFile, srcVrt]);

const coverage = await buildCoverage();
console.error('Source mirror: %d tiles, %d occupied 3° cells', tiles.length, coverage.cells);

const zMbtiles: string[] = [];
for (let z = 0; z <= MAXLEVEL; z++) {
	const n = blocksPerAxis(z);
	const blocks: [number, number][] = [];
	for (let by = 0; by < n; by++) for (let bx = 0; bx < n; bx++) blocks.push([bx, by]);

	console.error('\n══════ zoom %d / %d — %d×%d blocks ══════', z, MAXLEVEL, n, n);
	const fragments: BlockFragments[] = [];
	let done = 0;
	await pMap(blocks, BLOCK_CONCURRENCY, async ([bx, by]) => {
		const f = await processBlock(z, bx, by, { srcVrt, coverage, tmpdir: dir.tmp });
		if (f.land || f.water) fragments.push(f);
		if (++done % 100 === 0 || done === blocks.length)
			console.error('  blocks %d/%d (%d non-empty)', done, blocks.length, fragments.length);
	});

	const mb = await tileZoom(z, fragments);
	if (mb) zMbtiles.push(mb);
}

await pack(zMbtiles);
console.error('\n✓ done');
