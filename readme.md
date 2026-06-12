# Versatiles Landcover Vectors

A set of vector tiles based on [ESA Worldcover](https://esa-worldcover.org/en/data-access).

There are to complement OSM tiles on lower zoom levels.

## Example

![Versatiles Landcover Vectors Example](doc/example.png)

## Requirements

- `node` (or `bun`)
- [`GDAL`](https://gdal.org/) ≥ 3.13 with `gdalbuildvrt`, `gdalwarp`, `gdal_calc.py`, `ogr2ogr` and the `gdal raster` / `gdal vector` subcommands `calc`, `reclassify`, `edit`, `sieve`, `polygonize` and `simplify-coverage` on `PATH`
- Python 3 with `numpy` (used by `gdal_calc.py` in the channels step; both ship with the GDAL install)
- [`libvips`](https://www.libvips.org/) (`vips`) for the Gaussian blur, or [`ImageMagick`](https://imagemagick.org/) 7 (`magick`) as a fallback (libvips is much faster on the gigapixel masks)
- [`tippecanoe`](https://github.com/felt/tippecanoe) (e.g. `brew install tippecanoe`)
- [`versatiles`](https://github.com/versatiles-org/versatiles-rs/blob/main/versatiles/README.md#install)

## How it's made

The pipeline renders one global Web Mercator raster, smooths each landcover class, and reads the smoothed
classes back as clean polygons. Each step can be run directly with `node`, or via its npm script (shown after
the `# or` line). To run the whole pipeline in order:

```sh
npm run build
```

(`download → reproject → channels → blur → argmax → polygonize → tile → pack`)

All steps read and write under `data/`. Each step writes its output to a file and is skipped/overwritten on
re-run, so the pipeline is resumable. This is a heavy run — a global one-gigapixel warp, ten gigapixel blurs
and a global coverage simplify — expect tens of minutes and several GB of scratch in `data/`.

### Download source data

```sh
node bin/download-worldcover.js
# or
npm run download
```

This downloads a reduced-resolution local mirror of [ESA WorldCover 2021 (v200)](https://registry.opendata.aws/esa-worldcover-vito/)
from AWS Open Data (`s3://esa-worldcover`). Each of the 2651 source GeoTIFFs is downsampled by a factor of 8 on the
way in (reading its matching internal overview, so only a small fraction of the full 10 m data is transferred) and
written to `data/esa-worldcover-src` in its native EPSG:4326. 1/8 (~74 m/px) keeps full detail for zoom 0–7 — so
the whole mirror is only a few hundred MB instead of the full ~124 GB.

Downloads run in parallel, are retried, written atomically, and skipped if already present — so the step is robust
against network errors and resumable (re-running continues where it left off).

> The old download step used the Terrascope WMTS service, which is no longer available — hence the move to the AWS
> Open Data mirror.

### Reproject

```sh
node bin/reproject-worldcover.js
# or
npm run reproject
```

This mosaics the source tiles (`gdalbuildvrt`) and reprojects them to a single global EPSG:3857 (Web Mercator)
raster of **32768×32768** pixels covering the standard Mercator square (±20037508.34 m ≈ ±85.0511°), written to
`data/worldcover-3857.tif`. 32768 = 2¹⁵ is exactly zoom-7 tile resolution, so the grid is tile-aligned and the
pixels are square. Resampling is `-r mode` (dominant class) — the only correct choice for categorical data —
and the single Byte band keeps the ESA class codes `{0,10,…,100}`. DEFLATE keeps the file small.

### Channels

```sh
node bin/channels-worldcover.js
# or
npm run channels
```

This splits the world raster into **10 per-class membership masks** in `data/channels` (`ch01…ch10.tif`), one
`gdal_calc.py` call each: a single Byte band that is 255 where the pixel belongs to that class and 0 elsewhere.
The ten classes partition the legend (moss merges into `bare`, mangroves into `wetland`), and the tenth channel
is "no data / no landcover" (ESA 0), so across all masks every pixel is 255 in exactly one channel.

### Blur

```sh
node bin/blur-worldcover.js
# or
npm run blur
```

This Gaussian-blurs each mask into `data/blurred` (`ch01…ch10.tif`). Blurring turns the hard masks into smooth fields so the
next step's per-pixel argmax yields **curved** class boundaries instead of the pixel staircase, while shared
borders stay exact (the masks still sum to a partition). GDAL has no Gaussian filter, so this uses
[`libvips`](https://www.libvips.org/) (`vips gaussblur`) when available — much faster on the gigapixel masks, as
it streams and works in 8-bit — and falls back to ImageMagick (`magick -blur`) otherwise. The blur is an
approximation either way; exactness doesn't matter, since the result only feeds an argmax. Both strip the GeoTIFF
georeferencing — intentional, the argmax step re-attaches it.

The blur radius is `BLUR_RADIUS` in `config.js` (σ = 4 px; at this resolution one pixel ≈ 1.2 km). libvips uses
its fastest `approximate` precision.

### Argmax

```sh
node bin/argmax-worldcover.js
# or
npm run argmax
```

This reduces the 10 blurred masks to a single-band **code raster** (`data/landcover-code.tif`): for every pixel,
the channel with the highest blurred value wins, and the pixel gets that channel's code (`10, 20, … 100`). It is
done with stock `gdal raster` commands, which stream block by block (no need to hold the ten gigapixel bands in
RAM): `gdal raster calc --dialect builtin --calc argmax` returns the 1-based index of the winning channel (ties
break toward the lowest index); `gdal raster sieve` merges regions smaller than a circle of the blur radius
(π·r² pixels) into their neighbour, dropping speckle below the scale the blur can resolve; `gdal raster
reclassify` maps index `1..10` → code `10..100`; and `gdal raster edit` re-attaches the EPSG:3857 georeferencing
that the blur stripped. Because the blurred masks form a smooth partition, the result is a clean coverage —
every pixel exactly one code, with curved shared borders.

### Polygonize

```sh
node bin/polygonize-worldcover.js
# or
npm run polygonize
```

This vectorizes the code raster into the final `data/landcover.fgb`. It is a **single global** vectorization (no
per-tile seams): polygonize with `gdal raster polygonize` (one polygon per connected code region, field `code`),
tag each polygon with its Shortbread `kind` and drop the no-data class, coverage-simplify to replace the residual
pixel staircase with straight lines (tolerance 2000 m, EPSG:3857), then reproject to EPSG:4326 for tippecanoe.

The simplification is **topology-preserving** (`gdal vector simplify-coverage`), so shared boundaries between
classes stay aligned — no slivers/gaps — and `--preserve-boundary` keeps the world edge exact.

### Tile

```sh
node bin/tile-worldcover.js
# or
npm run tile
```

This builds the vector tile pyramid from the polygon geometry with [tippecanoe](https://github.com/felt/tippecanoe),
writing `data/landcover.mbtiles`. tippecanoe simplifies the geometry per zoom level and tiles it seamlessly in one
pass. When a tile would exceed the MVT size limit — z0 is the whole world in a single tile — it keeps the **coverage
complete** by simplifying harder (`--simplification`, which mostly affects the low zooms) and merging the smallest
polygons into their neighbours (`--coalesce-smallest-as-needed`). Features are **never dropped**, which would leave
holes in the landcover.

By default only zoom level 6 is created; pass a single level or a range as parameter:

```sh
node bin/tile-worldcover.js 0-4
# or
npm run tile -- 0-4
```

### Convert to Versatiles container

```sh
versatiles convert -c brotli data/landcover.mbtiles landcover-vectors.versatiles
# or
npm run pack
```

This compresses and packs the tiles into a versatiles container.

## Style

There is one layer called `landcover-vectors` with a property `kind`. The `kind` values reuse the proposed
Shortbread [`landcover` layer](https://github.com/shortbread-tiles/shortbread-docs/issues/144) vocabulary, so a
style transitions seamlessly from these low-zoom tiles (z0–7) to OSM-based Shortbread tiles (z7+):

- `bare` Bare / sparse vegetation, moss and lichen
- `farmland` Cropland
- `forest` Tree cover
- `glacier` Snow and ice
- `grass` Grassland
- `scrub` Shrubland
- `urban` Built-up
- `water` Permanent water bodies
- `wetland` Herbaceous wetland, mangroves

These are derived from the ESA WorldCover classes as follows (several ESA classes are merged):

| ESA WorldCover class                      | `kind`     |
| ----------------------------------------- | ---------- |
| Tree cover                                | `forest`   |
| Shrubland                                 | `scrub`    |
| Grassland                                 | `grass`    |
| Cropland                                  | `farmland` |
| Built-up                                  | `urban`    |
| Bare / sparse vegetation, Moss and lichen | `bare`     |
| Snow and ice                              | `glacier`  |
| Permanent water bodies                    | `water`    |
| Herbaceous wetland, Mangroves             | `wetland`  |

### Example

```js
{
	"id": "landcover-forest",
	"type": "fill",
	"source-layer": "landcover-vectors",
	"source": "versatiles-landcover",
	"filter": [ "all", ["==", "kind", "forest"] ],
	"paint": {
		"fill-color": "#d6e6c3",
		"fill-opacity": { "stops": [[0, 0.2], [10, 0.2], [11, 0]] },
		"fill-antialias": true,
		"fill-outline-color": "#ffffff00"
	}
}
```

## License

- [ESA Worldcover](https://esa-worldcover.org/en/data-access) is licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
- The Versatiles Landcover Vectors tileset is derived from ESA Worldcover and therefore also licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
- The code in this repository is in the [Public Domain](http://unlicense.org/UNLICENSE)
