// OSM's land use, burned into ESA's classes (config.ts OSM_BURNS): the raster the blocks read.
//
// The burn happens on the source's own grid, before the overviews: every burned pixel is then resampled (mode),
// sieved and simplified exactly like ESA's own, and nothing downstream knows where a class came from. burnLand
// burns into one raster; the experiment burns its regions with it (lib/regionsource.ts), and the download the
// world (buildClasses), so what the experiment measures is what the build makes.
//
// buildClasses works like the sea share (lib/ocean.ts): the world in tiles of 16384² px, in parallel. A tile with
// land use is cut out of the source, burned, and kept; one without is not written at all. A VRT then lays the
// burned tiles over the source, and that is written out as one GeoTIFF with mode overviews, like the source.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { runQuiet, runCapture, runProgress, atomic, pMap } from './worldcover.ts';
import { progress } from './progress.ts';
import { timed } from './timing.ts';
import { readStamp } from './fingerprint.ts';
import { dir, file, MERC, FULL_PX, MAXLEVEL, CPU_CORES, type Burn, type Rect } from '../config.ts';

const quoted = (kinds: string[]) => kinds.map((k) => `'${k}'`).join(',');

// Burn `burns` in order into `tif` (in place), from `land` (a FlatGeobuf, layer `land`, field `kind`). Pixel
// centres inside a polygon take its burn's class; a later burn overwrites an earlier one. `scratch` is a folder
// for the temp files, which are named after `tif`.
export async function burnLand(tif: string, land: string, burns: Burn[], scratch: string): Promise<void> {
	await fs.mkdir(scratch, { recursive: true });
	const temp = (what: string, i: number, ext: string) =>
		path.join(scratch, `${path.basename(tif, '.tif')}-${what}${i}${ext}`);
	for (const [i, b] of burns.entries()) {
		const where = `kind IN (${quoted(b.kinds)})`;
		let from: (string | number)[] = [['-l', 'land'], ['-where', where], land].flat();
		const polygons = temp('burn', i, '.fgb');
		if (b.close) {
			// closing: grow every polygon by `close` pixels, union, and shrink back, which fills gaps narrower than
			// twice that and leaves the outline where it was. Growing each before the union also mends OSM's invalid
			// rings, on which a union of the polygons themselves gives NULL. No polygons of the kinds union to NULL.
			const d = b.close * (await pixelSize(tif));
			await fs.rm(polygons, { force: true });
			await runQuiet(
				'ogr2ogr',
				['-f', 'FlatGeobuf'],
				['-lco', 'SPATIAL_INDEX=NO'], // read once, by gdal_rasterize
				['-dialect', 'SQLite'],
				[
					'-sql',
					`SELECT * FROM (SELECT ST_Buffer(ST_Union(ST_Buffer(geometry, ${d})), ${-d}) AS geometry ` +
						`FROM land WHERE ${where}) WHERE geometry IS NOT NULL`,
				],
				['-nln', 'burn'],
				['-nlt', 'PROMOTE_TO_MULTI'],
				polygons,
				land,
			);
			from = ['-l', 'burn', polygons];
		}
		const before = temp('before', i, '.tif');
		if (b.keep) await fs.copyFile(tif, before);
		await runQuiet('gdal_rasterize', '-q', ['-burn', b.esa], from, tif);
		await fs.rm(polygons, { force: true });
		if (b.keep) {
			// back to the class before the burn under the `keep` kinds: marked 255, which ESA never uses
			const mask = temp('keep', i, '.tif');
			const burned = temp('burned', i, '.tif');
			await fs.copyFile(before, mask);
			await fs.rename(tif, burned);
			await runQuiet(
				'gdal_rasterize',
				'-q',
				['-burn', 255],
				['-l', 'land'],
				['-where', `kind IN (${quoted(b.keep)})`],
				land,
				mask,
			);
			await runQuiet(
				'gdal_calc.py',
				['-A', before],
				['-B', burned],
				['-M', mask],
				['--calc', 'where(M==255, A, B)'],
				['--type', 'Byte'],
				['--NoDataValue', 0],
				['--co', 'TILED=YES'],
				['--co', 'COMPRESS=ZSTD'],
				'--overwrite',
				'--quiet',
				['--outfile', tif],
			);
			await Promise.all([before, mask, burned].map((f) => fs.rm(f, { force: true })));
		}
	}
}

