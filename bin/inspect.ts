// Inspect one tile's quality: compare it pixel by pixel with what it should show.
//
//   npm run inspect -- 9/129/159                          # the production tileset
//   npm run inspect -- 9/129/159 --preview hudson-bay     # every preview variant built for that area
//   npm run inspect -- 9/129/159 --input a.mbtiles --input b.mbtiles
//
// Prints, per input: the area share of each class against the target, how much of each target class
// survived (recall), overall pixel agreement, where the errors are (wrong kind / gap / overdraw), and the
// tile's bytes, features and vertices — so quality and size can be read side by side. Writes a PNG with
// the source, the target, and each input's tile next to a map of its errors. See lib/inspect.ts for what
// "target" means.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { AREAS, areaSlug } from '../lib/areas.ts';
import { readStamp } from '../lib/fingerprint.ts';
import { tileCenter } from '../lib/stats.ts';
import { encodePNG } from '../lib/png.ts';
import {
	renderSource,
	renderTile,
	targetFor,
	compare,
	colorize,
	errorMap,
	resize,
	grid,
	activeCodes,
	className,
	majority,
	ERROR_COLORS,
	type Comparison,
	type Rendered,
} from '../lib/inspect.ts';
import { requireCommands } from '../lib/worldcover.ts';
import { channels, datadir, file, MAXLEVEL, TILE_PX } from '../config.ts';

const { values: opt, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		input: { type: 'string', multiple: true },
		preview: { type: 'string' },
		px: { type: 'string', default: '512' },
		out: { type: 'string' },
		json: { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
});

if (opt.help || positionals.length !== 1) {
	console.error(
		[
			'Usage: npm run inspect -- <z/x/y> [options]',
			'  --preview <area>   every preview variant built for that area (presets: ' +
				Object.keys(AREAS).join(', ') +
				')',
			'  --input <mbtiles>  a tileset to inspect; repeat to compare several (default: data/landcover.mbtiles)',
			'  --px <n>           panel size in the PNG (default 512; the metrics always use TILE_PX)',
			'  --out <png>        where to write the image (default data/inspect/<z>_<x>_<y>.png)',
			'  --json             machine-readable metrics on stdout',
		].join('\n'),
	);
	process.exit(opt.help ? 0 : 1);
}

// ---------------------------------------------------------------- the tile
const m = positionals[0].match(/^(\d+)\/(\d+)\/(\d+)$/);
if (!m) throw new Error(`bad tile "${positionals[0]}" — expected z/x/y, e.g. 9/129/159`);
const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
if (z > MAXLEVEL) throw new Error(`z${z} is above this config's MAXLEVEL (${MAXLEVEL})`);
if (x >= 2 ** z || y >= 2 ** z) throw new Error(`tile ${z}/${x}/${y} does not exist — x and y must be below ${2 ** z}`);
const panelPx = Number(opt.px);
if (!Number.isInteger(panelPx) || panelPx < 16) throw new Error(`bad --px "${opt.px}"`);

// ---------------------------------------------------------------- the inputs
type Input = { path: string; label: string };

async function previewInputs(area: string): Promise<string[]> {
	const root = path.join(datadir, 'preview');
	const prefix = `preview-${areaSlug(area)}-z`;
	const dirs = await fs.readdir(root).catch(() => [] as string[]);
	const found: string[] = [];
	for (const d of dirs.sort()) {
		const names = await fs.readdir(path.join(root, d)).catch(() => [] as string[]);
		for (const n of names) if (n.startsWith(prefix) && n.endsWith('.mbtiles')) found.push(path.join(root, d, n));
	}
	return found;
}

// a variant is best named by the parameters it was built with, which its directory's stamp records
async function labelFor(tileset: string): Promise<string> {
	const stamp = await readStamp(path.dirname(tileset));
	const v = stamp?.values as { blurRadius?: number; sieveThreshold?: number; simplify?: number[] } | undefined;
	if (!stamp || !v) return path.basename(tileset);
	const tol = v.simplify?.[z];
	return (
		`${stamp.fingerprint}  σ ${v.blurRadius} px · sieve ${v.sieveThreshold} px` +
		(tol === undefined ? '' : ` · tolerance ${tol.toFixed(0)} m`)
	);
}

const paths = [
	...(opt.input ?? []).map((p) => path.resolve(p)),
	...(opt.preview ? await previewInputs(opt.preview) : []),
];
if (paths.length === 0) paths.push(file.tiles);

function tileBytes(mbtiles: string): number | null {
	const db = new DatabaseSync(mbtiles, { readOnly: true });
	try {
		const row = db
			.prepare('SELECT LENGTH(tile_data) AS n FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?')
			.get(z, x, 2 ** z - 1 - y) as { n: number } | undefined;
		return row ? Number(row.n) : null;
	} finally {
		db.close();
	}
}

const inputs: (Input & { bytes: number })[] = [];
for (const p of paths) {
	if (
		!(await fs.stat(p).then(
			() => true,
			() => false,
		))
	)
		throw new Error(`no tileset at ${p}`);
	const bytes = tileBytes(p);
	if (bytes === null) {
		console.error('(skipping %s — it has no tile %d/%d/%d)', path.relative(process.cwd(), p), z, x, y);
		continue;
	}
	inputs.push({ path: p, label: await labelFor(p), bytes });
}
if (inputs.length === 0) throw new Error(`none of the inputs contains tile ${z}/${x}/${y}`);

// ---------------------------------------------------------------- render and compare
await requireCommands(['gdalwarp', 'gdal_translate', 'gdal_rasterize', 'tippecanoe-decode']);
if (
	!(await fs.stat(file.source).then(
		() => true,
		() => false,
	))
) {
	throw new Error(`missing ${file.source} — the target is rendered from the source raster; run "npm run download"`);
}

