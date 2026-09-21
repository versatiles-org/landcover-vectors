// Tile statistics feed the decision "can we afford more detail?", so the arithmetic (percentiles, the
// mbtiles row->XYZ flip, per-zoom aggregation) has to be right — a wrong flip would point every probe
// at the mirror image of the area under test.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	percentile,
	budgetFlag,
	WARN_LIMIT,
	tileBounds,
	tileCenter,
	readTiles,
	summarise,
	largest,
	countVertices,
	clampToMercator,
	MVT_LIMIT,
	type TileRow,
} from '../lib/stats.ts';
import { LAT_LIMIT } from '../lib/areas.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// a minimal mbtiles: the schema tile-join writes, with blobs of the requested sizes.
// `tiles` are given in XYZ and stored flipped, exactly as a real tileset does.
async function fixture(tiles: { z: number; x: number; y: number; bytes: number }[]): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcv-stats-'));
	const file = path.join(dir, 'fixture.mbtiles');
	const db = new DatabaseSync(file);
	db.exec('CREATE TABLE metadata (name text, value text)');
	db.exec('CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)');
	const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
	for (const t of tiles) insert.run(t.z, t.x, Math.pow(2, t.z) - 1 - t.y, new Uint8Array(t.bytes));
	db.close();
	return file;
}

describe('the tile budget', () => {
	test('both limits are in bytes, and the soft one is half the hard one', () => {
		assert.equal(MVT_LIMIT, 500_000);
		assert.equal(WARN_LIMIT, 250_000);
	});

	test('budgetFlag marks at-or-over, with the soft threshold overridable', () => {
		assert.equal(budgetFlag(WARN_LIMIT - 1), '');
		assert.equal(budgetFlag(WARN_LIMIT), ' !');
		assert.equal(budgetFlag(MVT_LIMIT - 1), ' !');
		assert.equal(budgetFlag(MVT_LIMIT), ' !!');
		assert.equal(budgetFlag(1000, 1000), ' !');
		assert.equal(budgetFlag(999, 1000), '');
	});
});

describe('percentile', () => {
	test('nearest rank', () => {
		const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		assert.equal(percentile(ten, 50), 5);
		assert.equal(percentile(ten, 95), 10);
		assert.equal(percentile(ten, 100), 10);
		assert.equal(percentile(ten, 0), 1);
		assert.equal(percentile([42], 99), 42);
	});

	test('an empty distribution is zero, not NaN', () => {
		assert.equal(percentile([], 99), 0);
	});
});

describe('tileBounds', () => {
	test('z0 is the whole Mercator world', () => {
		const b = tileBounds(0, 0, 0);
		assert.equal(b.west, -180);
		assert.equal(b.east, 180);
		assert.ok(Math.abs(b.north - LAT_LIMIT) < 1e-9);
		assert.ok(Math.abs(b.south + LAT_LIMIT) < 1e-9);
	});

	test('y counts from the north', () => {
		assert.ok(tileBounds(1, 0, 0).north > 0, 'row 0 is the northern hemisphere');
		assert.ok(tileBounds(1, 0, 1).south < 0);
		assert.equal(tileBounds(1, 0, 0).south, 0);
	});

	test('neighbours are contiguous', () => {
		const z = 6;
		assert.equal(tileBounds(z, 10, 20).east, tileBounds(z, 11, 20).west);
		assert.equal(tileBounds(z, 10, 20).south, tileBounds(z, 10, 21).north);
	});

	test('matches the measured worst tile of the build', () => {
		const c = tileCenter(9, 129, 159); // the 60.5 KB Hudson Bay Lowlands tile
		assert.ok(Math.abs(c.lon + 88.95) < 0.01, `lon ${c.lon}`);
		assert.ok(Math.abs(c.lat - 55.97) < 0.01, `lat ${c.lat}`);
	});
});