// metres per pixel of a north-up raster
async function pixelSize(tif: string): Promise<number> {
	const info = JSON.parse(await runCapture('gdalinfo', '-json', tif)) as { geoTransform: number[] };
	return info.geoTransform[1];
}

// every kind the burns read
const burnKinds = (burns: Burn[]) => [...new Set(burns.flatMap((b) => [...b.kinds, ...(b.keep ?? [])]))];

// ---------------------------------------------------------------- the world

const CLASS_TILES = 64; // tiles per axis: 16384² px each at TILE_PX 1024, as for the sea share
const OVERVIEWS = (levels: number) => Array.from({ length: levels }, (_, i) => 2 ** (i + 1));

export type ClassesOpts = {
	source: string; // the ESA classes (the download's source raster)
	land: string; // OSM's land use (lib/osmland.ts importLand)
	burns: Burn[];
	tilesDir: string; // per-tile rasters; kept across an interrupted run, so a rerun resumes
	fullPx?: number; // side of the base level (default: the source raster's)
	tiles?: number; // tiles per axis
	levels?: number; // overview levels (default: down to z0)
	concurrency?: number;
};

// build the burned classes into `out` (atomically): burn tile by tile in parallel, lay over the source, overviews
export async function buildClasses(out: string, opts: ClassesOpts): Promise<void> {
	const { source, land, burns, tilesDir, fullPx = FULL_PX, tiles = CLASS_TILES, levels = MAXLEVEL } = opts;
	if (fullPx % tiles !== 0) throw new Error(`classes: ${fullPx} px do not split into ${tiles} tiles`);
	const tilePx = fullPx / tiles;
	const span = (2 * MERC) / tiles; // metres per tile
	await fs.mkdir(tilesDir, { recursive: true });

	const jobs: [number, number][] = [];
	for (let y = 0; y < tiles; y++) for (let x = 0; x < tiles; x++) jobs.push([x, y]);
	const tilePath = ([x, y]: [number, number]) => path.join(tilesDir, `${x}_${y}.tif`);
	const emptyPath = (job: [number, number]) => tilePath(job).replace(/\.tif$/, '.none');
	const bar = progress(jobs.length, 'land use');
	const oneThread = ['--config', 'GDAL_NUM_THREADS', 1]; // one tile per core, as for the sea share
	await timed('tiles', () =>
		pMap(jobs, opts.concurrency ?? CPU_CORES, async (job) => {
			const tif = tilePath(job);
			if (!existsSync(tif) && !existsSync(emptyPath(job)))
				await timed(
					'tile',
					async () => {
						const [x, y] = job;
						const r: Rect = {
							minx: -MERC + x * span,
							maxx: -MERC + (x + 1) * span,
							maxy: MERC - y * span,
							miny: MERC - (y + 1) * span,
						};
						// the tile's polygons, through the spatial index: the burns then read only those
						const clip = tif.replace(/\.tif$/, '.fgb');
						await fs.rm(clip, { force: true });
						await runQuiet(
							'ogr2ogr',
							oneThread,
							['-spat', r.minx, r.miny, r.maxx, r.maxy],
							['-where', `kind IN (${quoted(burnKinds(burns))})`],
							['-f', 'FlatGeobuf'],
							['-lco', 'SPATIAL_INDEX=NO'],
							['-nln', 'land'],
							['-nlt', 'PROMOTE_TO_MULTI'],
							clip,
							land,
							'land',
						);
						const count = Number(
							(await runCapture('ogrinfo', '-so', clip, 'land')).match(/Feature Count: (\d+)/)?.[1] ?? 0,
						);
						if (count === 0) {
							await fs.writeFile(emptyPath(job), ''); // nothing to burn: the source shows through
						} else {
							await atomic(tif, async (tmp) => {
								await runQuiet(
									'gdal_translate',
									'-q',
									oneThread,
									['-srcwin', x * tilePx, y * tilePx, tilePx, tilePx],
									['-co', 'TILED=YES'],
									['-co', 'COMPRESS=ZSTD'],
									['-co', 'SPARSE_OK=TRUE'],
									source,
									tmp,
								);
								await burnLand(tmp, clip, burns, path.join(tilesDir, 'scratch'));
							});
						}
						await fs.rm(clip, { force: true });
					},
					`${job[0]}_${job[1]}`,
				);
			bar.tick();
		}),
	);
	bar.done();

	// the source, and the burned tiles over it: a VRT draws its sources in order, the later on top. Written by hand
	// rather than by gdalbuildvrt, which skips (with only a warning) any input whose band metadata differs from the
	// first's, e.g. a GeoTIFF tile's Gray against a VRT source's Undefined. The tiles are on the source's grid.
	const vrt = path.join(tilesDir, 'mosaic.vrt');
	await runQuiet('gdalbuildvrt', '-q', '-overwrite', vrt, path.resolve(source));
	const tileSources = jobs
		.filter((job) => existsSync(tilePath(job)))
		.map(
			([x, y]) =>
				`<SimpleSource><SourceFilename relativeToVRT="0">${path.resolve(tilePath([x, y]))}</SourceFilename>` +
				`<SourceBand>1</SourceBand><SrcRect xOff="0" yOff="0" xSize="${tilePx}" ySize="${tilePx}"/>` +
				`<DstRect xOff="${x * tilePx}" yOff="${y * tilePx}" xSize="${tilePx}" ySize="${tilePx}"/></SimpleSource>\n`,
		)
		.join('');
	const xml = await fs.readFile(vrt, 'utf8');
	const end = xml.lastIndexOf('</VRTRasterBand>');
	if (end < 0) throw new Error(`classes: no band in ${vrt}`);
	await fs.writeFile(vrt, xml.slice(0, end) + tileSources + xml.slice(end));
	await atomic(out, async (tmp) => {
		await runProgress('mosaic', 'gdal_translate', CLASSES_CO, vrt, tmp);
		await runProgress('overviews', 'gdaladdo', CLASSES_OVERVIEWS, tmp, OVERVIEWS(levels));
	});
	await fs.rm(tilesDir, { recursive: true, force: true });
}

