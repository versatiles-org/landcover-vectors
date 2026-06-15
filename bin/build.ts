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
	'gdaladdo',
	'gdalwarp',
	'gdal_calc.py',
	'ogr2ogr',
	'vips',
	'tippecanoe',
	'tile-join',
	'versatiles',
]);

// Mosaic the source mirror into a single virtual raster, with a global overview pyramid.
// gdalwarp only uses overviews built on the dataset it opens (the VRT) — per-tile sidecars
// are ignored through a VRT — so the pyramid lives next to the VRT (`_mirror.vrt.ovr`). It
// lets the low-zoom block warps read a coarse pyramid level instead of the whole full-res
// mirror (≈100× faster); high-zoom warps still read the original tiles for full detail. The
// VRT + pyramid live in the mirror dir so they persist across builds and `npm run clean`;
// they are rebuilt only when missing or when a source tile is newer than the VRT.
async function ensureMirrorVrt(): Promise<{ vrt: string; tileCount: number }> {
	const tiles = (await fs.readdir(dir.source).catch(() => [] as string[])).filter((f) => f.endsWith('.tif'));
	if (tiles.length === 0) throw new Error(`no source tiles in ${dir.source} — run "npm run download" first`);

	const vrt = path.join(dir.source, '_mirror.vrt');
	const ovr = vrt + '.ovr';
	const vrtStat = await fs.stat(vrt).catch(() => null);
	const ovrExists = await fs.stat(ovr).then(
		() => true,
		() => false,
	);

	let stale = !vrtStat || !ovrExists;
	if (vrtStat && !stale) {
		for (const t of tiles) {
			const s = await fs.stat(path.join(dir.source, t));
			if (s.mtimeMs > vrtStat.mtimeMs) {
				stale = true;
				break;
			}
		}
	}

	if (stale) {
		const listFile = path.join(dir.tmp, '_src.txt');
		await fs.writeFile(listFile, tiles.map((t) => path.join(dir.source, t)).join('\n') + '\n');
		await run('gdalbuildvrt', ['-overwrite', '-input_file_list', listFile, vrt]);
		await fs.rm(ovr, { force: true });
		console.error('Building mirror overview pyramid (one-time; makes every low-zoom warp ≈100× faster) …');
		// mode = categorical-correct decimation; levels span full-res → whole-world at z0
		await run('gdaladdo', [
			'-r',
			'mode',
			'--config',
			'COMPRESS_OVERVIEW',
			'DEFLATE',
			vrt,
			'2',
			'4',
			'8',
			'16',
			'32',
			'64',
			'128',
			'256',
			'512',
			'1024',
			'2048',
		]);
	} else {
		console.error('Reusing mirror VRT + overview pyramid in %s', dir.source);
	}
	return { vrt, tileCount: tiles.length };
}

await fs.mkdir(dir.tmp, { recursive: true });
const { vrt: srcVrt, tileCount } = await ensureMirrorVrt();

const coverage = await buildCoverage();
console.error('Source mirror: %d tiles, %d occupied 3° cells', tileCount, coverage.cells);

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
