# Versatiles Landcover Vectors

A set of vector tiles based on [ESA Worldcover](https://esa-worldcover.org/en/data-access).

There are to complement OSM tiles on lower zoom levels.

## Example

![Versatiles Landcover Vectors Example](doc/example.png)

## Requirements

- `node` (or `bun`)
- [`GDAL`](https://gdal.org/) ≥ 3.11 (`gdal_translate`, `gdal_sieve.py`, `ogr2ogr` and the `gdal raster polygonize` program on `PATH`)
- [`tippecanoe`](https://github.com/felt/tippecanoe) (e.g. `brew install tippecanoe`)
- [`versatiles`](https://github.com/versatiles-org/versatiles-rs/blob/main/versatiles/README.md#install)

## How it's made

Each step below can be run directly with `node`, or via its npm script (shown after the `# or` line).
To run the whole pipeline (download → polygonize → tile → pack) in order:

```sh
npm run build
```

All steps read and write under `data/` by default; set the `DATA_DIR` environment variable to use a different
location.

### Download source data

```sh
node bin/download-worldcover.js
# or
npm run download
```

This downloads a reduced-resolution local mirror of [ESA WorldCover 2021 (v200)](https://registry.opendata.aws/esa-worldcover-vito/)
from AWS Open Data (`s3://esa-worldcover`). Each of the 2651 source GeoTIFFs is downsampled by a factor of 8 on the
way in (reading its matching internal overview, so only a small fraction of the full 10 m data is transferred) and
written to `data/esa-worldcover-src` in its native EPSG:4326. 1/8 (~74 m/px) keeps full detail for zoom 0–6, with
headroom for zoom 7 — so the whole mirror is only a few hundred MB instead of the full ~124 GB.

Downloads run in parallel, are retried, written atomically, and skipped if already present — so the step is robust
against network errors and resumable (re-running continues where it left off).

> The old download step used the Terrascope WMTS service, which is no longer available — hence the move to the AWS
> Open Data mirror.

### Vectorize (polygonize)

```sh
node bin/polygonize-worldcover.js
# or
npm run polygonize
```

This vectorizes the raster mirror into one polygon geometry file. Each source tile is processed **in parallel**
behind a single progress bar: small specks are sieved out, `gdal raster polygonize` turns it into polygons (one per
connected class region), and each polygon is tagged with its Shortbread `kind`. The per-tile results are merged into
a single FlatGeobuf at `data/landcover.fgb`. The step is resumable — already-polygonized tiles are skipped.

This is the geospatially-correct vectorization: polygons follow class boundaries exactly, with **no per-tile seams**
(unlike tracing each tile separately). Polygons split at source-tile boundaries are healed when tiling.

Each tile is downsampled to the target zoom resolution before polygonizing, so the geometry isn't far finer than the
tiles can show — this keeps the intermediate geometry small (polygonizing the full ~74 m mirror produces several
times more vertices and tiny polygons than zoom 6 needs).

Tuning via environment variables:

- `POLYGONIZE_SCALE` — downsample each source tile to this fraction first (default `50%`, i.e. ~74 m → ~152 m,
  native to zoom 6, using dominant-class resampling). Use `100%` to keep full mirror resolution for zoom 7.
- `POLYGONIZE_SIEVE` — drop connected regions smaller than this many pixels (default `8`; `0` disables).

> The per-tile files in `data/polygons` plus the merged `data/landcover.fgb` together use about twice the geometry
> size; once tiling succeeds you can delete `data/polygons` (it only exists to make the step resumable).

### Tile

```sh
node bin/tile-worldcover.js
# or
npm run tile
```

This builds the vector tile pyramid from the merged geometry with [tippecanoe](https://github.com/felt/tippecanoe),
writing `data/landcover.mbtiles`. tippecanoe simplifies the geometry per zoom level and tiles it seamlessly in one
pass: `--detect-shared-borders` keeps boundaries between adjacent classes coincident while simplifying (no
slivers/gaps), and `--coalesce-smallest-as-needed` merges the tile-boundary fragments left by polygonization rather
than dropping them, so coverage stays complete at every zoom.

By default zoom levels 0–6 are created; pass a range as parameter:

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
style transitions seamlessly from these low-zoom tiles (z0–6) to OSM-based Shortbread tiles (z7+):

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
