# Land cover version 4 and its integration

Version 4 of `landcover-vectors` is drawn as a **source of its own under OSM**, instead of being merged into OSM's
tiles. This document describes the data, how a style uses it, and what other repositories have to change.

Status on 2026-11-01: the code writes a single `landcover` layer, and the merged `osm-landcover` is retired. The
container built from commit `ac26416` still has Shortbread's `land` and `water_polygons` layers, so version 4 needs a
full rebuild before it is uploaded. No other repository has changed yet; the issues below track what they need.

## Decisions

- **One `landcover` layer, with Shortbread's kinds.** The layer is no longer Shortbread's `land` and
  `water_polygons`, so a Shortbread style can't mistake it for OSM, and a style copies its fills from one source
  layer. The `kind` values stay Shortbread's, so versatiles-style's colours apply as they are.
- **The merged `osm-landcover` is retired.** It is deleted from the Storage Box. The download updater never deletes
  from R2, so `/tiles/osm/` keeps serving it from the CDN until it is switched to plain OSM. Delete it from R2 only
  after that switch (`docs/runbook.md` in download.versatiles.org). This repository no longer has merge tooling.
- **Attribution and licence.** The container is licensed under the ODbL and contains ESA WorldCover data under
  CC BY 4.0. Its `attribution` starts with OSM's attribution exactly as OSM's Shortbread tiles carry it, so that
  MapLibre, which drops an attribution contained in another one, shows OSM's credit once on a map that draws both.
- **`tile_schema` is `versatiles/landcover@1.0`.** versatiles knows it from 5.6.0 on. No other project has a schema
  field like `tile_schema`; where one tileset combines several schemas, Mapbox and OGC's tileset metadata describe
  them per layer, so a joined name like `shortbread@1.1+…` has no precedent. The name follows the spec's
  `<family>[/<subtype>][@<version>]` and keeps VersaTiles' own schemas together.
- **Version 4 replaces version 3 in place**, as `landcover-vectors.versatiles`, without a date in the name. That is
  how it has been published so far, and with `osm-landcover` retired, nothing depends on version 3 staying available.

## The data

| property      | value                                                              |
| ------------- | ------------------------------------------------------------------ |
| file          | `landcover-vectors.versatiles`                                     |
| size          | about 4.5 GB (brotli), measured again after the rebuild            |
| format        | VersaTiles container with MVT tiles                                |
| zooms         | z0–10; a style overzooms z10 above that                            |
| `version`     | `4`                                                                |
| `tile_schema` | `versatiles/landcover@1.0`                                         |
| layers        | one, `landcover`, with one attribute, `kind`                       |
| built from    | being built since 2026-11-01; the published one has the old layers |

| ESA WorldCover class     | `kind`        | OSM's layer      | versatiles-style layer |
| ------------------------ | ------------- | ---------------- | ---------------------- |
| Tree cover               | `forest`      | `land`           | `land-forest`          |
| Cropland                 | `farmland`    | `land`           | `land-agriculture`     |
| Built-up                 | `residential` | `land`           | `land-residential`     |
| Bare / sparse vegetation | `bare_rock`   | `land`           | `land-rock`            |
| Moss and lichen          | `heath`       | `land`           | `land-vegetation`      |
| Shrubland                | `scrub`       | `land`           | `land-vegetation`      |
| Grassland                | `grassland`   | `land`           | `land-grass`           |
| Herbaceous wetland       | `marsh`       | `land`           | `land-wetland`         |
| Mangroves                | `swamp`       | `land`           | `land-wetland`         |
| Snow and ice             | `glacier`     | `water_polygons` | `land-glacier`         |
| Permanent water          | `water`       | `water_polygons` | `water-area`           |

"OSM's layer" is where OSM's Shortbread tiles have the kind, and where the versatiles-style layer reads it.

**Sea.** The sea is a hole. The land cover ends at OSM's coastline, and OSM's `ocean` layer fills the rest.

**OSM land use.** OSM's land use is burned into ESA's classes before the tiles are generalized.

**What changed since version 3.** The layer, the outlines are rounder and the patches kept at low zooms are smaller,
z0–2 read a finer raster, and OSM's land use is burned in. Measured results are in [TUNING.md](TUNING.md).

