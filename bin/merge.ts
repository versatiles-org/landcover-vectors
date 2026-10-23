// Feature-merge the generated landcover container with an OSM-based Shortbread base.
//
// Downloads the latest OSM Shortbread container from download.versatiles.org (once, resumable;
// skipped if it already exists locally), then feature-merges it with the built landcover
// container via the VersaTiles `from_merged_vector` pipeline into data/combined.versatiles.
// The merged tileset has `land`/`water_polygons` populated continuously from z0 — see the
// README "Shortbread compatibility" section. The landcover container is built first by
// `npm run build`. Up to each kind's cutoff OSM's own features of that kind are dropped, and for a kind
// OSM maps better (`water`) the landcover's are dropped instead (lib/handover.ts), so each kind comes from
// one source per zoom and nothing double-draws.

import fs from 'node:fs/promises';

import { run, runCapture, requireCommands } from '../lib/worldcover.ts';
import { osmFilter, landcoverFilter, versionAtLeast, MIN_VERSATILES } from '../lib/handover.ts';
import { file, OSM_URL, SCHEMA } from '../config.ts';

const exists = (p: string): Promise<boolean> =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

// the remote size via a HEAD request, or null when the server doesn't say
async function contentLength(url: string): Promise<number | null> {
	const res = await fetch(url, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
	const len = res?.ok ? res.headers.get('content-length') : null;
	return len === null ? null : Number(len);
}

await requireCommands(['versatiles', 'curl']);
const versatilesVersion = (await runCapture('versatiles', '--version')).trim();
if (!versionAtLeast(versatilesVersion, MIN_VERSATILES))
	throw new Error(
		`${versatilesVersion || 'versatiles'} is too old — the merge filter needs versatiles ≥ ${MIN_VERSATILES} (older versions silently drop the whole land layer)`,
	);

// the landcover container is the build output — without it there is nothing to merge
if (!(await exists(file.container))) throw new Error(`missing ${file.container} — run "npm run build" first`);

// fetch the OSM base once (~66 GB); resume a partial download rather than restart it, and only
// promote the .part file to its final name after curl exits 0 so an interrupted download is
// never mistaken for a complete one
if (await exists(file.osm)) {
	console.error('OSM base present: %s', file.osm);
} else {
	const part = file.osm + '.part';
	// A `.part` that is already byte-complete (killed between the last byte and the rename) would make
	// `curl -C -` ask for a range past the end; the server answers 416 and `-f` turns that into a hard
	// failure — for good, on every later run. Promote such a file instead of re-requesting it.
	const partSize = await fs.stat(part).then(
		(s) => s.size,
		() => 0,
	);
	const remoteSize = partSize > 0 ? await contentLength(OSM_URL) : null;
	if (partSize > 0 && partSize === remoteSize) {
		console.error('Partial download is already complete (%d bytes) — promoting %s', partSize, part);
	} else {
		console.error('Downloading OSM base %s → %s (resumable) …', OSM_URL, file.osm);
		await run('curl', '-fL', ['--retry', 5], ['--retry-delay', 2], '-C', '-', ['-o', part], OSM_URL);
	}
	await fs.rename(part, file.osm);
}

// feature-merge: every output tile carries the features of both sources (from_merged_vector), minus each
// source's copies of the kinds the other supplies at that zoom (osmFilter / landcoverFilter, which need
// versatiles ≥ 4.15). The result is still Shortbread — only fuller — so it says so; from_merged_vector
// concatenates the two attributions by itself, which is what CC BY requires.
const filtered = (filename: string, filter: string): string =>
	`from_container filename="${filename}"` + (filter ? ` | ${filter}` : '');
const pipeline =
	`[,vpl](from_merged_vector [ ${filtered(file.osm, osmFilter())}, ${filtered(file.container, landcoverFilter())} ]` +
	` | meta_update schema="${SCHEMA}")`;

console.error('Merging → %s …', file.merged);
await fs.rm(file.merged, { force: true });
await run('versatiles', 'convert', ['-c', 'brotli'], pipeline, file.merged);
console.error('✓ merged: %s', file.merged);
