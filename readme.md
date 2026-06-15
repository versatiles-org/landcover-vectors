# Versatiles Landcover Vectors

A set of vector tiles based on [ESA Worldcover](https://esa-worldcover.org/en/data-access).

They complement OSM-based [Shortbread](https://shortbread-tiles.org/) tiles at low and mid zoom levels — see
[Shortbread compatibility](#shortbread-compatibility) below.

## Example

![Versatiles Landcover Vectors Example](doc/example.png)

## Requirements

- `node` (or `bun`)
- [`GDAL`](https://gdal.org/) ≥ 3.13 with `gdalbuildvrt`, `gdalwarp`, `gdal_calc.py`, `ogr2ogr` and the `gdal raster` / `gdal vector` subcommands `calc`, `reclassify`, `edit`, `sieve`, `polygonize` and `simplify-coverage` on `PATH`
- Python 3 with `numpy` (used by `gdal_calc.py` in the channels step; both ship with the GDAL install)
- [`libvips`](https://www.libvips.org/) (`vips`) — used for the Gaussian blur
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
[`libvips`](https://www.libvips.org/) (`vips gaussblur`) — fast on the gigapixel masks, as it streams and works
in 8-bit. The blur is an approximation; exactness doesn't matter, since the result only feeds an argmax. vips
strips the GeoTIFF georeferencing — intentional, the argmax step re-attaches it.

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

## Shortbread compatibility

The tileset has a single layer, **`land_cover`**, with one string attribute **`kind`**. It is designed as a
**complementary extension** to the [Shortbread](https://shortbread-tiles.org/) schema — not a replacement for
any existing Shortbread layer.

Shortbread's landcover/water layers (`land`, `water_polygons`) are OSM-derived: **sparse** (only what people
mapped) and **high-zoom** (`land` starts at z7, `water_polygons` at z4). `land_cover` is a different kind of
data — a **complete, generalized landcover classification from global satellite imagery** (ESA WorldCover):
wall-to-wall (every pixel is exactly one class) and available from **z0**. It fills the low/mid-zoom range
where the OSM-based layers are structurally sparse or absent — the way Natural Earth underlies OSM in many
basemaps. It is not a patch for those layers; it is a separate base tier from a different source (ESA, CC BY).

**Composition.** Render `land_cover` as the landcover base, and let the OSM-based Shortbread layers override it
with authoritative detail where they exist:

- `ocean` — the sea, all zooms (ESA leaves open ocean as no-data, so `land_cover` has holes there for `ocean` to fill)
- `water_polygons` — inland water and glaciers, z4+
- `land` — detailed landuse/natural polygons, z7+

A typical style fades `land_cover` out (or lets the OSM layers paint on top) as you cross into those zooms.

### `kind` values

The values reuse Shortbread's `land` / `water_polygons` vocabulary wherever an equivalent exists, so a single
style can paint both schemas by `kind` and the colours stay continuous across the zoom transition:

| `land_cover.kind` | ESA WorldCover class                    | Shortbread equivalent                                          |
|-------------------|-----------------------------------------|----------------------------------------------------------------|
| `forest`          | Tree cover                              | `land.kind=forest` (z7+)                                       |
| `scrub`           | Shrubland                               | `land.kind=scrub` (z11+)                                       |
| `grassland`       | Grassland                               | `land.kind=grassland` (z11+)                                   |
| `farmland`        | Cropland                                | `land.kind=farmland` (z10+)                                    |
| `glacier`         | Snow and ice                            | `water_polygons.kind=glacier` (z4+)                            |
| `water`           | Permanent water bodies                  | `water_polygons.kind=water` (z4+)                              |
| `urban`           | Built-up                                | _new_ — generalizes `land` residential/industrial/commercial/… |
| `bare`            | Bare / sparse vegetation, moss & lichen | _new_ — generalizes `land` bare_rock/scree/shingle/sand        |
| `wetland`         | Herbaceous wetland, mangroves           | _new_ — generalizes `land` swamp/bog/marsh/wet_meadow          |

Six of the nine values reuse existing Shortbread vocabulary (four from `land`, two from `water_polygons`);
`urban`, `bare` and `wetland` are this extension's **generalized low-zoom additions** (single coarse classes
standing in for many fine-grained OSM values). ESA's "no data / no landcover" (open ocean, unclassified) is
dropped before tiling.

> **z4–z7 overlap.** Above z4 both `land_cover` and Shortbread `water_polygons` carry `water`/`glacier`. There a
> style should prefer the crisp OSM `water_polygons`; `land_cover` only carries them so the low zooms (z0–3),
> where Shortbread has no water source at all, stay complete.

### Example (MapLibre / Mapbox GL style layer)

```js
{
	"id": "land_cover-forest",
	"type": "fill",
	"source": "versatiles-landcover",
	"source-layer": "land_cover",
	"filter": ["==", "kind", "forest"],
	"paint": {
		"fill-color": "#66AA44",
		"fill-antialias": false,
		// fade out as the detailed OSM `land` layer takes over
		"fill-opacity": { "stops": [[6, 1], [8, 0]] }
	}
}
```

## License

- [ESA Worldcover](https://esa-worldcover.org/en/data-access) is licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
- The Versatiles Landcover Vectors tileset is derived from ESA Worldcover and therefore also licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
- The code in this repository is in the [Public Domain](http://unlicense.org/UNLICENSE)
