// Fingerprint the config values the cached artefacts depend on, so a cache built with other
// parameters is never silently reused.
//
// The per-block and per-zoom tilesets (dir.results, dir.tiles) are keyed on zoom + block position only — nothing in their names says which sieve or channel table produced them. A
// stamp file in the directory closes that gap: build compares it, refuses to mix, and names what
// changed. The source raster gets its own stamp because it is built for one specific FULL_PX.
//
// Deliberately NOT part of the fingerprint: paths, concurrency, and the per-channel `color` (styles
// are generated separately, so recolouring must not invalidate a 55-core-hour cache) or `meta`
// (name/attribution/description are stamped in at pack time, not baked into the block tilesets). Nor is the
// date of the ocean mask or of the land use: OSM's coastline moves by metres a year, its land use by little more
// at the zooms built here, which is not worth a rebuild.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	channels,
	MAXLEVEL,
	TILE_PX,
	BLOCK,
	SIEVE_THRESHOLD,
	SIEVE_STAGES,
	MARGIN_PX,
	TIPPECANOE_ARGS,
	FULL_PX,
	OCEAN_URL,
	OSM_BURNS,
	SEA_SHARE_MIN,
	simplifyForLevel,
} from '../config.ts';

export type Values = Record<string, unknown>;
export type Stamp = { fingerprint: string; written: string; values?: Values }; // values absent = hand-written stamp

const STAMP = '.fingerprint';

// everything that changes the per-block output
export function cacheValues(): Values {
	return {
		maxLevel: MAXLEVEL,
		tilePx: TILE_PX,
		block: BLOCK,
		sieveThreshold: SIEVE_THRESHOLD,
		sieveStages: SIEVE_STAGES, // the sieve's passes, in raw pixels
		marginPx: MARGIN_PX,
		tippecanoe: TIPPECANOE_ARGS, // each block tiles itself, and its tiles are cached (lib/assemble.ts)
		// what matters is the tolerance per zoom, not how it is written: sample the function
		simplify: Array.from({ length: MAXLEVEL + 1 }, (_, z) => simplifyForLevel(z)),
		channels: channels.map((c) => ({ esa: c.esa, layer: c.layer, kind: c.kind, maxZoom: c.maxZoom })),
		// which sea is masked out of every block, and how: the sea-share pyramid, thresholded (lib/ocean.ts)
		ocean: `${path.basename(OCEAN_URL, '.zip')}, sea share ≥ ${SEA_SHARE_MIN} %`,
		// OSM's land use burned into the classes the blocks read (lib/landburn.ts). Not its date, like the ocean's.
		burns: OSM_BURNS,
	};
}

// everything that changes the reprojected source raster (bin/download.ts)
export function sourceValues(): Values {
	return { fullPx: FULL_PX };
}

export function fingerprint(values: unknown): string {
	return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 8);
}

// `name` picks one of several stamps in a directory (the source dir stamps the raster and the sea share)
export async function readStamp(dirPath: string, name = STAMP): Promise<Stamp | null> {
	return fs
		.readFile(path.join(dirPath, name), 'utf8')
		.then((s) => JSON.parse(s) as Stamp)
		.catch(() => null);
}

export async function writeStamp(dirPath: string, values: Values, name = STAMP): Promise<string> {
	const stamp: Stamp = { fingerprint: fingerprint(values), written: new Date().toISOString(), values };
	await fs.mkdir(dirPath, { recursive: true });
	await fs.writeFile(path.join(dirPath, name), JSON.stringify(stamp, null, '\t') + '\n');
	return stamp.fingerprint;
}

// null when the stamp matches the given values, otherwise a human-readable list of what differs.
// Both the recorded fingerprint and the recorded values are compared, so a hand-edited or truncated
// stamp is reported rather than trusted.
export function stampMismatch(stamp: Stamp, values: Values): string | null {
	const now = fingerprint(values);
	// a long value (the channel table, the tolerance list) is useless truncated — summarise it instead
	const describe = (v: unknown): string => {
		if (v === undefined) return '(absent)';
		const s = JSON.stringify(v);
		if (s.length <= 60) return s;
		return `${Array.isArray(v) ? `${v.length} entries` : 'value'}, hash ${fingerprint(v)}`;
	};
	// a stamp without recorded values (hand-written, truncated) can only be compared by fingerprint
	const was = stamp.values;
	if (!was) return stamp.fingerprint === now ? null : `  (stamp lists no values) ${stamp.fingerprint} → ${now}`;
	const keys = [...new Set([...Object.keys(was), ...Object.keys(values)])];
	const lines = keys
		.filter((k) => JSON.stringify(was[k]) !== JSON.stringify(values[k]))
		.map((k) => `  ${k}: ${describe(was[k])} → ${describe(values[k])}`);
	if (stamp.fingerprint === now && lines.length === 0) return null;
	if (lines.length === 0) lines.push(`  fingerprint ${stamp.fingerprint} → ${now} (recorded values are identical)`);
	return lines.join('\n');
}
