# trackfix

CLI utility that fixes a corrupted GPX track by snapping every point onto a reference template polyline.

## How it works

1. **Project** — each point in `broken.gpx` is independently projected onto the nearest location on the `template.gpx` polyline.
2. **Monotone pass** — projected arc-distances are forced to be non-decreasing, so the output track never goes backwards.
3. **Redistribute clusters** — if several points end up at the same location after projection (closer than `clusterThreshold`), they are spread proportionally to their original timestamps up to the next distinct point.

Elevations (`<ele>`) and timestamps (`<time>`) from `broken.gpx` are preserved unchanged.
`template.gpx` is never modified.

## File layout

```
trackfix/
├── app.ts          # all source code
├── template.gpx    # reference track (add manually)
├── broken.gpx      # corrupted track (add manually)
├── fixed.gpx       # output (generated)
├── package.json
└── tsconfig.json
```

## Classes

| Class | Responsibility |
|---|---|
| `TemplateTrack` | Holds the reference polyline. `project(pt)` → arc-distance + snapped coordinates. `positionAt(d)` → lat/lon at a given arc-distance. |
| `TrackFixer` | Core logic. Three passes: project → enforce monotone → redistribute clusters. Exposes `clusterThreshold` (default 1 m). |
| `GpxReader` | Parses GPX via `fast-xml-parser`, returns point array and raw XML tree. |
| `GpxWriter` | Deep-clones the raw tree, patches `<trkpt>` nodes, serialises back to XML. |

## Setup & usage

```bash
npm install
```

Place `template.gpx` and `broken.gpx` in the project root, then:

```bash
npm start
```

The result is written to `fixed.gpx` in the same directory.

To compile to plain JS:

```bash
npm run build
# → dist/app.js
```

## Configuration

At the top of `app.ts`:

```ts
const CONFIG = {
  clusterThresholdMeters: 1.0,  // points closer than this are redistributed
  coordPrecision: 6,            // decimal places in output coordinates
};
```

The threshold can also be overridden per instance:

```ts
const fixer = new TrackFixer(templatePts, 2.5); // 2.5 m threshold
```