describe('summarise', () => {
	const rows: TileRow[] = [
		{ z: 1, x: 0, y: 0, bytes: 100 },
		{ z: 1, x: 1, y: 0, bytes: 300 },
		{ z: 0, x: 0, y: 0, bytes: 50 },
		{ z: 1, x: 0, y: 1, bytes: 200 },
	];

	test('aggregates per zoom, ascending, with the worst tile named', () => {
		const [z0, z1] = summarise(rows);
		assert.equal(z0.z, 0);
		assert.equal(z0.tiles, 1);
		assert.equal(z1.z, 1);
		assert.equal(z1.tiles, 3);
		assert.equal(z1.bytes, 600);
		assert.equal(z1.avg, 200);
		assert.equal(z1.max, 300);
		assert.deepEqual(z1.worst, { z: 1, x: 1, y: 0, bytes: 300 });
		assert.equal(z1.p50, 200);
	});

	test('leaves out zooms with no tiles instead of inventing them', () => {
		assert.deepEqual(
			summarise(rows).map((z) => z.z),
			[0, 1],
		);
		assert.deepEqual(summarise([]), []);
	});

	test('largest returns the biggest first, capped', () => {
		assert.deepEqual(
			largest(rows, 2).map((r) => r.bytes),
			[300, 200],
		);
		assert.equal(largest(rows, 99).length, rows.length);
		assert.deepEqual(largest(rows, 0), []);
	});
});

describe('readTiles', () => {
	test('reads sizes and un-flips the mbtiles row order', async () => {
		const file = await fixture([
			{ z: 2, x: 1, y: 0, bytes: 10 }, // northern
			{ z: 2, x: 1, y: 3, bytes: 20 }, // southern
		]);
		try {
			const rows = readTiles(file).sort((a, b) => a.bytes - b.bytes);
			assert.deepEqual(rows, [
				{ z: 2, x: 1, y: 0, bytes: 10 },
				{ z: 2, x: 1, y: 3, bytes: 20 },
			]);
			// the y=0 tile must be the northern one, or every area probe would be mirrored
			assert.ok(tileBounds(2, rows[0].x, rows[0].y).north > 0);
			assert.ok(tileBounds(2, rows[1].x, rows[1].y).south < 0);
		} finally {
			await fs.rm(path.dirname(file), { recursive: true, force: true });
		}
	});

	test('a bbox keeps only the tiles that overlap it', async () => {
		const file = await fixture([
			{ z: 1, x: 0, y: 0, bytes: 11 }, // western
			{ z: 1, x: 1, y: 0, bytes: 22 }, // eastern
		]);
		try {
			const east = readTiles(file, { west: 10, south: 10, east: 20, north: 20 });
			assert.deepEqual(
				east.map((r) => r.bytes),
				[22],
			);
			assert.equal(readTiles(file, { west: -1, south: -1, east: 1, north: 1 }).length, 2, 'straddling both');
			assert.equal(readTiles(file, { west: 100, south: -80, east: 120, north: -70 }).length, 0, 'nothing there');
		} finally {
			await fs.rm(path.dirname(file), { recursive: true, force: true });
		}
	});
});

describe('countVertices', () => {
	test('counts coordinate pairs at any nesting depth', () => {
		assert.equal(countVertices({ type: 'Point', coordinates: [1, 2] }), 1);
		assert.equal(
			countVertices({
				type: 'LineString',
				coordinates: [
					[1, 2],
					[3, 4],
				],
			}),
			2,
		);
		assert.equal(
			countVertices({
				type: 'Polygon',
				coordinates: [
					[
						[0, 0],
						[1, 0],
						[1, 1],
						[0, 0],
					],
					[
						[0, 0],
						[1, 0],
						[0, 0],
					],
				],
			}),
			7,
		);
		assert.equal(
			countVertices({
				type: 'MultiPolygon',
				coordinates: [
					[
						[
							[0, 0],
							[1, 0],
							[0, 0],
						],
					],
					[
						[
							[0, 0],
							[1, 0],
							[0, 0],
						],
					],
				],
			}),
			6,
		);
	});

	test('a missing or empty geometry counts as nothing', () => {
		assert.equal(countVertices(undefined), 0);
		assert.equal(countVertices({ type: 'Polygon', coordinates: [] }), 0);
	});
});

describe('clampToMercator', () => {
	test('trims latitudes tiles cannot exist at, leaving longitudes alone', () => {
		const c = clampToMercator({ west: -10, south: -90, east: 10, north: 90 });
		assert.equal(c.west, -10);
		assert.equal(c.east, 10);
		assert.equal(c.north, LAT_LIMIT);
		assert.equal(c.south, -LAT_LIMIT);
	});
});

