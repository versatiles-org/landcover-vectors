# Land cover version 4 and its integration

Version 4 of `landcover-vectors` is built, and it can now be drawn as a **source of its own under OSM**, instead of
being merged into OSM's tiles. This document describes the data, how a style uses it, and what other repositories
have to change.

Status on 2026-11-01: the container is built and the stacked style is tested in `dev/map`. The container is not
uploaded and no other repository has changed yet. `main` is not pushed.

## Why the integration changes

So far the land cover has been merged into OSM's `land` and `water_polygons` layers, and OSM took over at z11. Since
OSM maps only part of the land, the coloured land thins out abruptly there: at z11 OSM still covers 89 % of the land
in the Netherlands, but 14 % in Iowa and 0.1 % in the Australian outback.

Drawn as a separate source, the land cover stays under OSM at every zoom. OSM paints over it where it has data, and
the land cover shows wherever it has none.

## The data

| property      | value                                                                   |
| ------------- | ----------------------------------------------------------------------- |
| file          | `landcover-vectors.versatiles`                                          |
| size          | 4,453,468,476 bytes (brotli); the published version 3 has 4,682,409,043 |
| format        | VersaTiles container with MVT tiles, 831,344 tiles                      |
| zooms         | z0–10; a style overzooms z10 above that                                 |
| `version`     | `4`                                                                     |
| `tile_schema` | `shortbread@1.1`                                                        |
| built from    | commit `ac26416`, config fingerprint `f16f3d9d`                         |
| largest tile  | 72.2 KB gzipped                                                         |

**Layers.** There are two, `land` and `water_polygons`, and the only attribute is `kind`:

| ESA WorldCover class     | layer            | `kind`        | versatiles-style layer |
| ------------------------ | ---------------- | ------------- | ---------------------- |
| Tree cover               | `land`           | `forest`      | `land-forest`          |
| Cropland                 | `land`           | `farmland`    | `land-agriculture`     |
| Built-up                 | `land`           | `residential` | `land-residential`     |
| Bare / sparse vegetation | `land`           | `bare_rock`   | `land-rock`            |
| Moss and lichen          | `land`           | `heath`       | `land-vegetation`      |
| Shrubland                | `land`           | `scrub`       | `land-vegetation`      |
| Grassland                | `land`           | `grassland`   | `land-grass`           |
| Herbaceous wetland       | `land`           | `marsh`       | `land-wetland`         |
| Mangroves                | `land`           | `swamp`       | `land-wetland`         |
| Snow and ice             | `water_polygons` | `glacier`     | `land-glacier`         |
| Permanent water          | `water_polygons` | `water`       | `water-area`           |

**Sea.** The sea is a hole. The land cover ends at OSM's coastline, and OSM's `ocean` layer fills the rest.

**OSM land use.** OSM's land use is burned into ESA's classes before the tiles are generalized. Since version 4, the
container is therefore also subject to OSM's licence, the [ODbL](https://opendatacommons.org/licenses/odbl/). Its
attribution names both ESA and OSM.

**What changed since version 3.** The outlines are rounder and the patches kept at low zooms are smaller, z0–2 read a
finer raster, and OSM's land use is burned in. Measured results are in [TUNING.md](TUNING.md).

