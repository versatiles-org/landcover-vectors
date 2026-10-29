// An experiment's source: the pipeline's pyramids (lib/window.ts), but only around the test regions.
//
// The build reads a block's window out of two world-sized pyramids on one grid (FULL_PX², EPSG:3857): the ESA
// classes and the sea share. Building those for the planet takes hours and 23 GB; an experiment needs a few windows.
// So each region gets small rasters of its own, cut on that same grid and aligned to whole z10 tiles (1024 px, the
// coarsest overview's pixel), with overviews of their own. A VRT per pyramid level then places every region's level
// at its offset in the world, and the blocks read it like the real thing: outside the regions, every pixel is 0.
//
// Per region, once:
//   esa.tif           ESA WorldCover, warped from the bucket exactly like the download warps the world (mode,
//                     -dstnodata 0)
//   seashare.tif      OSM's water polygons (the download's ocean mask) as the sea share (100 = sea), simplified
//                     and with average overviews, exactly like the download's pyramid (lib/ocean.ts)
//   land-<date>.vrt   OSM's land use, imported from that planet's land-use file (lib/osmland.ts): what a variant
//                     burns from (regionLand, for all regions in one pass)
// Per variant (burnedSource): esa.tif with the burns, its overviews, and both pyramids as VRTs (pyramidVrt).

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { runQuiet, atomic, listSourceKeys, BUCKET } from './worldcover.ts';
import { parseCorner, CELL } from './coverage.ts';
import { extractBoxes, importLand } from './osmland.ts';
import { extent3857, extentLonLat, extentTiles, type Region } from './regions.ts';
import { burnLand } from './landburn.ts';
import { MERC, FULL_PX, TILE_PX, MAXLEVEL, file, type Burn } from '../config.ts';

const PX = (2 * MERC) / FULL_PX; // metres per source pixel
const OVERVIEWS = Array.from({ length: MAXLEVEL }, (_, i) => 2 ** (i + 1)); // as the download builds them
const GTIFF = ['-co', 'TILED=YES', '-co', 'COMPRESS=ZSTD', '-co', 'BIGTIFF=IF_SAFER'];

// the bucket's tile list, fetched once per experiment directory
export async function sourceKeys(dir: string): Promise<string[]> {
	const list = path.join(dir, '_source-tiles.txt');
	if (!existsSync(list)) {
		const keys = await listSourceKeys();
		await atomic(list, (tmp) => fs.writeFile(tmp, keys.join('\n') + '\n'));
	}
	return (await fs.readFile(list, 'utf8')).split('\n').filter(Boolean);
}

// the ESA tiles a region's extent touches
export function regionKeys(region: Region, keys: string[]): string[] {
	const e = extentLonLat(region.window);
	return keys.filter((k) => {
		const c = parseCorner(path.basename(k));
		return c && c.lon < e.east && c.lon + CELL > e.west && c.lat < e.north && c.lat + CELL > e.south;
	});
}

// the region's extent on the source grid: offset into the world, and size, in source pixels
export function regionGrid(region: Region) {
	const t = extentTiles(region.window);
	return { x: t.x0 * TILE_PX, y: t.y0 * TILE_PX, width: (t.x1 - t.x0) * TILE_PX, height: (t.y1 - t.y0) * TILE_PX };
}

const te = (region: Region) => {
	const e = extent3857(region.window);
	return ['-te', e.minx, e.miny, e.maxx, e.maxy];
};

export async function prepareRegion(dir: string, region: Region, keys: string[]): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const g = regionGrid(region);

	const esa = path.join(dir, 'esa.tif');
	if (!existsSync(esa)) {
		const vrt = path.join(dir, 'esa-remote.vrt');
		const e = extentLonLat(region.window);
		const pad = 0.05; // degrees, so the warp's mode sees whole source pixels at the edge
		await runQuiet(
			'gdalbuildvrt',
			'-q',
			'-overwrite',
			['-te', e.west - pad, e.south - pad, e.east + pad, e.north + pad],
			vrt,
			keys.map((k) => `/vsicurl/${BUCKET}/${k}`),
		);
		await atomic(esa, (tmp) =>
			runQuiet(
				'gdalwarp',
				'-q',
				['-t_srs', 'EPSG:3857'],
				te(region),
				['-ts', g.width, g.height],
				['-r', 'mode'],
				['-ot', 'Byte'],
				['-dstnodata', 0],
				['-of', 'GTiff'],
				GTIFF,
				vrt,
				tmp,
			),
		);
		await fs.rm(vrt, { force: true });
	}

	const share = path.join(dir, 'seashare.tif');
	if (!existsSync(share)) {
		const e = extent3857(region.window);
		const ocean = path.join(dir, 'ocean.fgb');
		await fs.rm(ocean, { force: true });
		await runQuiet(
			'ogr2ogr',
			['-spat', e.minx, e.miny, e.maxx, e.maxy],
			['-simplify', PX / 2], // as the download's pyramid simplifies them
			['-f', 'FlatGeobuf'],
			['-lco', 'SPATIAL_INDEX=NO'],
			['-nln', 'ocean'],
			['-nlt', 'PROMOTE_TO_MULTI'],
			ocean,
			file.ocean,
			'ocean',
		);
		await atomic(share, async (tmp) => {
			await runQuiet(
				'gdal_rasterize',
				'-q',
				['-burn', 100],
				['-init', 0],
				['-l', 'ocean'],
				['-a_srs', 'EPSG:3857'],
				te(region),
				['-ts', g.width, g.height],
				['-ot', 'Byte'],
				['-of', 'GTiff'],
				GTIFF,
				ocean,
				tmp,
			);
			// gdal_rasterize marks 0 as no-data on what it creates; here 0 is land and has to count in the averages
			await runQuiet('gdal', 'raster', 'edit', ['--nodata', 'none'], tmp);
			// average overviews: every level holds the sea share of its pixels, as in lib/ocean.ts
			await runQuiet('gdaladdo', '-q', ['-r', 'average'], tmp, OVERVIEWS);
		});
		await fs.rm(ocean, { force: true });
	}
}

