# trackfix

CLI utility that fixes a corrupted GPX track by snapping every point onto a reference template polyline.

## How it works

1. **Project (progressive)** — each broken point is searched only within a forward window on the template, preventing early points from snapping to a physically-nearby finish area.
2. **Monotone pass** — projected arc-distances are forced to be non-decreasing, so the output track never goes backwards.
3. **Redistribute clusters** — if several points collapse to the same location, they are spread proportionally to their original timestamps up to the next distinct point.

Elevations (`<ele>`) and timestamps (`<time>`) from `broken/` are preserved unchanged.
Template files are never modified.

## File layout

```
trackfix/
├── app.ts              # all source code
├── sea-config.json     # Node SEA build config
├── build-exe.ps1       # Windows exe build script
├── templates/          # reference tracks  ← add manually
│   ├── 1.gpx
│   └── 2.gpx
├── broken/             # corrupted tracks  ← add manually
│   ├── track_a.gpx
│   └── track_b.gpx
├── fixed/              # results (auto-created, mirrors broken/)
│   ├── track_a.gpx
│   └── track_b.gpx
├── package.json
└── tsconfig.json
```

`templates/`, `broken/`, `fixed/` are always resolved relative to the app — next to `app.ts` when using ts-node, next to `trackfix.exe` when running the executable.

## Classes

| Class | Responsibility |
|---|---|
| `TemplateTrack` | Holds the reference polyline. `projectFrom(pt, from, window)` → windowed projection. `positionAt(d)` → lat/lon at arc-distance. |
| `TrackFixer` | Three passes: progressive project → monotone → redistribute clusters. |
| `GpxReader` | Parses GPX via `fast-xml-parser`, returns point array and raw XML tree. |
| `GpxWriter` | Deep-clones the raw tree, patches `<trkpt>` nodes, serialises back to XML. |

## Setup & usage (Node.js / ts-node)

```bash
npm install
```

Place your template(s) in `templates/` and corrupted files in `broken/`, then:

```bash
npm run fix -- -t 1          # uses templates/1.gpx
npm run fix -- -t myroute    # uses templates/myroute.gpx
```

All `.gpx` files from `broken/` are processed. Results go to `fixed/` with the same filenames.

## Building a Windows executable (from Linux)

Requires Node.js 20+ and `osslsigncode`:

```bash
sudo apt install osslsigncode
npm run build:exe
```

`build-exe.sh` does the following:
1. Downloads the matching `node.exe` (Windows x64) from nodejs.org
2. Bundles `app.ts` + dependencies into `bundle.js` via esbuild
3. Generates `sea-prep.blob` via Node SEA
4. Strips the Microsoft signature from `node.exe` with `osslsigncode`
5. Injects the blob into `trackfix.exe` with `postject`

The resulting `trackfix.exe` is standalone — no Node.js needed on the target machine.
Place `templates/` and `broken/` next to the exe and run:

```
trackfix.exe -t 1
```

A console window opens, shows progress, and closes when done.

## Configuration

In `app.ts`:

```ts
const CONFIG = {
  clusterThresholdMeters: 1.0,   // redistribution threshold
  progressiveWindowMeters: 500,  // forward search window; increase for tracks with large GPS jumps
  coordPrecision: 6,             // decimal places in output coordinates
};
```
