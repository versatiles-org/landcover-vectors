# VersaTiles Landcover Vectors

Global land cover for zoom levels 0–10, as vector tiles that merge into an OSM-based
[Shortbread](https://shortbread-tiles.org/) tileset. Built from [ESA WorldCover 2021](https://esa-worldcover.org/en/data-access).

OpenStreetMap's land cover is hand-mapped, so it is patchy, and Shortbread shows most of it only from z11. This
tileset fills z0–10 with a complete classification from satellite imagery, written into Shortbread's own `land`
and `water_polygons` layers and `kind` values, so a stock Shortbread style draws it without changes. From z11
on, OSM takes over.

**Download** from [download.versatiles.org](https://download.versatiles.org/):

- [`landcover-vectors.versatiles`](https://download.versatiles.org/landcover-vectors.versatiles) (~2 GB) — this
  tileset, to [merge with OSM](#merging-with-osm) yourself
- [`osm-landcover.versatiles`](https://download.versatiles.org/osm-landcover.versatiles) (~69 GB) — OSM
  Shortbread with it already merged in

![Versatiles Landcover Vectors Example](doc/example.png)

## Contents

- [What's in the tiles](#whats-in-the-tiles)
- [Merging with OSM](#merging-with-osm)
- [Building](#building)
- [How it works](#how-it-works)
- [Development](#development)
- [License](#license)

## What's in the tiles

Each ESA WorldCover class becomes an existing Shortbread `kind`, so the output validates and styles as plain
Shortbread — no schema extension, no new style rules:

| ESA WorldCover class     | → layer          | `kind`        | this container fills |
| ------------------------ | ---------------- | ------------- | -------------------- |
| Tree cover               | `land`           | `forest`      | z0–10                |
| Cropland                 | `land`           | `farmland`    | z0–10                |
| Built-up                 | `land`           | `residential` | z0–10                |
| Bare / sparse vegetation | `land`           | `bare_rock`   | z0–10                |
| Moss & lichen            | `land`           | `heath`       | z0–10                |
| Shrubland                | `land`           | `scrub`       | z0–10                |
| Grassland                | `land`           | `grassland`   | z0–10                |
| Herbaceous wetland       | `land`           | `marsh`       | z0–10                |
| Mangroves                | `land`           | `swamp`       | z0–10                |
| Snow and ice             | `water_polygons` | `glacier`     | z0–10                |
| Permanent water bodies   | `water_polygons` | `water`       | z0–10                |
| No data / open ocean     | —                | _(dropped)_   | —                    |

Open ocean is left out, so it stays a hole for Shortbread's `ocean` layer to fill. Only `kind` is stored.

Some mappings are deliberately **lossy generalizations** — ESA can't resolve the OSM detail, and at these
zooms it doesn't matter visually:

- **Built-up → `residential`** — ESA's single "built-up" class can't distinguish residential / industrial /
  commercial; `residential` is the generic settlement fill.
- **Bare / sparse vegetation → `bare_rock`** — this class conflates rocky/gravelly barrens (Iceland, tundra,
  high mountains) with sandy deserts, which ESA can't tell apart; `bare_rock` renders neutrally for both,
  where `sand` would tint every barren yellow. Sandy deserts lose their sand tint as a result.
- **Moss & lichen → `heath`** — Shortbread has no moss/lichen value; `heath` is the closest low tundra
  vegetation fill.

`wetland` is split to keep fidelity: herbaceous wetland → `marsh`, mangroves → `swamp`.

## Merging with OSM

### The handover

For most kinds there is **one handover, at z10 → z11**: up to z10 the land cover supplies them, from z11 OSM
does. Two kinds go to OSM earlier (see below).

OSM has its own copies of some kinds earlier — `forest` from z7, `farmland` from z10, `glacier` from z4 — but they are sparse where the satellite data is complete: in central Spitsbergen, OSM maps
9 % of a tile as glacier where ESA sees 96 % ice. So a merge **drops OSM's features of these kinds up to z10**.
Each zoom then has exactly one source per kind. OSM's other kinds (`river`, `reservoir`, `park`, …) are kept at
every zoom.

**`water` and `residential` are the exceptions.** Where OSM has them, they are more precise than ESA's, so the
merge keeps **OSM's** copy and drops the land cover's instead:

- **`water` from z4**, where Shortbread starts it. OSM's lakes are precise where ESA's are a classified raster.
  The land cover's `water` is only used at z0–3, where Shortbread has no lakes at all.
- **`residential` from z10**, where Shortbread starts every urban kind. OSM separates residential, industrial,
  commercial, retail and railway land; ESA's single built-up class would cover them all and, drawn on top,
  hide OSM's urban detail. The land cover's `residential` is used up to z9.

Both containers still carry these kinds to z10, so each stands on its own.

Expect the land cover to thin out at z11: that is what swapping a complete satellite classification for
hand-mapped OSM looks like, and a base land fill underneath covers the gaps.

### Merge with the VersaTiles CLI

Filter both sources on the way into `from_merged_vector`. The filter's CEL strings use single quotes, which a
shell argument in single quotes cannot hold, so write the pipeline to a file:

```sh
cat > merge.vpl <<'EOF'
from_merged_vector [
  from_container filename="osm.versatiles"
    | vector_filter_features layer=["land"] expr="!(zoom <= 10 && kind in ['forest', 'farmland', 'bare_rock', 'heath', 'scrub', 'grassland', 'marsh', 'swamp'])"
    | vector_filter_features layer=["water_polygons"] expr="!(zoom <= 10 && kind in ['glacier'])",
  from_container filename="landcover-vectors.versatiles"
    | vector_filter_features layer=["land"] expr="!(zoom >= 10 && kind in ['residential'])"
    | vector_filter_features layer=["water_polygons"] expr="!(zoom >= 4 && kind in ['water'])"
]
EOF
versatiles convert -c brotli merge.vpl combined.versatiles
```

> **Needs versatiles ≥ 4.15.0.** `vector_filter_features` gained the tile's `zoom` in 4.15.0. Older versions do
> not report an error: 4.14.0 silently drops every feature of the filtered layers, at every zoom, so the merged
> tileset ends up without `land` and `water_polygons`.

For a local build, `npm run merge` does the same: it downloads the latest
[OSM Shortbread container](https://download.versatiles.org/osm.versatiles) to `data/osm.versatiles` (~66 GB,
once and resumable), merges it with `data/landcover.versatiles` into `data/combined.versatiles`, and refuses to
run with versatiles below 4.15.0. Its filters are generated from `channels` in `config.ts` (`lib/handover.ts`),
so they follow any change of a cutoff.

## Building

### Requirements

- `node` (or `bun`)
- [`GDAL`](https://gdal.org/) ≥ 3.13 with `gdalbuildvrt`, `gdaladdo`, `gdalwarp`, `gdalinfo`, `gdal_translate`, `gdal_calc.py`, `ogr2ogr` and the `gdal raster` / `gdal vector` subcommands `calc`, `edit`, `sieve`, `polygonize` and `simplify-coverage` on `PATH`
- Python 3 with `numpy` (used by `gdal_calc.py` for the per-class masks; both ship with the GDAL install)
- [`libvips`](https://www.libvips.org/) (`vips`) — used for the Gaussian blur
- [`tippecanoe`](https://github.com/felt/tippecanoe) (e.g. `brew install tippecanoe`) — `tippecanoe-decode`, which ships with it, is used by `npm run stats -- --attribute`
- [`versatiles`](https://github.com/versatiles-org/versatiles-rs/blob/main/versatiles/README.md#install) ≥ 4.15.0
- for `npm run preview`: a browser, and internet access for MapLibre GL from a CDN (the tiles themselves are served locally)

### Run

```sh
npm run download   # once: build the EPSG:3857 source raster from ESA's remote tiles
npm run build      # everything else → data/landcover.versatiles
npm run merge      # optional: merge with OSM → data/combined.versatiles
```

> **Resources.** A full z0–10 build needs roughly **150 GB** of disk under `data/` (the ~23 GB EPSG:3857 source
> plus the per-block / per-zoom caches) and on the order of **300 core-hours** of CPU. It's heavily
> parallelised, but plan for a long run on a many-core machine with ample free disk.

Everything reads and writes under `data/`; `LANDCOVER_DATA_DIR` moves it, and `LANDCOVER_SOURCE_DIR` lets
several data dirs share one source raster. All parameters live in `config.ts`.

The build is **resumable**. Every per-block fragment (`data/1_results`) and per-zoom tileset (`data/2_tiles`) is
written atomically and skipped on a re-run, so an interrupted build continues where it stopped. The caches are
stamped with a fingerprint of the parameters they were built with: after a change in `config.ts` the build
names what changed and refuses to mix old and new. `npm run clean` clears them (the download stays), or point
`LANDCOVER_DATA_DIR` at a fresh directory.

## How it works

`build` runs: **coverage index → for each zoom 0–10 ( per-block processing → per-zoom tiling ) → pack**.

### Blocks

A naïve pipeline renders one global EPSG:3857 raster per zoom level. At the resolution we want that reaches
60000×60000 px and beyond, and a global coverage-simplify loads the whole thing into RAM and gets OOM-killed.
Instead each zoom is processed in **blocks** of `BLOCK`×`BLOCK` = 8×8 tiles (`TILE_PX` = 1024 raw px per tile),
so every raster/vector operation works on a ≤ ~8242² px window — bounded memory, feasible at every zoom. The
blocks are stitched back into a seamless layer by a single per-zoom tippecanoe run.

### Source raster

`npm run download` reads the [ESA WorldCover 2021 (v200)](https://registry.opendata.aws/esa-worldcover-vito/)
tiles **directly from AWS Open Data** (`s3://esa-worldcover`) over `/vsicurl`. The ~2651 remote GeoTIFFs are
mosaicked into one virtual raster (`gdalbuildvrt`), and a single `gdalwarp -r mode` (dominant class, the right
choice for categorical data) reprojects them into **one EPSG:3857 GeoTIFF** at the deepest zoom's resolution
(`FULL_PX` = `TILE_PX`·2^`MAXLEVEL` = 1 048 576 px per side, ≈ 38 m/px): `data/0_download/worldcover-3857.tif`.
`gdaladdo` then adds an overview pyramid down to z0.

The warp reads ESA's internal overviews rather than the full 10 m data, so it transfers a fraction of the
~124 GB dataset. The output is tiled, ZSTD-compressed (level 9), BigTIFF and **sparse** — all-ocean blocks
aren't stored. It is written atomically, so an interrupted run leaves no half-built source.

### Coverage index

ESA only ships 3° tiles where land exists. `lib/coverage.ts` builds the set of occupied 3° cells from the
source tile list (`_source-tiles.txt`, saved by the download), and a block that intersects no occupied cell is
skipped. At high zoom most blocks are ocean, so this removes the bulk of the work. The test is conservative:
it never skips a block that overlaps land.

### Per-block processing

`lib/block.ts` turns one block at one zoom into `land`/`water_polygons` fragments. It reads the block's window
plus a margin from the source (`gdalwarp -r mode`, which picks the matching overview level, so a low-zoom block
reads ≈100× less), then:

1. **Channels** — one 0/255 mask per class active at this zoom, all from one `gdal_calc.py` call. ESA's no-data
   and every inactive class fold into the no-data channel.
2. **Blur** — one `vips gaussblur` over all masks (σ = `BLUR_RADIUS` = 3 px, i.e. `BLUR_RENDERED` = 0.75
   rendered px). This is what makes the boundaries **curved** instead of a pixel staircase.
3. **Argmax** — the channel with the highest blurred value wins each pixel (`gdal raster calc`).
4. **Sieve** — `gdal raster sieve` merges specks smaller than a circle of the blur radius
   (`SIEVE_THRESHOLD` = round(π·r²) = 28 px) into their neighbours.
5. **Crop** — cut the raster to the block's exact 8×8-tile rectangle, discarding the margin. Cropping the
   raster rather than clipping vectors keeps the edge pixel-exact.
6. **Polygonize** — `gdal raster polygonize`, giving a gap-free coverage of the block, **no-data included**.
7. **Simplify** — `gdal vector simplify-coverage --preserve-boundary`, tolerance
   `(2·MERC)/(256·DETAIL_PX·2^z)` ≈ 1 px at a 256·`DETAIL_PX` px tile (`DETAIL_PX` = 1 today).
   ⚠️ It simplifies only edges _shared_ between polygons, which is why no-data must still be there: without it,
   every coastline would be an outer edge and keep its pixel staircase.
8. **Tag & split** — drop no-data, tag each polygon's Shortbread `kind`, reproject to EPSG:4326, and split into
   `land` and `water_polygons`.

The **margin** (`MARGIN_PX` = ceil(3·`BLUR_RADIUS` + 3·√`SIEVE_THRESHOLD`) = 25 px) lets blur and sieve at
the inner edge see the same neighbourhood as a global pass would, so a class never changes across a block
seam; the tile-exact crop and `--preserve-boundary` give neighbouring blocks an identical straight edge.

Each kind is active up to its cutoff (`maxZoom` in `config.ts`, z10 for every kind today). Above it, a class
folds into no-data.

**Fast paths.** A histogram of the window (`gdalinfo -hist`) says which ESA values occur. Masks and blur are
built only for the kinds present, which is exact, not an approximation. If the whole window is a single kind,
the block is emitted directly as one rectangle of that kind. ⚠️ GDAL leaves no-data pixels out of the
histogram, so "a single value" also requires the histogram to count every pixel of the window; otherwise a
coastal block with one land class would be painted over the ocean too.

### Per-zoom tiling

`lib/assemble.ts` unions a zoom's block fragments per layer into one FlatGeobuf and runs **one**
`tippecanoe -Z z -z z` over it → `data/2_tiles/z{z}.mbtiles`. Tiling the whole zoom at once fills tippecanoe's
tile buffers across block seams (no hairlines), and `--coalesce-smallest-as-needed` keeps the coverage
complete: when a low-zoom tile would exceed the size limit, the smallest polygons merge into their neighbours
instead of being dropped.

### Pack

`tile-join` joins the per-zoom tilesets into `data/landcover.mbtiles`, and `versatiles convert -c brotli` packs
it into `data/landcover.versatiles`, stamping `tile_schema: shortbread@1.1` so consumers can tell that a
Shortbread style fits. The build ends with a per-zoom tally of how its blocks were processed, from
`data/blocks.log`.

## Development

| command           | what it does                                                                         |
| ----------------- | ------------------------------------------------------------------------------------ |
| `npm run preview` | build one area, serve it next to real OSM data and open a viewer                     |
| `npm run stats`   | tile size distribution, worst tiles, and a baseline to diff builds against           |
| `npm run sweep`   | build an area once per parameter value and compare size and quality                  |
| `npm run inspect` | compare one tile pixel by pixel with what it should show, as numbers and a PNG       |
| `npm run style`   | write a QGIS vector-tiles style (`landcover.qml`) that colours both layers by `kind` |
| `npm run clean`   | delete the build caches (keeps the download)                                         |
| `npm run check`   | typecheck, formatting and tests                                                      |

### Preview

```sh
npm run preview -- --area hudson-bay --zoom 4-10   # build that area, serve it, open the viewer
npm run preview -- --bbox 4,58,12,64 --watch       # rebuild and reload when config.ts changes
npm run preview -- --tiles data/landcover.mbtiles  # just look at an existing tileset
```

A parameter change is worth a few minutes on one area, not a full build. The preview runs the area's blocks
through **the same** `lib/pipeline.ts` as the build and serves the result with `versatiles serve`. Each parameter
set builds into its own `data/preview/<config fingerprint>/`, so switching back and forth reuses the caches.

The viewer (`dev/viewer/`, MapLibre GL) mounts the **real OSM Shortbread container** from
`download.versatiles.org` alongside, drawn the way the merge keeps it, so the handover is visible against real
data. OSM's `ocean` sits under the land cover, so no-data holes show up as ocean. The viewer also has a
block-grid overlay, a legend with per-kind toggles, click-to-inspect, and the config fingerprint in the header,
so a screenshot documents itself. The position is in the URL hash (`#z/lat/lon`), which is what
`npm run stats -- --worst` prints.

### Tuning

| stage  | knob                                                         | what it changes                                                                                      | override                   |
| ------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| raster | `BLUR_RENDERED` (0.75 rendered px)                           | the Gaussian σ before the per-pixel majority vote — **which class ends up where**                    | `LANDCOVER_BLUR_RENDERED`  |
| raster | `SIEVE_RENDERED` (π·σ², so it follows the blur)              | the smallest patch kept; the main lever on feature count; 0 turns it off                             | `LANDCOVER_SIEVE_RENDERED` |
| vector | `DETAIL_PX` (1)                                              | the simplify tolerance — how precisely outlines follow the result                                    | `LANDCOVER_DETAIL_PX`      |
| raster | `TILE_PX` (1024 → 38 m/px at z10, against ESA's native 10 m) | the resolution the source is classified at; 4× source raster and CPU per doubling, and a re-download | — (edit, then re-download) |

The overrides are for sweeps; each value builds into its own cache, because all knobs are part of the config
fingerprint. The worst tile of the z0–10 build is 60.5 KB, about 8× below tippecanoe's 500 000-byte limit. How
to measure a change, and what the measurements so far say, is in [doc/TUNING.md](doc/TUNING.md).

## License

- [ESA Worldcover](https://esa-worldcover.org/en/data-access) is licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
- The Versatiles Landcover Vectors tileset is derived from ESA Worldcover and therefore also licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
- The code in this repository is in the [Public Domain](http://unlicense.org/UNLICENSE)
