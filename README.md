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
├── app.ts              # all source code
├── templates/          # reference tracks (add manually)
│   ├── 1.gpx
│   └── 2.gpx
├── broken/             # corrupted tracks to process (add manually)
│   ├── track_a.gpx
│   └── track_b.gpx
├── fixed/              # results (generated, mirrors broken/)
│   ├── track_a.gpx
│   └── track_b.gpx
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

### Directory paths

By default the app looks for `templates/`, `broken/`, and `fixed/` subfolders in the project root. You can point them anywhere by creating a `.env` file (see `.env.example`):

```dotenv
TEMPLATES_DIR=/path/to/my/templates
BROKEN_DIR=/path/to/my/broken
FIXED_DIR=/path/to/my/fixed
```

If a variable is not set, the app falls back to the local subfolder. If the folder doesn't exist, it prints a clear error with a hint.

### Running

```bash
npm run fix -- -t 1          # uses templates/1.gpx
npm run fix -- -t myroute    # uses templates/myroute.gpx
```

All `.gpx` files from `broken/` are processed against the chosen template.
Results are written to `fixed/` with the same filenames. The `fixed/` directory is created automatically.

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
