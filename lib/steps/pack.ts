// Step 8 — merge the per-level tilesets and pack them into a brotli versatiles container.
//
// tile-join concatenates the single-zoom mbtiles (z0..MAXLEVEL) into one pyramid
// (data/landcover.mbtiles), which versatiles then compresses into the repo-root container.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { run } from '../worldcover.ts';
import { datadir, file, MAXLEVEL, tilesPath, meta } from '../../config.ts';

export async function pack(): Promise<void> {
	const inputs: string[] = [];
	for (let z = 0; z <= MAXLEVEL; z++) {
		const p = tilesPath(z);
		if (!existsSync(p)) throw new Error(`missing ${p} — run the build (tile step) for every level first`);
		inputs.push(p);
	}

	console.error('Merging %d per-level tilesets → %s', inputs.length, file.tiles);
	await run('tile-join', [
		'-f',
		'--name',
		meta.name,
		'--attribution',
		meta.attribution,
		'--description',
		meta.description,
		'-o',
		file.tiles,
		...inputs,
	]);

	const out = path.join(path.dirname(datadir), 'landcover-vectors.versatiles');
	console.error('Packing → %s', out);
	await run('versatiles', ['convert', '-c', 'brotli', file.tiles, out]);
}