## How a style draws it

The stacked style has two vector sources: plain OSM, **without** merged land cover, and `landcover-vectors`. The draw
order is:

1. `background`
2. the land cover fills, in versatiles-style's `osm.slots.belowFills` (`slot-below-fills`)
3. `water-ocean`
4. the stock OSM layers, unchanged

Each land cover layer is a copy of the stock fill for its kinds, with these changes:

- `source` is the land cover source, and `source-layer` is `landcover`.
- `id` gets a prefix, for example `landcover-land-forest`.
- `filter` keeps only the kinds of the table, for example `["in", ["get", "kind"], ["literal", ["heath", "scrub"]]]`.
- `minzoom` is removed, so it draws from z0.
- `fill-opacity` is replaced by this fade:

```json
["interpolate", ["linear"], ["zoom"], 12, 1, 14, 0.25]
```

So the land cover is opaque up to z12, fades to 25 % by z14, and stays at 25 % above that. It never disappears
completely, so land OSM doesn't map keeps a hint of colour.

No merge and no `vector_filter_features` are needed. Lakes need no special handling either: from z4, OSM's lakes draw
above the land cover's `water`, which still shows where OSM has no lake.

The reference implementation is `landcoverLayers` and `stackedStyle` in
[`lib/style-versatiles.ts`](../lib/style-versatiles.ts). They produce the 9 layers of the table, one for each stock
fill that draws one of the kinds.

## Changes in other repositories

Findings come from reading each repository's current state. Nothing below has been tried in those repositories.

### versatiles-rs (done)

Released in 5.6.0, which this repository's pack uses through `@versatiles/versatiles-rs`:

