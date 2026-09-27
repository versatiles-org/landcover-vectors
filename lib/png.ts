// A minimal PNG writer: 8-bit RGB, no interlace, no filtering. Enough for the inspect panels without an
// image library — node:zlib provides both the deflate and the CRC-32 the format needs.

import { deflateSync, crc32 } from 'node:zlib';

export type RGBImage = { width: number; height: number; data: Uint8Array }; // RGB triplets, row-major

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function encodePNG(img: RGBImage): Buffer {
	const { width, height, data } = img;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new Error(`bad image size ${width}×${height}`);
	}
	if (data.length !== width * height * 3)
		throw new Error(`RGB data is ${data.length} bytes, expected ${width * height * 3}`);

	// every scanline is prefixed with its filter type; 0 = none
	const stride = width * 3;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);

	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // colour type: truecolour RGB
	// compression, filter and interlace methods: all 0

	return Buffer.concat([
		SIGNATURE,
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function chunk(type: string, body: Buffer): Buffer {
	const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
	const out = Buffer.alloc(8 + body.length + 4);
	out.writeUInt32BE(body.length, 0);
	typeAndBody.copy(out, 4);
	out.writeUInt32BE(crc32(typeAndBody) >>> 0, 8 + body.length);
	return out;
}
