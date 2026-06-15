// Skip-empty support: the set of 3° cells the ESA WorldCover source actually covers.
//
// ESA only ships 3°×3° tiles where land exists (open ocean has no tile), named by their
// SW corner, e.g. "ESA_WorldCover_10m_2021_v200_N51E009_Map.tif" → 51..54°N, 9..12°E. The
// download step records the remote tile list (file.sourceList); a block whose bbox intersects
// no occupied cell has no source data and can be skipped (it would only have produced dropped
// no-data). The test is conservative — it never skips a block that overlaps an occupied cell
// — so it can't create wrong holes.

import fs from 'node:fs/promises';

import { file } from '../config.ts';

const CELL = 3; // degrees per ESA tile

const keyOf = (latCell: number, lonCell: number) => `${latCell},${lonCell}`;
const cellOf = (deg: number) => Math.floor(deg / CELL) * CELL;

function parseCorner(name: string): { lat: number; lon: number } | null {
	const m = name.match(/([NS])(\d{2})([EW])(\d{3})/);
	if (!m) return null;
	return {
		lat: (m[1] === 'S' ? -1 : 1) * Number(m[2]),
		lon: (m[3] === 'W' ? -1 : 1) * Number(m[4]),
	};
}

export type LonLat = { west: number; south: number; east: number; north: number };
export type Coverage = { isEmpty: (b: LonLat) => boolean; cells: number };

// build the occupied-3°-cell set from the recorded source tile list (one cell per source tile)
export async function buildCoverage(): Promise<Coverage> {
	const text = await fs.readFile(file.sourceList, 'utf8').catch(() => '');
	const occupied = new Set<string>();
	for (const line of text.split('\n')) {
		const c = parseCorner(line);
		if (c) occupied.add(keyOf(c.lat, c.lon)); // SW corner is already on the 3° grid
	}
	if (occupied.size === 0)
		throw new Error(`no source tiles listed in ${file.sourceList} — run "npm run download" first`);
	return {
		cells: occupied.size,
		isEmpty(b) {
			for (let lat = cellOf(b.south); lat < b.north; lat += CELL) {
				for (let lon = cellOf(b.west); lon < b.east; lon += CELL) {
					if (occupied.has(keyOf(lat, lon))) return false;
				}
			}
			return true;
		},
	};
}
