// The file side of lib/outline.ts: a polygonized coverage in, the same with its outlines rounded out. ogr2ogr's text
// formats keep this free of a FlatGeobuf reader. A block's polygons are small enough to hold, but not every block's at
// once in one heap, so each block runs this file as a process of its own (roundCoverageProcess), on a core of its own.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { edgeMask, parseWkt, roundRing, type OutlineParams, type Point } from './outline.ts';
import { runQuiet } from './worldcover.ts';
import type { Rect } from '../config.ts';

// a dense block's vertices, as JS arrays
const HEAP_MB = 8192;

// roundCoverage in a process of its own
export async function roundCoverageProcess(
	input: string,
	output: string,
	w: Rect,
	px: { width: number; height: number },
	params: OutlineParams,
	scratch: string,
): Promise<void> {
	await runQuiet(
		process.execPath,
		`--max-old-space-size=${HEAP_MB}`,
		'--disable-warning=ExperimentalWarning',
		fileURLToPath(import.meta.url),
		JSON.stringify({ input, output, w, px, params, scratch }),
	);
}

type Row = { code: number; rings: Point[][] };

// `input`'s polygons, on the raster grid of window `w` with `px` pixels → `output`, via the scratch file `scratch`
export async function roundCoverage(
	input: string,
	output: string,
	w: Rect,
	px: { width: number; height: number },
	params: OutlineParams,
	scratch: string,
): Promise<void> {
	const [sx, sy] = [(w.maxx - w.minx) / px.width, (w.maxy - w.miny) / px.height];
	const rows: Row[] = [];
	const child = spawn(
		'ogr2ogr',
		['-f', 'CSV', '/vsistdout/', input, '-lco', 'GEOMETRY=AS_WKT', '-lco', 'CREATE_CSVT=NO'],
		{ stdio: ['ignore', 'pipe', 'inherit'] },
	);
	const exited = new Promise<void>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (c) => (c ? reject(new Error(`ogr2ogr exited with ${c} on ${input}`)) : resolve()));
	});
	let header = true;
	for await (const line of createInterface({ input: child.stdout })) {
		if (header) {
			header = false;
			continue;
		}
		// "POLYGON ((…))",code
		const end = line.lastIndexOf('"');
		const rings = parseWkt(line.slice(1, end)).map((r) =>
			r.map(([x, y]): Point => [Math.round((x - w.minx) / sx), Math.round((w.maxy - y) / sy)]),
		);
		rows.push({ code: Number(line.slice(end + 2)), rings });
	}
	await exited;

	const mask = edgeMask(
		rows.flatMap((r) => r.rings),
		px,
	);
	const out = createWriteStream(scratch);
	for (const { code, rings } of rows) {
		const coordinates = rings.map((r) =>
			roundRing(r, mask, px, params).map(([x, y]) => [w.minx + x * sx, w.maxy - y * sy]),
		);
		const line = JSON.stringify({
			type: 'Feature',
			properties: { code },
			geometry: { type: 'Polygon', coordinates },
		});
		if (!out.write(line + '\n')) await new Promise((r) => out.once('drain', r));
	}
	await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));

	await fs.rm(output, { force: true });
	await runQuiet(
		'ogr2ogr',
		['-f', 'FlatGeobuf'],
		['-a_srs', 'EPSG:3857'],
		['-lco', 'SPATIAL_INDEX=NO'],
		['-nln', 'data'],
		['-nlt', 'POLYGON'],
		output,
		scratch,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const a = JSON.parse(process.argv[2]);
	await roundCoverage(a.input, a.output, a.w, a.px, a.params, a.scratch);
}
