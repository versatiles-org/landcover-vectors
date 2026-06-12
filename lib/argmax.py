#!/usr/bin/env python3
# Per-pixel argmax over the blurred class masks → a single-band code raster.
#
# For every pixel, the channel (1..10) with the highest blurred value wins, and the
# output pixel gets that channel's code = (index + 1) * 10, i.e. 10..100. Because the
# blurred masks form a smooth partition, the result is a clean coverage (every pixel
# exactly one code) with curved, shared class borders.
#
# ImageMagick stripped the georeferencing from the blurred masks, so the geotransform
# and projection are copied from a reference raster (the reprojected world raster,
# identical grid). Processing is done in row blocks to stay within RAM: 10 byte bands
# × block_rows × width.
#
# Usage: argmax.py <ref_tif> <out_tif> <block_rows> <in1.tif> ... <inN.tif>
# Requires GDAL Python bindings (osgeo.gdal) and numpy.

import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

ref_path = sys.argv[1]
out_path = sys.argv[2]
block_rows = int(sys.argv[3])
in_paths = sys.argv[4:]

ref = gdal.Open(ref_path)
width = ref.RasterXSize
height = ref.RasterYSize

srcs = [gdal.Open(p) for p in in_paths]
for p, s in zip(in_paths, srcs):
    if s.RasterXSize != width or s.RasterYSize != height:
        raise SystemExit(f"size mismatch: {p} is {s.RasterXSize}×{s.RasterYSize}, expected {width}×{height}")

driver = gdal.GetDriverByName("GTiff")
out = driver.Create(
    out_path,
    width,
    height,
    1,
    gdal.GDT_Byte,
    options=["COMPRESS=DEFLATE", "TILED=YES", "BIGTIFF=YES"],
)
out.SetGeoTransform(ref.GetGeoTransform())
out.SetProjection(ref.GetProjection())
out_band = out.GetRasterBand(1)

bands = [s.GetRasterBand(1) for s in srcs]
n = len(bands)

for y in range(0, height, block_rows):
    rows = min(block_rows, height - y)
    # stack the n blurred masks for this row block → (n, rows, width)
    stack = np.empty((n, rows, width), dtype=np.uint8)
    for i, b in enumerate(bands):
        stack[i] = b.ReadAsArray(0, y, width, rows)
    # winning channel per pixel → code = (index + 1) * 10
    codes = ((np.argmax(stack, axis=0).astype(np.uint8) + 1) * 10).astype(np.uint8)
    out_band.WriteArray(codes, 0, y)
    sys.stderr.write(f"\rargmax {min(y + rows, height)}/{height} rows")
    sys.stderr.flush()

sys.stderr.write("\n")
out_band.FlushCache()
out = None