- [versatiles-rs#300](https://github.com/versatiles-org/versatiles-rs/issues/300): accept and keep well-formed
  `tile_schema` values versatiles doesn't know.
- [versatiles-rs#301](https://github.com/versatiles-org/versatiles-rs/issues/301): add `versatiles/landcover@1.0`.

### versatiles-docker (done)

[versatiles-docker#60](https://github.com/versatiles-org/versatiles-docker/issues/60): `versatiles-planetiler
--landcover` merged the public `landcover-vectors.versatiles` into Shortbread's layers. The merge is removed, and
`--landcover` now fails with a pointer to the separate source. All images were rebuilt with versatiles 5.6.0 on
2026-11-01.

### download.versatiles.org (open)

[download.versatiles.org#43](https://github.com/versatiles-org/download.versatiles.org/issues/43). The page has
listed neither `landcover-vectors` nor `osm-landcover` since the update of 2026-10-27: both are gone from the Storage
Box, and stay downloadable from R2.

- **Publishing** follows `docs/runbook.md`. Put the file on the Storage Box as
  `download/landcover-vectors/landcover-vectors.versatiles`, with its `.md5` and `.sha256`, and start the Update
  workflow or wait for the 20th.
- **`src/lib/file/datasets.ts`:** the `landcover-vectors` entry credits only ESA, describes Shortbread's `land` and
  `water_polygons` layers, and points users to the merge. It needs OSM and the ODbL, and the separate source. The
  `osm-landcover` entry ("OpenStreetMap + Landcover (Beta)") goes. Both link into the land cover page of the docs
  (`#using-it`, `#2-render-at-low-zoom`), so their links follow versatiles-documentation#96.
- **R2:** delete `osm-landcover.versatiles` only after `/tiles/osm/` is switched (tiles.versatiles.org#39). Until then
  that server mirrors it, and the download updater never deletes from R2.

### tiles.versatiles.org (open)

[tiles.versatiles.org#39](https://github.com/versatiles-org/tiles.versatiles.org/issues/39): `/tiles/osm/` is
served from the merged `osm-landcover.versatiles`, and `landcover-vectors` isn't served at all: its `tiles.json`
returns 404. In `download/sources.json`:

- Add `landcover-vectors` as a served dataset.
- Later, serve `osm` from plain `osm.versatiles` by removing `"source": "osm-landcover"`.
- Update `tests/expected` and the README.

**Order matters.** Switching `osm` to plain tiles removes the land cover at z0–10 for every client whose style still
expects the merge. So first serve `landcover-vectors`, then release and roll out the new style, and only then switch
`osm`.

The new style works over today's merged `osm` nearly unchanged. Its stock layers draw the merged copy of a kind on
top of the land cover in the same colour, so it only shows where that copy, from the land cover of July 2026,
differs from version 4. Painted like the experiment paints a map (`lib/measure.ts`), the top fill at z7–10 changes
on 0–0.3 % of the pixels in 8 of the 10 test regions, 0.6 % in Atlanta at z10, and up to 1.3 % in Hudson Bay,
mostly old wetland over new water. That count leaves out fills below half their opacity, and it was not looked at in
a browser.

### tools (open)

[tools#67](https://github.com/versatiles-org/tools/issues/67): the server setup offers OSM, satellite and
elevation, and should offer `landcover-vectors` too. That means a map option, a size index built from the download,
and its checksum in CI's cache key. With four maps, two generated lines get too long for the layout test. Work on it
only after version 4 is on download.versatiles.org: until then that URL has version 3, whose layers no style draws
on its own.

### versatiles-style (open)

[versatiles-style#145](https://github.com/versatiles-org/versatiles-style/issues/145) proposes, like elevation's
`urls.elevation` with `features.hillshade`:

- **`urls.landcover`**: the land cover's TileJSON, by default
  `https://tiles.versatiles.org/tiles/landcover-vectors/tiles.json` (tiles.versatiles.org#39).
- **`features.landcover: true`** adds that source and the 9 layers at `osm.slots.belowFills`, with the fade. The
  stock OSM layers stay unchanged.

Today `features.landcover` means "the tiles are a merge": it removes the fade-ins of the stock layers, and adds no
source. Changing its meaning makes this a major release; the merged mode isn't kept. The stacked style also works over
today's merged `/tiles/osm/` (see [tiles.versatiles.org](#tilesversatilesorg-open)), so the release can come before
that switch. Also:

- `osm.supportsLandcover(tileJSON)` tells whether an OSM tileset is merged. It can go, or tell whether a TileJSON is a
  land cover tileset instead.
- `guessSchema` recognises schemas by their layer names and has no `landcover` signature, so a land cover tileset
  alone gets no style. A signature, and later its `tile_schema`, would let `guessStyle` draw it.
- Tests, `API_DESIGN.md`, and `src/features/landcover.ts`.

The reference implementation is `landcoverLayers` and `stackedStyle` in `lib/style-versatiles.ts`.

### versatiles-documentation (open)

[versatiles-documentation#96](https://github.com/versatiles-org/versatiles-documentation/issues/96), in three parts:

- **Now:** the extended TileJSON spec (`versatiles/landcover@1.0`, the missing `shortbread@1.1`, and keeping
  unknown values, as versatiles 5.6.0 does), and `guides/generate_tiles_from_osm.md`, which still documents the
  removed `--landcover`.
- **After version 4 and the versatiles-style release:** the land cover page, `basics/tilesets.md` and the
  compendium's summaries, which describe the merge and `osm-landcover`.
- **After tiles.versatiles.org serves plain OSM:** the notes on the hosted `osm` tileset.

### Not checked

These may expose `features.landcover` or assume a single vector source. They need a look once the style's API is
settled: versatiles-frontend, maplibre-versatiles-styler, editor, maputnik, node-versatiles-svelte,
versatiles-svg-renderer, versatiles-studio, playground and versatiles-org.github.io.

## Suggested order

1. ~~Settle the schema's name, and release versatiles-rs#300 or #301~~ (5.6.0); add the value to the TileJSON spec.
2. ~~Remove the land cover merge from versatiles-planetiler (versatiles-docker#60).~~
3. Rebuild version 4 with the `landcover` layer and the schema, then upload and publish it with the corrected
   attribution (download.versatiles.org#43).
4. Serve `landcover-vectors` on tiles.versatiles.org, and offer it in tools' server setup (tools#67).
5. Release versatiles-style with stacking (versatiles-style#145), and update the documentation
   (versatiles-documentation#96).
6. Roll out the new styles, switch `/tiles/osm/` to plain OSM, and delete `osm-landcover` from R2.
