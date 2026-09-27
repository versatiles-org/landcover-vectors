// The PNG writer is ~30 lines of hand-rolled format code; a wrong CRC or filter byte makes an image that
// some viewers show and others reject. Decode what it writes, chunk by chunk.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';

import { encodePNG } from '../lib/png.ts';

// split a PNG into its chunks, checking every CRC on the way
function chunks(png: Buffer): { type: string; body: Buffer }[] {
	assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'signature');
	const out: { type: string; body: Buffer }[] = [];
	for (let at = 8; at < png.length;) {
		const len = png.readUInt32BE(at);
		const type = png.subarray(at + 4, at + 8).toString('ascii');
		const body = png.subarray(at + 8, at + 8 + len);
		assert.equal(png.readUInt32BE(at + 8 + len), crc32(png.subarray(at + 4, at + 8 + len)) >>> 0, `${type} CRC`);
		out.push({ type, body });
		at += 12 + len;
	}
	return out;
}

describe('encodePNG', () => {
	// 3×2 RGB: a red, green, blue row, then a white, black, grey row
	const data = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 128, 128, 128]);
	const png = encodePNG({ width: 3, height: 2, data });

	test('is IHDR, IDAT, IEND with valid CRCs', () => {
		assert.deepEqual(
			chunks(png).map((c) => c.type),
			['IHDR', 'IDAT', 'IEND'],
		);
	});

	test('declares 8-bit truecolour, no interlace', () => {
		const ihdr = chunks(png)[0].body;
		assert.equal(ihdr.readUInt32BE(0), 3);
		assert.equal(ihdr.readUInt32BE(4), 2);
		assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0]);
	});

	test('stores every row behind a "none" filter byte, pixels untouched', () => {
		const raw = inflateSync(chunks(png)[1].body);
		assert.equal(raw.length, (3 * 3 + 1) * 2);
		assert.equal(raw[0], 0);
		assert.equal(raw[10], 0);
		assert.deepEqual([...raw.subarray(1, 10)], [...data.subarray(0, 9)]);
		assert.deepEqual([...raw.subarray(11, 20)], [...data.subarray(9, 18)]);
	});

	test('refuses data that does not match the declared size', () => {
		assert.throws(() => encodePNG({ width: 3, height: 2, data: new Uint8Array(17) }), /expected 18/);
		assert.throws(() => encodePNG({ width: 0, height: 2, data: new Uint8Array(0) }), /bad image size/);
	});
});
