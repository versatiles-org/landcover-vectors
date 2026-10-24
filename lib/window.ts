// Reading a block's window straight out of a pyramid raster: the source classes (lib/download.ts) and the sea
// share (lib/ocean.ts) are both built on the same grid (FULL_PX², EPSG:3857) with an overview per zoom. A block's
// grid always lines up with one of those levels (its inner edge is tile-aligned, its margin a whole number of
// pixels), so its window is a plain copy of a rectangle of that level: a VRT pointing at it, no warp, no
// resampling and no temporary raster. Measured against `gdalwarp -r mode` on blocks from z0 to z10, edge blocks
// included: identical pixels, in 0.2 s instead of 2.5–5 s.

import fs from 'node:fs/promises';
import path from 'node:path';

import { MERC, FULL_PX, type Rect } from '../config.ts';

// Where a window sits in a pyramid of `fullPx`² base pixels: the overview whose pixels are the window's (null =
// the base) and the window's offset in it, in whole pixels — a window off the grid is an error, not something to
// resample.
export function pyramidLevel(
	rect: Rect,
	width: number,
	height: number,
	fullPx = FULL_PX,
): { overview: number | null; xOff: number; yOff: number } {
	const base = (2 * MERC) / fullPx;
	const px = (rect.maxx - rect.minx) / width;
	const factor = px / base;
	const n = Math.round(Math.log2(factor));
	const whole = (v: number, what: string) => {
		const r = Math.round(v);
		if (Math.abs(v - r) > 1e-6) throw new Error(`window: its ${what} (${v}) is not on the pyramid's grid`);
		return r;
	};
	if (n < 0 || n > Math.log2(fullPx) || Math.abs(factor / 2 ** n - 1) > 1e-6)
		throw new Error(`window: no pyramid level has ${px} m pixels`);
	if (Math.abs((rect.maxy - rect.miny) / height / px - 1) > 1e-6) throw new Error('window: it has no square pixels');
	return {
		overview: n === 0 ? null : n - 1,
		xOff: whole((rect.minx + MERC) / px, 'x offset'),
		yOff: whole((MERC - rect.maxy) / px, 'y offset'),
	};
}

// Write a VRT at `out` that reads `rect` (width × height pixels) from the pyramid raster `src` at its own level.
// `nodata` marks the band's no-data value, as the source raster has (ESA's 0) and a reader's histogram expects.
export async function windowVrt(
	out: string,
	src: string,
	rect: Rect,
	width: number,
	height: number,
	opts: { fullPx?: number; nodata?: number } = {},
): Promise<void> {
	const { overview, xOff, yOff } = pyramidLevel(rect, width, height, opts.fullPx);
	const px = (rect.maxx - rect.minx) / width;
	const open = overview === null ? '' : `<OpenOptions><OOI key="OVERVIEW_LEVEL">${overview}</OOI></OpenOptions>`;
	const nodata = opts.nodata === undefined ? '' : `\n    <NoDataValue>${opts.nodata}</NoDataValue>`;
	await fs.writeFile(
		out,
		`<VRTDataset rasterXSize="${width}" rasterYSize="${height}">
  <SRS>EPSG:3857</SRS>
  <GeoTransform>${rect.minx}, ${px}, 0, ${rect.maxy}, 0, ${-px}</GeoTransform>
  <VRTRasterBand dataType="Byte" band="1">${nodata}
    <SimpleSource>
      <SourceFilename relativeToVRT="0">${path.resolve(src)}</SourceFilename>${open}
      <SourceBand>1</SourceBand>
      <SrcRect xOff="${xOff}" yOff="${yOff}" xSize="${width}" ySize="${height}"/>
      <DstRect xOff="0" yOff="0" xSize="${width}" ySize="${height}"/>
    </SimpleSource>
  </VRTRasterBand>
</VRTDataset>
`,
	);
}
