// Assemble per-block fragments into per-zoom tiles, then merge + pack.
//
// All block fragments of a zoom are unioned per layer (OGR VRT union → one FlatGeobuf),
// then a single tippecanoe run tiles that zoom into the `land` + `water_polygons` layers
// (tippecanoe sees the whole zoom, so per-tile buffers fill across block seams — no
// hairlines). The per-zoom mbtiles (disjoint zooms) are tile-joined and packed to versatiles.

import fs from 'node:fs/promises';
import path from 'node:path';

import { run, runQuiet, atomic, type Arg } from './worldcover.ts';
import type { BlockFragments } from './block.ts';
import { file, meta } from '../config.ts';

// where a tiling run puts its scratch and its per-zoom tilesets. Passed in rather than read from
// config so a preview run can tile into its own directory while the production cache stays untouched.
export type TileDirs = { tmp: string; tiles: string };

function vrtUnion(files: string[], layerName: string): string {
	return (
		`<OGRVRTDataSource>\n  <OGRVRTUnionLayer name="${layerName}">\n` +
		files
			.map((f) => `    <OGRVRTLayer name="${layerName}"><SrcDataSource>${f}</SrcDataSource></OGRVRTLayer>`)
			.join('\n') +
		`\n  </OGRVRTUnionLayer>\n</OGRVRTDataSource>\n`
	);
}

// concatenate fragments for one layer into a single FlatGeobuf via an OGR VRT union
async function mergeLayer(files: string[], layerName: string, out: string): Promise<boolean> {
	if (files.length === 0) return false;
	const vrt = out + '.vrt';
	await fs.writeFile(vrt, vrtUnion(files, layerName));
	await fs.rm(out, { force: true });
	// SPATIAL_INDEX=NO: this merged fgb is only read sequentially by tippecanoe, so skip building the
	// Hilbert R-tree — it would buffer+sort every feature to a temp file (often /tmp), which on a large
	// zoom exhausts temp space ("Unexpected I/O failure: writing feature"). No index → single-pass write.
	await runQuiet('ogr2ogr', ['-f', 'FlatGeobuf'], ['-lco', 'SPATIAL_INDEX=NO'], ['-nln', layerName], out, vrt);
	await fs.rm(vrt, { force: true });
	return true;
}

// tile one zoom: merge all block fragments per layer, then one tippecanoe run → z{z}.mbtiles
export async function tileZoom(z: number, fragments: BlockFragments[], dirs: TileDirs): Promise<string | null> {
	const land = fragments.map((f) => f.land).filter((f): f is string => !!f);
	const water = fragments.map((f) => f.water).filter((f): f is string => !!f);
	if (land.length === 0 && water.length === 0) return null;

	const landFgb = path.join(dirs.tmp, `z${z}_land.fgb`);
	const waterFgb = path.join(dirs.tmp, `z${z}_water.fgb`);
	const hasLand = await mergeLayer(land, 'land', landFgb);
	const hasWater = await mergeLayer(water, 'water_polygons', waterFgb);

	// cached per-zoom tileset; written atomically (temp → rename) so its presence means "done"
	const out = path.join(dirs.tiles, `z${z}.mbtiles`);
	await atomic(out, (tmp) => {
		const args: Arg[] = [
			['-o', tmp],
			'--force',
			['-Z', z],
			['-z', z],
			['--attribute-type', 'kind:string'],
			['--include', 'kind'], // keep only `kind` in the tiles
			'--coalesce-smallest-as-needed', // keep coverage complete instead of dropping features
			['--name', meta.name],
			['--attribution', meta.attribution],
			['--description', meta.description],
		];
		if (hasLand) args.push(['-L', `land:${landFgb}`]);
		if (hasWater) args.push(['-L', `water_polygons:${waterFgb}`]);
		return runQuiet('tippecanoe', ...args);
	});

	// the merged fgb were only needed to feed tippecanoe — drop them now to free disk between zooms
	await Promise.all([fs.rm(landFgb, { force: true }), fs.rm(waterFgb, { force: true })]);
	return out;
}

// merge the per-zoom tilesets (disjoint zooms) into one mbtiles, stamping the tileset metadata
export async function joinZooms(zMbtiles: string[], out: string): Promise<void> {
	if (zMbtiles.length === 0) throw new Error('nothing to join — no zoom produced any tiles');
	await fs.rm(out, { force: true });
	await run(
		'tile-join',
		'-f',
		['--name', meta.name],
		['--attribution', meta.attribution],
		['--description', meta.description],
		['-o', out],
		zMbtiles,
	);
}

// merge the per-zoom tilesets and pack into a brotli versatiles container (the build's final step)
export async function pack(zMbtiles: string[]): Promise<void> {
	await joinZooms(zMbtiles, file.tiles);
	await fs.rm(file.container, { force: true });
	await run('versatiles', 'convert', ['-c', 'brotli'], file.tiles, file.container);
}
