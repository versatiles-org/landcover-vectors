// The ocean mask: OSM's sea polygons, blanked out of every ESA window before it is classified.
//
// ESA classifies the sea inside its coastal 3° tiles as permanent water (class 80), so without a mask the
// container's `water` reaches out to the tile edge, and ESA's land runs past OSM's coastline wherever the two
// disagree. Shortbread's `ocean` layer is built from OSM's water polygons (OCEAN_URL), so burning those very
// polygons into the window as ESA's no-data (0) makes the land cover end where the OSM base's sea begins.
// Lakes are not in those polygons and stay; ESA sea inside OSM's land (a harbour, reclaimed coast) stays too.

import fs from 'node:fs/promises';
import path from 'node:path';

import { run, runQuiet, atomic } from './worldcover.ts';
import { dir, file, OCEAN_URL, type Rect } from '../config.ts';

const LAYER = 'ocean';

// fetch OSM's water polygons once (~930 MB) and convert them to a FlatGeobuf with a spatial index (~1.3 GB),
// which is what lets a block read only the few polygons that touch its window
export async function downloadOcean(): Promise<void> {
	const zip = path.join(dir.tmp, path.basename(OCEAN_URL));
	console.error('Downloading OSM water polygons %s …', OCEAN_URL);
	await fs.mkdir(dir.tmp, { recursive: true });
	await fs.rm(zip, { force: true }); // a few minutes to fetch again, so no resume logic for a leftover
	await run('curl', '-fL', ['--retry', 5], ['--retry-delay', 2], ['-o', zip], OCEAN_URL);
	const shp = `/vsizip/${zip}/${path.basename(OCEAN_URL, '.zip')}/water_polygons.shp`;
	console.error('Converting → %s …', file.ocean);
	await atomic(file.ocean, (out) =>
		run('ogr2ogr', ['-f', 'FlatGeobuf'], ['-nln', LAYER], ['-nlt', 'PROMOTE_TO_MULTI'], out, shp),
	);
	await fs.rm(zip, { force: true });
	console.error('✓ ocean mask ready: %s', file.ocean);
}

// Burn OSM's sea into `tif` (an EPSG:3857 Byte raster covering `extent` with `widthPx` columns) as no-data,
// in place. Two steps on purpose: gdal_rasterize straight from the full file costs ~1.5 GB of memory per call
// even when nothing touches the window, while clipping first with ogr2ogr (through the spatial index) keeps
// both under ~150 MB. The clip is simplified to half a raster pixel, which changes almost no pixel centre
// (0.002 % of the sea pixels of a z10 block) but turns a world-sized low-zoom window from minutes of
// rasterizing full-detail coastline into seconds. `scratch` is the caller's temp path for the clip.
export async function maskOcean(tif: string, extent: Rect, widthPx: number, scratch: string): Promise<void> {
	const tolerance = (extent.maxx - extent.minx) / widthPx / 2;
	await fs.rm(scratch, { force: true });
	await runQuiet(
		'ogr2ogr',
		['-spat', extent.minx, extent.miny, extent.maxx, extent.maxy],
		['-simplify', tolerance],
		['-f', 'FlatGeobuf'],
		['-lco', 'SPATIAL_INDEX=NO'], // read once, sequentially
		['-nln', LAYER],
		scratch,
		file.ocean,
		LAYER,
	);
	await runQuiet('gdal_rasterize', '-q', ['-burn', 0], ['-l', LAYER], scratch, tif);
}

// fail early, before a long run, when the mask is missing
export async function requireOcean(): Promise<void> {
	const ok = await fs.stat(file.ocean).then(
		() => true,
		() => false,
	);
	if (!ok)
		throw new Error(
			`missing ${file.ocean} — run "npm run download" (it keeps a source raster that is already there)`,
		);
}