The layer names and kinds are still Shortbread's. A dedicated `landcover` layer was discussed, but this build does not
have one (see [Open decisions](#open-decisions)).

## How a style draws it

The stacked style has two vector sources: plain OSM, **without** merged land cover, and `landcover-vectors`. The draw
order is:

1. `background`
2. the land cover fills
3. `water-ocean`
4. the stock OSM layers, unchanged

Each land cover layer is a copy of the stock fill with its colour and filter, and with these changes:

- `source` is the land cover source.
- `id` gets a prefix, for example `landcover-land-forest`.
- `minzoom` is removed, so it draws from z0.
- `fill-opacity` is replaced by this fade:

```json
["interpolate", ["linear"], ["zoom"], 12, 1, 14, 0.25]
```

So the land cover is opaque up to z12, fades to 25 % by z14, and stays at 25 % above that. It never disappears
completely, so land OSM doesn't map keeps a hint of colour.

No merge and no `vector_filter_features` are needed. Lakes need no special handling either: from z4, OSM's lakes draw
above the land cover's `water`, which still shows where OSM has no lake.

The reference implementation is `stackedStyle` in [`lib/style-versatiles.ts`](../lib/style-versatiles.ts). It copies
all 19 fills on those two layers, but only the 9 in the table above can match anything in this container. The real
implementation should copy only those 9.

## Changes in other repositories

Findings come from reading each repository's current state. Nothing below has been tried in those repositories.

### versatiles-style (required)

`features.landcover` currently means "the tiles are a merge": it removes the fade-ins of the stock layers, and adds
no source. The stacked style needs:

- A way to name the land cover source and switch to stacking, in `osm()`. It should insert the 9 layers before
  `water-ocean`, add the source, and apply the fade.
- Stock OSM layers that stay unchanged when stacking.
- The existing `features.landcover: true` kept for now, because the public `osm` tiles remain a merge until
  tiles.versatiles.org changes.
- `osm.supportsLandcover(tileJSON)` kept for the merged case. It says nothing about a separate source.
- A check of `guessStyle`, which builds a style from a single tileset.
- Tests, and the matching sections of `API_DESIGN.md`.

### tiles.versatiles.org (required)

`/tiles/osm/` is served from the merged `osm-landcover.versatiles`, and `landcover-vectors` isn't served at all: its
`tiles.json` returns 404. In `download/sources.json`:

- Add `landcover-vectors` as a served dataset.
- Later, serve `osm` from plain `osm.versatiles` by removing `"source": "osm-landcover"`.
- Update `tests/expected` and the README.

**Order matters.** Switching `osm` to plain tiles removes the land cover at z0–10 for every client whose style still
expects the merge. So first serve `landcover-vectors`, then release and roll out the new style, and only then switch
`osm`. Stacked over today's merged `osm`, the land cover would be drawn twice, with the merged copy on top.

### download.versatiles.org (required)

- **Publishing** follows `docs/runbook.md`. Put the file on the Storage Box as
  `download/landcover-vectors/landcover-vectors.versatiles`, with its `.md5` and `.sha256`, and start the Update
  workflow or wait for the 20th. At 4.5 GB it is below the workflow's 80 GB limit. This name replaces version 3 in
  place; a name with a date would keep it available.
- **`src/lib/file/datasets.ts`:** the `landcover-vectors` entry credits only ESA and needs OSM and the ODbL added. Its
  description points users to the merge, and should mention stacking.
- **`osm-landcover`:** on the Storage Box it is dated 2026-07-04, so it predates version 4. It needs either a rebuild
  or a retirement (see [Open decisions](#open-decisions)).

### versatiles-documentation (required)

`compendium/specification_shortbread_landcover.md` describes only the merge and needs the stacked variant. Its filter
is also out of date: it drops the land cover's `residential` from z10, while the current one drops it from z11.

### landcover-vectors (this repository)

- **README:** the size (~4.7 GB) and the introduction, which describes the merge as the way to use the data.
- **`npm run verify-merge`:** on this build it fails with 7 `overlap` problems, all `land/residential` at z10. The
  README documents exactly that overlap as intended, while the check still expects one source per kind. So the check
  needs updating; nothing suggests the data is wrong. It only concerns the merge, not stacking.
- **Dev views:** `stacked` and `stacked-fade` can go once versatiles-style has the feature.

### Not checked

These may expose `features.landcover` or assume a single vector source. They need a look once the style's API is
settled: versatiles-frontend, maplibre-versatiles-styler, editor, maputnik, node-versatiles-svelte,
versatiles-svg-renderer, versatiles-studio, playground and versatiles-org.github.io.

## Open decisions

1. **Keep the merged `osm-landcover`?** Retiring it after the switch saves a 69 GB rebuild for each release, but users
   who download it lose the land cover at low zooms unless they also take the second file and the new style. If it
   stays, it needs a rebuild with version 4 and a fixed `verify-merge`.
2. **Keep Shortbread's layers and kinds?** They let the merge keep working and need no rebuild. A single `landcover`
   layer with its own kinds would be cleaner for stacking, but it needs a full rebuild and breaks the merge. It is
   cheaper to decide before clients depend on the separate source.
3. **Replace version 3 in place, or publish with a date?** Replacing is what has been done so far. A dated name keeps
   version 3 available while `osm-landcover` still contains older data.

## Suggested order

1. Upload version 4 and publish it on download.versatiles.org, with the corrected attribution.
2. Push `main` of this repository.
3. Serve `landcover-vectors` on tiles.versatiles.org.
4. Release versatiles-style with stacking, and update the documentation.
5. Roll out the new styles, then switch `/tiles/osm/` to plain OSM.
6. Rebuild or retire `osm-landcover`.
