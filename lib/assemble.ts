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
import { dir, file, meta } from '../config.ts';

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
	await runQuiet('ogr2ogr', ['-f', 'FlatGeobuf'], ['-nln', layerName], out, vrt);
	await fs.rm(vrt, { force: true });
	return true;
}

// tile one zoom: merge all block fragments per layer, then one tippecanoe run → z{z}.mbtiles
export async function tileZoom(z: number, fragments: BlockFragments[]): Promise<string | null> {
	const land = fragments.map((f) => f.land).filter((f): f is string => !!f);
	const water = fragments.map((f) => f.water).filter((f): f is string => !!f);
	if (land.length === 0 && water.length === 0) return null;

	const landFgb = path.join(dir.tmp, `z${z}_land.fgb`);
	const waterFgb = path.join(dir.tmp, `z${z}_water.fgb`);
	const hasLand = await mergeLayer(land, 'land', landFgb);
	const hasWater = await mergeLayer(water, 'water_polygons', waterFgb);

	// cached per-zoom tileset; written atomically (temp → rename) so its presence means "done"
	const out = path.join(dir.tiles, `z${z}.mbtiles`);
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
	return out;
}

// merge the per-zoom tilesets (disjoint zooms) and pack into a brotli versatiles container
export async function pack(zMbtiles: string[]): Promise<void> {
	await fs.rm(file.tiles, { force: true });
	await run(
		'tile-join',
		'-f',
		['--name', meta.name],
		['--attribution', meta.attribution],
		['--description', meta.description],
		['-o', file.tiles],
		zMbtiles,
	);
	await fs.rm(file.container, { force: true });
	await run('versatiles', 'convert', ['-c', 'brotli'], file.tiles, file.container);
}
