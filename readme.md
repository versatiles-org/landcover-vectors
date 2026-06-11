# Versatiles Landcover Vectors

A set of vector tiles based on [ESA Worldcover](https://esa-worldcover.org/en/data-access).

There are to complement OSM tiles on lower zoom levels.

## Example

![Versatiles Landcover Vectors Example](doc/example.png)

## Requirements

- `node` (or `bun`)
- [`GDAL`](https://gdal.org/) ≥ 3.11 (`gdal_translate`, `gdalbuildvrt` and the `gdal raster tile` program on `PATH`)
- [`versatiles`](https://github.com/versatiles-org/versatiles-rs/blob/main/versatiles/README.md#install)

## How it's made

Each step below can be run directly with `node`, or via its npm script (shown after the `# or` line).
To run the whole pipeline (download → tile → render → simplify → pack) in order:

```sh
npm run build
```

### Download source data

```sh
node bin/download-worldcover.js
# or
npm run download
```

This downloads a reduced-resolution local mirror of [ESA WorldCover 2021 (v200)](https://registry.opendata.aws/esa-worldcover-vito/)
from AWS Open Data (`s3://esa-worldcover`). Each of the 2651 source GeoTIFFs is downsampled by a factor of 8 on the
way in (reading its matching internal overview, so only a small fraction of the full 10 m data is transferred) and
written to `tiles/esa-worldcover-src` in its native EPSG:4326. 1/8 (~74 m/px) keeps full detail for zoom 0–6, with
headroom for zoom 7 — so the whole mirror is only a few hundred MB instead of the full ~124 GB.

Downloads run in parallel, are retried, written atomically, and skipped if already present — so the step is robust
against network errors and resumable (re-running continues where it left off).

> The old download step used the Terrascope WMTS service, which is no longer available — hence the move to the AWS
> Open Data mirror.

### Cut the tile pyramid

```sh
node bin/tile-worldcover.js
# or
npm run tile
```

This cuts the local mirror into a web-mercator XYZ raster pyramid (zoom levels 0–6 by default) in
`tiles/esa-worldcover`, entirely from local disk — no network, so no flaky `/vsicurl` request storms.

Tiles are **4096×4096 px** — matching the MVT extent the renderer uses. A 4096 px tile at a given zoom has the same
ground resolution as a 256 px tile four zoom levels deeper, so the zoom-6 tiles carry zoom-10 detail in a single,
seam-free tile that the renderer vectorizes at native resolution (no upscaling). This produces far fewer, larger
tiles than a deep 256 px pyramid would.

`gdal raster tile` uses `mode` resampling, which keeps the land-cover class codes pure when downsampling, so the
lower zoom levels are categorically correct and no separate compositing step is needed. Each output tile carries the
raw ESA WorldCover class code as its pixel value (plus an alpha channel for nodata), which the render step
classifies directly — no fragile color matching.

You can pass a zoom range as parameter (default `0-6`):

```sh
node bin/tile-worldcover.js 0-4
# or
npm run tile -- 0-4
```

### Render vector tiles

```sh
node bin/render.js
# or
npm run render
```

For each imported tile this derives a monochrome mask per land-cover class (pixels are classified directly by their
ESA WorldCover class code), vectorizes each mask with `potrace`, and combines the results into one vector tile.
By default zoom levels 0-6 are created, you can pass the desired target zoom level as parameter:

```sh
node bin/render.js 4
# or
npm run render -- 4
```

⚠️ Note that `potrace-wasm` appears to leak memory and the script will run out of memory eventually.
You can run the script again, already created tiles will be skipped.

### Simplify vector tile polygons

```sh
node bin/simplify.js
# or
npm run simplify
```

This simplifies the polygons in each tile larger than 100kb using the Visvalingam–Whyatt algorithm.
The algorithm has been slightly modified to keep tile edges intact.

### Convert to Versatiles container

```sh
versatiles convert -c brotli tiles/vectortiles-simplified landcover-vectors.versatiles
# or
npm run pack
```

This compresses and packs all vectortiles into a versatiles container.

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