export const CLASSES_STAMP = '.fingerprint-classes'; // its stamp, next to the source raster's own

// fail early, before a long run, when the classes are missing or were built for another grid
export async function requireClasses(): Promise<void> {
	if (!existsSync(file.classes))
		throw new Error(`missing ${file.classes} — run "npm run download" (it keeps what is already there)`);
	const builtFor = (await readStamp(dir.source, CLASSES_STAMP))?.values?.fullPx;
	if (builtFor !== undefined && builtFor !== FULL_PX)
		throw new Error(`${file.classes} was built for FULL_PX ${builtFor}, not ${FULL_PX} — re-run "npm run download"`);
}

// how the source raster and the classes are written (lib/download.ts): tiled ZSTD 9, sparse, BigTIFF
// ZSTD 9: about a third smaller than DEFLATE 1 on ESA classes, at the same read and write speed (LZW is as small;
// ZSTD 19 saves another ~15 % but writes ~40× slower). No predictor: class codes are categories, so differencing
// neighbours only adds entropy.
export const CLASSES_CO = [
	['-co', 'TILED=YES'],
	['-co', 'BLOCKXSIZE=512'],
	['-co', 'BLOCKYSIZE=512'],
	['-co', 'COMPRESS=ZSTD'],
	['-co', 'ZSTD_LEVEL=9'],
	['-co', 'PREDICTOR=1'],
	['-co', 'BIGTIFF=YES'],
	['-co', 'SPARSE_OK=TRUE'],
	['-co', 'NUM_THREADS=ALL_CPUS'],
].flat();
// and their overviews: the dominant class, the only correct resampling for categorical data
export const CLASSES_OVERVIEWS = [
	['-r', 'mode'],
	['--config', 'COMPRESS_OVERVIEW', 'ZSTD'],
	['--config', 'ZSTD_LEVEL_OVERVIEW', 9],
	['--config', 'GDAL_NUM_THREADS', 'ALL_CPUS'],
].flat();
