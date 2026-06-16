# Versatiles Landcover Vectors

A set of vector tiles based on [ESA Worldcover](https://esa-worldcover.org/en/data-access).

They complement OSM-based [Shortbread](https://shortbread-tiles.org/) tiles at low and mid zoom levels — see
[Shortbread compatibility](#shortbread-compatibility) below.

## Example

![Versatiles Landcover Vectors Example](doc/example.png)

## Requirements

- `node` (or `bun`)
- [`GDAL`](https://gdal.org/) ≥ 3.13 with `gdalbuildvrt`, `gdaladdo`, `gdalwarp`, `gdal_calc.py`, `ogr2ogr` and the `gdal raster` / `gdal vector` subcommands `calc`, `edit`, `sieve`, `polygonize` and `simplify-coverage` on `PATH`
- Python 3 with `numpy` (used by `gdal_calc.py` for the per-class masks; both ship with the GDAL install)
- [`libvips`](https://www.libvips.org/) (`vips`) — used for the Gaussian blur
- [`tippecanoe`](https://github.com/felt/tippecanoe) (e.g. `brew install tippecanoe`)
- [`versatiles`](https://github.com/versatiles-org/versatiles-rs/blob/main/versatiles/README.md#install)

## How it's made

The pipeline turns the global landcover raster into smooth per-class polygons and tiles them into Shortbread's
`land` and `water_polygons` layers. There are just two scripts — a one-time source download and the build:

```sh
npm run download   # once: build the EPSG:3857 source raster from the remote tiles
npm run build      # everything else → landcover.versatiles
```

`build` runs: **coverage index → for each zoom 0–10 ( per-block processing → per-zoom tiling ) → merge & pack**.
Everything reads and writes under `data/`; the final container is `landcover.versatiles` in the repo root. All
the parameters below live in `config.ts`.

### Why blocks

A naïve pipeline renders one global EPSG:3857 raster per zoom level. At the resolution we want that reaches
60000×60000 px and beyond, and a global coverage-simplify loads the whole thing into RAM and gets OOM-killed.
Instead each zoom is processed in **blocks** of `BLOCK`×`BLOCK` = 8×8 tiles (`TILE_PX` = 1024 raw px per tile),
so every raster/vector operation works on a ≤ ~8226² px window — bounded memory, feasible at every zoom. The
blocks are stitched back into a seamless layer by a single per-zoom tippecanoe run.

### Build the source raster

```sh
node bin/download.ts
# or
npm run download
```

Reads the [ESA WorldCover 2021 (v200)](https://registry.opendata.aws/esa-worldcover-vito/) tiles **directly from
AWS Open Data** (`s3://esa-worldcover`) over `/vsicurl` — no local per-tile mirror. The ~2651 remote GeoTIFFs are
mosaicked into one virtual raster (`gdalbuildvrt`), and a single `gdalwarp` reprojects them into **one EPSG:3857
GeoTIFF** covering the whole Mercator square at the deepest zoom's resolution (`FULL_PX` = `TILE_PX`·2^`MAXLEVEL`
= 1 048 576 px per side, ≈ 38 m/px), written to `data/0_download/worldcover-3857.tif`; `gdaladdo` then adds an
overview pyramid down to z0.

Because every ESA tile carries internal overviews, the VRT exposes virtual overviews, so the warp reads a coarse
level instead of the full 10 m data — the transfer is a fraction of the ~124 GB full dataset. Resampling is
`-r mode` (dominant class — the only correct choice for categorical data). The GeoTIFF is tiled (512×512 blocks),
fast-DEFLATE compressed (`ZLEVEL=1`), BigTIFF, and **sparse** — all-no-data ocean blocks aren't stored. The
remote tile list is saved alongside (`_source-tiles.txt`) for the build's skip-empty step, and the raster is
written atomically, so an interrupted run leaves no half-built source.

> The old download step kept a reduced-resolution local mirror of all 2651 tiles; this builds the reprojected
> source in one pass instead.

### Per-block processing

`lib/block.ts` turns one block at one zoom into `land`/`water_polygons` polygon fragments. Each block reads its
window from the single EPSG:3857 source raster (built by the download step) and runs the same chain on it. The
read (`gdalwarp -te <block ± margin> -ts <px> -r mode -multi`) hits the source's overview pyramid, so a low-zoom
block reads a coarse pyramid level rather than the full-resolution data (≈100× less to read), while high-zoom
blocks read full detail; uncovered pixels are no-data:

1. **Channels** — for each landcover class _active at this zoom_ build a 0/255 membership mask (`gdal_calc.py`);
   ESA 0 plus every class **not** active at this zoom folds into the no-data channel.
2. **Blur** — Gaussian-blur each mask (`vips gaussblur`, σ = `BLUR_RADIUS` = 2 px) so the next step yields
   **curved** boundaries instead of a pixel staircase, while shared borders stay exact.
3. **Argmax** — the channel with the highest blurred value wins each pixel (`gdal raster calc --calc argmax`),
   giving a clean single-band coverage; `gdal raster edit` re-attaches the EPSG:3857 georeferencing that vips
   strips.
4. **Sieve** — `gdal raster sieve` drops specks smaller than a circle of the blur radius (`SIEVE_THRESHOLD` =
   round(π·r²) = 13 px).
5. **Crop** — `gdal_translate -projwin` cuts the classified raster to the block's exact inner 8×8-tile rectangle
   in EPSG:3857, discarding the margin. (Cropping the _raster_ rather than clipping the _vectors_ keeps the edge
   pixel-exact and avoids the boundary slivers a vector clip can turn into GeometryCollections.)
6. **Polygonize** — `gdal raster polygonize` → one polygon per region (field `code` = channel index), a
   **gap-free coverage of the whole block, including the no-data class**.
7. **Simplify** — coverage-simplify (`gdal vector simplify-coverage --preserve-boundary`, tolerance
   `(2·MERC)/(128·2^z)` ≈ 1 px at a 128 px tile) — topology-preserving, so shared borders stay aligned.
   ⚠️ **simplify-coverage only simplifies the _interior_ edges shared between adjacent polygons**;
   `--preserve-boundary` freezes the _exterior_. So the input must be a **100 %-filled coverage with no holes** —
   the no-data polygons included. If no-data were dropped first, every coastline would be exterior boundary and
   keep its raw pixel staircase. (That is why polygonize keeps no-data and the drop happens in step 8, not here.)
8. **Tag & split** — drop the no-data class, tag each polygon's Shortbread `kind` (SQLite `CASE` on `code`),
   reproject to EPSG:4326, and split into the block's `land` and `water_polygons` fragments
   (`-nlt PROMOTE_TO_MULTI`).

The **margin** (`MARGIN_PX` = ceil(3·`BLUR_RADIUS` + 3·√`SIEVE_THRESHOLD`) = 17 px) around each block means the
blur and sieve at the inner edge see the same neighbourhood they would in a global pass, so a class never
changes across a block seam. The blocks are cropped at **pixel-aligned, tile-exact** EPSG:3857 coordinates and
simplified with `--preserve-boundary`, so adjacent blocks share an identical straight edge — no gaps or slivers.

Which classes are active is per zoom: each `kind` is emitted only up to its cutoff (the `maxZoom` column in
`config.ts`, one below Shortbread's min-zoom for that value — see the mapping table below). Above its cutoff a
class folds into no-data, so the block produces nothing there and OSM takes over.

Both the per-block fragments (`data/1_results`) and the per-zoom tilesets (`data/2_tiles`) are **cached**: each
is written atomically (temp file renamed on success), and on re-run a block whose fragments already exist is
skipped — and a zoom whose `z{z}.mbtiles` already exists is skipped wholesale, without even iterating its blocks.
So an interrupted build resumes where it left off. The cache is keyed only on zoom + block position, so after
changing parameters in `config.ts` clear it (or run `npm run clean`) to force a rebuild.

### Skip-empty

ESA only ships 3° tiles where land exists (open ocean has no tile). `lib/coverage.ts` builds the set of occupied
3° cells from the recorded source tile list (`_source-tiles.txt`); a block whose bounding box intersects no occupied cell has no source data
and is skipped entirely (it would only have produced dropped no-data). At high zoom most blocks are ocean, so
this removes the bulk of the work. The test is conservative — it never skips a block that overlaps land — so it
can't create wrong holes.

### Per-zoom tiling

`lib/assemble.ts` unions all of a zoom's block fragments per layer (OGR VRT union → one FlatGeobuf), then runs
**one** `tippecanoe -Z z -z z -L land:… -L water_polygons:…` → `data/2_tiles/z{z}.mbtiles`. Doing the whole zoom
in one pass lets tippecanoe's per-tile buffers fill across block seams (no hairlines), and
`--coalesce-smallest-as-needed` keeps the coverage complete — when a low-zoom tile (e.g. the whole world at z0)
would exceed the MVT size limit, the smallest polygons merge into their neighbours rather than being dropped.
Only `kind` is kept in the tiles.

### Merge & pack

`tile-join` merges the per-zoom tilesets (disjoint zoom ranges) into `data/landcover.mbtiles`, then
`versatiles convert -c brotli` packs it into `landcover.versatiles` in the repo root.

To preview the result, `npm run style` writes a QGIS vector-tiles style (`landcover.qml`) that colours both
layers by `kind`.

## Shortbread compatibility

This project does **not** define its own layer. It produces a `.versatiles` container that adds polygons to
Shortbread's **own** [`land`](https://shortbread-tiles.org/) and **`water_polygons`** layers, at the **low zoom
levels where OpenStreetMap doesn't provide them yet**. You then **feature-merge** it with an OSM-based
Shortbread container (the VersaTiles CLI merges tilesets at the feature level) to get one seamless tileset.

Shortbread's `land`/`water_polygons` are OSM-derived: sparse (only what's mapped) and high-zoom (`land`
introduces its kinds from z7 upward, `water_polygons` from z4). Below those zooms a world map has no landcover
at all. This container fills exactly that gap with a **complete, generalized classification from global
satellite imagery** ([ESA WorldCover](https://esa-worldcover.org/), CC BY) — wall-to-wall, from z0 — written
into Shortbread's _own_ layer names and `kind` values, so **no schema extension and no new style rules are
needed**: a stock Shortbread style simply starts drawing `land`/`water_polygons` at low zoom.

**No overlap.** Each kind is emitted only _below_ the zoom where Shortbread introduces it (`fills` column
below); from that zoom up, the authoritative OSM features take over. ESA's open ocean / no-data is left out,
so those areas stay holes for Shortbread's `ocean` layer to fill.

### ESA WorldCover → Shortbread mapping

| ESA WorldCover class                    | → layer          | `kind`        | this container fills |
| --------------------------------------- | ---------------- | ------------- | -------------------- |
| Tree cover                              | `land`           | `forest`      | z0–6                 |
| Cropland                                | `land`           | `farmland`    | z0–9                 |
| Built-up                                | `land`           | `residential` | z0–9                 |
| Bare / sparse vegetation, moss & lichen | `land`           | `sand`        | z0–9                 |
| Shrubland                               | `land`           | `scrub`       | z0–10                |
| Grassland                               | `land`           | `grassland`   | z0–10                |
| Herbaceous wetland                      | `land`           | `marsh`       | z0–10                |
| Mangroves                               | `land`           | `swamp`       | z0–10                |
| Snow and ice                            | `water_polygons` | `glacier`     | z0–3                 |
| Permanent water bodies                  | `water_polygons` | `water`       | z0–3                 |
| No data / open ocean                    | —                | _(dropped)_   | —                    |

Every `kind` here is an existing Shortbread value, so the output validates and styles as plain Shortbread. The
cutoff per kind is one zoom below Shortbread's min-zoom for that value (e.g. Shortbread `forest` starts at z7,
so this container supplies `forest` for z0–6).

Two mappings are deliberately **lossy generalizations** — ESA can't resolve the OSM detail, and at these zooms
it doesn't matter visually:

- **Built-up → `residential`** — ESA's single "built-up" class can't distinguish residential / industrial /
  commercial; `residential` is the generic settlement fill.
- **Bare / sparse vegetation (+ moss & lichen) → `sand`** — Shortbread `land` has no generic "bare" value;
  `sand` matches the dominant case (deserts). Rocky barrens and Arctic tundra are approximated.

`wetland` is split to keep fidelity: herbaceous wetland → `marsh`, mangroves → `swamp`.

> **The complete→sparse handover.** Below a kind's cutoff this data is a complete wall-to-wall coverage; at and
> above it, OSM is sparse. Expect the landcover to thin out at the handover zoom — that is inherent to swapping
> a satellite classification for hand-mapped OSM, and a base land/ocean fill underneath covers the gaps.

### Using it

Merge this container with your OSM-based Shortbread tiles using the VersaTiles CLI (feature-level merge); the
combined tileset then has `land`/`water_polygons` populated continuously from z0. No style changes are
required — a standard Shortbread style already has rules for `forest`, `farmland`, `water`, `glacier`, etc.

## License

- [ESA Worldcover](https://esa-worldcover.org/en/data-access) is licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
- The Versatiles Landcover Vectors tileset is derived from ESA Worldcover and therefore also licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
- The code in this repository is in the [Public Domain](http://unlicense.org/UNLICENSE)
