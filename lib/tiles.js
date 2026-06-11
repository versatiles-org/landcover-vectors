// enumerate the tiles actually present in an XYZ pyramid on disk
// the world-cover tile set is sparse (ocean has no data), so steps iterate the
// tiles that exist rather than the full 2^z × 2^z grid

import fs from 'node:fs/promises';
import path from 'node:path';

// list all { x, y } tiles present under <baseDir>/<z>/<x>/<y>.<ext>
export async function listZoomTiles(baseDir, z, ext = 'png') {
	const zDir = path.join(baseDir, String(z));
	const re = new RegExp(`^(\\d+)\\.${ext}$`);

	let xs;
	try {
		xs = await fs.readdir(zDir);
	} catch (err) {
		if (err.code === 'ENOENT') return [];
		throw err;
	}

	const tiles = [];
	for (const x of xs) {
		if (!/^\d+$/.test(x)) continue; // skip stray files (vrt, txt, …)
		let ys;
		try {
			ys = await fs.readdir(path.join(zDir, x));
		} catch (err) {
			if (err.code === 'ENOTDIR' || err.code === 'ENOENT') continue;
			throw err;
		}
		for (const y of ys) {
			const m = y.match(re);
			if (m) tiles.push({ x: Number(x), y: Number(m[1]) });
		}
	}
	return tiles;
}