const source = await renderSource(file.source, z, x, y);
const target = targetFor(source, z);
// the scale the simplify tolerance is calibrated to: one pixel of a 256-px tile
const COARSE = TILE_PX / 256;
const coarseTarget = majority(target, TILE_PX, COARSE);
const results: { input: (typeof inputs)[number]; rendered: Rendered; cmp: Comparison; coarse: Comparison }[] = [];
for (const input of inputs) {
	const rendered = await renderTile(input.path, z, x, y);
	results.push({
		input,
		rendered,
		cmp: compare(target, rendered.codes),
		coarse: compare(coarseTarget, majority(rendered.codes, TILE_PX, COARSE)),
	});
}

// ---------------------------------------------------------------- report
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)} %`);
const letters = results.map((_, i) => String.fromCharCode(65 + i));
const c = tileCenter(z, x, y);
const holes = channels.filter((ch) => ch.kind && !ch.esa.some((code) => activeCodes(z).has(code))).map((ch) => ch.kind);

if (opt.json) {
	console.log(
		JSON.stringify(
			{
				tile: { z, x, y },
				px: TILE_PX,
				inputs: results.map((r) => ({
					path: r.input.path,
					label: r.input.label,
					bytes: r.input.bytes,
					features: r.rendered.features,
					vertices: r.rendered.vertices,
					...r.cmp,
					coarse: { px: TILE_PX / COARSE, agreement: r.coarse.agreement, areaError: r.coarse.areaError },
				})),
			},
			null,
			'\t',
		),
	);
} else {
	console.error(
		'tile %d/%d/%d — lon %s lat %s · #%d/%s/%s in the preview viewer',
		z,
		x,
		y,
		c.lon.toFixed(2),
		c.lat.toFixed(2),
		z,
		c.lat.toFixed(4),
		c.lon.toFixed(4),
	);
	console.error(
		'target: the source at %d×%d px (TILE_PX, read with -r mode like a block), holes where z%d draws nothing%s',
		TILE_PX,
		TILE_PX,
		z,
		holes.length ? ` (${holes.join(', ')})` : '',
	);

	const row = (name: string, cells: string[]) =>
		console.error('  ' + name.padEnd(30) + cells.map((s) => s.padStart(10)).join(''));
	const codes = [...new Set([...results.flatMap((r) => r.cmp.classes.map((k) => k.code))])];
	const targetShare = (code: number) => results[0].cmp.classes.find((k) => k.code === code)?.target ?? 0;
	codes.sort((a, b) => targetShare(b) - targetShare(a));
	const cell = (r: (typeof results)[number], code: number, key: 'rendered' | 'recall') => {
		const k = r.cmp.classes.find((kk) => kk.code === code);
		return pct(k ? k[key] : key === 'rendered' ? 0 : null);
	};

	console.error('');
	row('area share', ['target', ...letters]);
	for (const code of codes)
		row(className(code), [pct(targetShare(code)), ...results.map((r) => cell(r, code, 'rendered'))]);

	console.error('');
	row('kept (recall)', ['', ...letters]);
	for (const code of codes.filter((cc) => targetShare(cc) > 0))
		row(className(code), ['', ...results.map((r) => cell(r, code, 'recall'))]);

	console.error('');
	row(`pixel agreement @${TILE_PX}`, ['', ...results.map((r) => pct(r.cmp.agreement))]);
	row(`  @${TILE_PX / COARSE} (${COARSE}×${COARSE} majority)`, ['', ...results.map((r) => pct(r.coarse.agreement))]);
	row('area on the wrong class', ['', ...results.map((r) => pct(r.cmp.areaError))]);
	row('wrong kind', ['', ...results.map((r) => pct(r.cmp.wrongKind))]);
	row('gap (hole, target land)', ['', ...results.map((r) => pct(r.cmp.gap))]);
	row('overdraw (land, target hole)', ['', ...results.map((r) => pct(r.cmp.overdraw))]);
	row('tile KB', ['', ...results.map((r) => (r.input.bytes / 1024).toFixed(1))]);
	row('features', ['', ...results.map((r) => String(r.rendered.features))]);
	row('vertices', ['', ...results.map((r) => String(r.rendered.vertices))]);

	console.error('');
	results.forEach((r, i) => {
		console.error('  %s = %s', letters[i], r.input.label);
		console.error('      %s', path.relative(process.cwd(), r.input.path));
		if (r.rendered.unknownKinds.length)
			console.error('      ! kinds this config does not know: %s', r.rendered.unknownKinds.join(', '));
	});
}

// ---------------------------------------------------------------- image
const panels = [colorize(source, TILE_PX), colorize(target, TILE_PX)];
for (const r of results) panels.push(colorize(r.rendered.codes, TILE_PX), errorMap(target, r.rendered.codes, TILE_PX));
const image = grid(
	panels.map((p) => resize(p, panelPx)),
	2,
);
const out = opt.out ? path.resolve(opt.out) : path.join(datadir, 'inspect', `${z}_${x}_${y}.png`);
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, encodePNG(image));

if (!opt.json) {
	const rgb = (k: keyof typeof ERROR_COLORS) => `rgb(${ERROR_COLORS[k].join(',')})`;
	console.error('\nimage: %s', path.relative(process.cwd(), out));
	console.error('  row 1: source (all classes) | target;  then per input (%s): tile | errors', letters.join(', '));
	console.error(
		'  errors: %s right · %s wrong kind · %s gap · %s overdraw',
		`grey ${rgb('right')}`,
		`red ${rgb('wrongKind')}`,
		`blue ${rgb('gap')}`,
		`magenta ${rgb('overdraw')}`,
	);
}