describe('bin/stats.ts', () => {
	const run = (file: string, args: string[] = []) =>
		spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bin/stats.ts', '--input', file, ...args], {
			cwd: root,
			encoding: 'utf8',
		});

	test('reports a tileset within budget and exits 0', async () => {
		const file = await fixture([
			{ z: 0, x: 0, y: 0, bytes: 1000 },
			{ z: 1, x: 1, y: 1, bytes: 2000 },
		]);
		try {
			const { status, stderr } = run(file);
			assert.equal(status, 0, stderr);
			assert.match(stderr, /2 tiles/);
			assert.match(stderr, /0 tile\(s\) at or over 250000 bytes \(soft\), 0 at or over 500000 bytes/);
		} finally {
			await fs.rm(path.dirname(file), { recursive: true, force: true });
		}
	});

	test('fails when a tile reaches the MVT limit, so a build can be gated on it', async () => {
		const file = await fixture([{ z: 5, x: 3, y: 4, bytes: MVT_LIMIT + 1 }]);
		try {
			const { status, stderr } = run(file);
			assert.equal(status, 1, stderr);
			assert.match(stderr, /1 tile\(s\) at or over 500000 bytes/);
		} finally {
			await fs.rm(path.dirname(file), { recursive: true, force: true });
		}
	});

	test('the table marks and the budget count use one and the same soft threshold', async () => {
		// one tile a byte under the default soft budget, one exactly at it
		const file = await fixture([
			{ z: 3, x: 1, y: 1, bytes: WARN_LIMIT - 1 },
			{ z: 4, x: 1, y: 1, bytes: WARN_LIMIT },
		]);
		try {
			const def = run(file);
			assert.equal(def.status, 0, def.stderr);
			assert.match(def.stderr, /1 tile\(s\) at or over 250000 bytes \(soft\)/);
			assert.equal((def.stderr.match(/ !(?!!)/g) ?? []).length, 1, 'exactly the at-limit tile is marked');

			// --warn is in bytes now; lowering it must move the count and the marks together
			const low = run(file, ['--warn', '1000']);
			assert.match(low.stderr, /2 tile\(s\) at or over 1000 bytes \(soft\)/);
			assert.equal((low.stderr.match(/ !(?!!)/g) ?? []).length, 2);
		} finally {
			await fs.rm(path.dirname(file), { recursive: true, force: true });
		}
	});

	test('a --warn that is not a byte count is refused', async () => {
		const file = await fixture([{ z: 0, x: 0, y: 0, bytes: 10 }]);
		try {
			const { status, stderr } = run(file, ['--warn', '250KB']);
			assert.equal(status, 1);
			assert.match(stderr, /bad --warn "250KB" — expected bytes/);
		} finally {
			await fs.rm(path.dirname(file), { recursive: true, force: true });
		}
	});

	test('an unknown area fails before reading anything', async () => {
		const file = await fixture([{ z: 0, x: 0, y: 0, bytes: 10 }]);
		try {
			const { status, stderr } = run(file, ['--area', 'atlantis']);
			assert.equal(status, 1);
			assert.match(stderr, /unknown area/);
		} finally {
			await fs.rm(path.dirname(file), { recursive: true, force: true });
		}
	});
});

describe('bin/preview.ts argument handling', () => {
	// only the paths that exit before any build: a real preview build needs the 23 GB source raster
	const run = (args: string[]) =>
		spawnSync(process.execPath, ['bin/preview.ts', ...args], { cwd: root, encoding: 'utf8' });

	test('--help lists the presets and exits 0', () => {
		const { status, stderr } = run(['--help']);
		assert.equal(status, 0);
		assert.match(stderr, /--area <name\|w,s,e,n>/);
		assert.match(stderr, /hudson-bay/);
	});

	test('a bad zoom range fails before touching anything', () => {
		const { status, stderr } = run(['--zoom', '99']);
		assert.equal(status, 1);
		assert.match(stderr, /only builds up to z/);
	});

	test('an unknown area fails before touching anything', () => {
		const { status, stderr } = run(['--area', 'atlantis']);
		assert.equal(status, 1);
		assert.match(stderr, /unknown area/);
	});
});