// a region's land use from the planet of `date`
export const regionLandPath = (regionDir: string, date: string) => path.join(regionDir, `land-${date}.vrt`);

// OSM's land use for every region that lacks it: one extract pass over the land-use file, then an import each
export async function regionLand(
	regions: { dir: string; region: Region }[],
	landuse: { file: string; date: string },
	tmpdir: string,
): Promise<void> {
	const missing = regions.filter((r) => !existsSync(regionLandPath(r.dir, landuse.date)));
	if (!missing.length) return;
	console.error('  importing OSM land use for %d region(s) from %s …', missing.length, landuse.file);
	const pbf = (r: { dir: string }) => path.join(r.dir, `landuse-${landuse.date}.osm.pbf`);
	await extractBoxes(
		landuse.file,
		missing.map((r) => ({ box: extentLonLat(r.region.window), out: pbf(r) })),
		tmpdir,
	);
	for (const r of missing) {
		await importLand(pbf(r), regionLandPath(r.dir, landuse.date), path.join(tmpdir, 'osm'));
		await fs.rm(pbf(r), { force: true });
	}
}

// the region's ESA classes with a variant's burns from `land` (lib/landburn.ts, as the download burns the world),
// and overviews: `out`
export async function burnedSource(
	regionDir: string,
	land: string,
	burns: Burn[],
	out: string,
	tmpdir: string,
): Promise<void> {
	if (existsSync(out)) return;
	await atomic(out, async (tmp) => {
		await fs.copyFile(path.join(regionDir, 'esa.tif'), tmp);
		await burnLand(tmp, land, burns, tmpdir);
		// mode, as the download builds the world's: aligned to 1024 px, every level's pixels are the world's
		await runQuiet('gdaladdo', '-q', ['-r', 'mode'], tmp, OVERVIEWS);
	});
}

export type Part = { file: string; x: number; y: number; width: number; height: number }; // source pixels

// A world-sized pyramid as VRTs: `out` is the base, and `out`.levels/ holds one VRT per overview, each placing
// the parts' matching overview. `nodata` as the real pyramid has it: 0 for the classes, none for the sea share.
export async function pyramidVrt(out: string, parts: Part[], nodata?: number): Promise<void> {
	const levels = out + '.levels';
	await fs.mkdir(levels, { recursive: true });
	const vrt = (f: number, sources: string, overviews = '') => {
		const n = FULL_PX / f;
		const nd = nodata === undefined ? '' : `\n    <NoDataValue>${nodata}</NoDataValue>`;
		return `<VRTDataset rasterXSize="${n}" rasterYSize="${n}">
  <SRS>EPSG:3857</SRS>
  <GeoTransform>${-MERC}, ${(2 * MERC) / n}, 0, ${MERC}, 0, ${(-2 * MERC) / n}</GeoTransform>
  <VRTRasterBand dataType="Byte" band="1">${nd}${sources}${overviews}
  </VRTRasterBand>
</VRTDataset>
`;
	};
	const sources = (f: number, overview: number | null) =>
		parts
			.map((p) => {
				const open =
					overview === null ? '' : `<OpenOptions><OOI key="OVERVIEW_LEVEL">${overview}</OOI></OpenOptions>`;
				const [x, y, w, h] = [p.x / f, p.y / f, p.width / f, p.height / f];
				if (![x, y, w, h].every(Number.isInteger)) throw new Error(`${p.file}: not aligned to the 1:${f} level`);
				return `
    <SimpleSource>
      <SourceFilename relativeToVRT="0">${path.resolve(p.file)}</SourceFilename>${open}
      <SourceBand>1</SourceBand>
      <SrcRect xOff="0" yOff="0" xSize="${w}" ySize="${h}"/>
      <DstRect xOff="${x}" yOff="${y}" xSize="${w}" ySize="${h}"/>
    </SimpleSource>`;
			})
			.join('');
	let overviews = '';
	for (const [i, f] of OVERVIEWS.entries()) {
		const level = path.resolve(levels, `1-${f}.vrt`);
		await fs.writeFile(level, vrt(f, sources(f, i)));
		overviews += `\n    <Overview><SourceFilename relativeToVRT="0">${level}</SourceFilename><SourceBand>1</SourceBand></Overview>`;
	}
	await fs.writeFile(out, vrt(1, sources(1, null), overviews));
}
