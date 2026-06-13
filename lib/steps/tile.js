// Step 7 — build the single-zoom tileset for the level → data/6_tile/{level}_landcover.mbtiles.
//
// One zoom per call (the pack step merges them). Oversized tiles stay coverage-complete by
// merging the smallest polygons (--coalesce-smallest-as-needed) rather than dropping features.
// Skip if the tileset already exists.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { run } from '../worldcover.js';
import { dir, datadir, geometryPath, tilesPath, meta } from '../../config.js';

export async function tile(level) {
	const out = tilesPath(level);
	const geom = geometryPath(level);
	if (!existsSync(geom)) throw new Error(`missing ${geom} — run the polygonize step first`);
	if (existsSync(out)) return console.error('z%d tile: cached', level);
	await fs.mkdir(dir.tile, { recursive: true });

	// keep tippecanoe's multi-GB feature store on the data disk, not a RAM-backed /tmp
	const tmpdir = path.join(datadir, 'tippecanoe-tmp');
	await fs.mkdir(tmpdir, { recursive: true });

	console.error('Tiling zoom %d → %s', level, out);
	await run('tippecanoe', [
		'-o',
		out,
		'--force',
		'--temporary-directory',
		tmpdir,
		'--minimum-zoom',
		String(level),
		'--maximum-zoom',
		String(level),
		'--layer',
		meta.layer,
		'--attribute-type',
		'kind:string',
		'--include',
		'kind',
		'--name',
		meta.name,
		'--attribution',
		meta.attribution,
		'--description',
		meta.description,
		geom,
	]);
}
