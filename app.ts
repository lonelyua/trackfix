import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

// ============================================================
//  CONFIGURATION
// ============================================================

const CONFIG = {
  /**
   * Two projected points closer than this (metres) are considered a "cluster"
   * and will be redistributed along the template proportionally to their timestamps.
   */
  clusterThresholdMeters: 1.0,

  /** Decimal places written to lat/lon in the output file. */
  coordPrecision: 6,
} as const;

// ============================================================
//  TYPES
// ============================================================

interface GpxPoint {
  lat: number;
  lon: number;
  ele?: number;
  time?: string;
}

/** A GpxPoint augmented with its arc-distance along the template track (metres). */
interface ProjectedPoint extends GpxPoint {
  templateDist: number;
}

// ============================================================
//  GEO MATH  (flat-Earth approximation per-segment, accurate enough for city-scale tracks)
// ============================================================

const EARTH_R = 6_371_000; // metres

function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Haversine distance in metres between two lat/lon points. */
function haversine(a: GpxPoint, b: GpxPoint): number {
  const dLat = deg2rad(b.lat - a.lat);
  const dLon = deg2rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(a.lat)) * Math.cos(deg2rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

type Vec2 = [number, number];

/**
 * Convert a lat/lon point to a local 2-D Cartesian vector (metres)
 * relative to `origin`. Cheap and accurate for small distances.
 */
function toXY(p: GpxPoint, origin: GpxPoint): Vec2 {
  const cosLat = Math.cos(deg2rad(origin.lat));
  return [
    deg2rad(p.lon - origin.lon) * EARTH_R * cosLat,
    deg2rad(p.lat - origin.lat) * EARTH_R,
  ];
}

/** Inverse of toXY. */
function fromXY([x, y]: Vec2, origin: GpxPoint): GpxPoint {
  const cosLat = Math.cos(deg2rad(origin.lat));
  return {
    lat: origin.lat + (y / EARTH_R) * (180 / Math.PI),
    lon: origin.lon + (x / (EARTH_R * cosLat)) * (180 / Math.PI),
  };
}

/**
 * Project point `p` onto the segment A→B.
 * Returns t ∈ [0, 1] and the closest point on the segment.
 */
function projectOntoSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; closest: Vec2 } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { t: 0, closest: a };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  return { t, closest: [a[0] + t * dx, a[1] + t * dy] };
}

// ============================================================
//  TEMPLATE TRACK
// ============================================================

/**
 * Represents the reference polyline read from `template.gpx`.
 *
 * Responsibilities:
 *   - `project(query)` — find the closest point on the polyline, return
 *     its arc-distance from the start and the snapped lat/lon.
 *   - `positionAt(d)` — reverse lookup: arc-distance → lat/lon.
 */
class TemplateTrack {
  private readonly pts: GpxPoint[];
  /** Cumulative arc-distance (metres) at each waypoint index. */
  private readonly cumDist: number[];
  readonly totalLength: number;
  /** Local Cartesian origin (first point of the polyline). */
  private readonly origin: GpxPoint;

  constructor(pts: GpxPoint[]) {
    if (pts.length < 2) throw new Error('Template track must have at least 2 points');
    this.pts = pts;
    this.origin = pts[0];

    this.cumDist = [0];
    for (let i = 1; i < pts.length; i++) {
      this.cumDist.push(this.cumDist[i - 1] + haversine(pts[i - 1], pts[i]));
    }
    this.totalLength = this.cumDist[this.cumDist.length - 1];
  }

  /**
   * Find the closest point on the polyline to `query`.
   * Returns:
   *   `arcDist` — metres from the track start to the closest point.
   *   `snapped` — lat/lon of that closest point.
   */
  project(query: GpxPoint): { arcDist: number; snapped: GpxPoint } {
    const pXY = toXY(query, this.origin);

    let bestSqDist = Infinity;
    let bestArcDist = 0;
    let bestXY: Vec2 = [0, 0];

    for (let i = 0; i < this.pts.length - 1; i++) {
      const aXY = toXY(this.pts[i], this.origin);
      const bXY = toXY(this.pts[i + 1], this.origin);

      const { t, closest } = projectOntoSegment(pXY, aXY, bXY);
      const sqDist = (pXY[0] - closest[0]) ** 2 + (pXY[1] - closest[1]) ** 2;

      if (sqDist < bestSqDist) {
        bestSqDist = sqDist;
        const segLen = haversine(this.pts[i], this.pts[i + 1]);
        bestArcDist = this.cumDist[i] + t * segLen;
        bestXY = closest;
      }
    }

    return { arcDist: bestArcDist, snapped: fromXY(bestXY, this.origin) };
  }

  /**
   * Convert an arc-distance back to lat/lon.
   * Clamps `d` to [0, totalLength].
   */
  positionAt(d: number): GpxPoint {
    d = Math.max(0, Math.min(this.totalLength, d));

    // Binary-search for the segment that contains d.
    let lo = 0;
    let hi = this.pts.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cumDist[mid] <= d) lo = mid;
      else hi = mid - 1;
    }

    const segLen = this.cumDist[lo + 1] - this.cumDist[lo];
    const t = segLen > 0 ? (d - this.cumDist[lo]) / segLen : 0;

    const aXY = toXY(this.pts[lo], this.origin);
    const bXY = toXY(this.pts[lo + 1], this.origin);
    const xy: Vec2 = [aXY[0] + t * (bXY[0] - aXY[0]), aXY[1] + t * (bXY[1] - aXY[1])];

    return fromXY(xy, this.origin);
  }
}

// ============================================================
//  TRACK FIXER
// ============================================================

/**
 * Snaps every point of a broken track onto the reference template polyline.
 *
 * Algorithm (three passes):
 *
 *  1. **Project** — each broken point is independently projected onto the
 *     nearest location on the template polyline.
 *
 *  2. **Monotone** — the resulting arc-distances are forced to be
 *     non-decreasing, so the output track never "goes backwards".
 *
 *  3. **Redistribute** — after the monotone pass, groups of points that
 *     collapsed to the same location are spread between the surrounding
 *     anchor positions, proportionally to their original timestamps.
 */
class TrackFixer {
  private readonly track: TemplateTrack;

  /**
   * Points whose projected arc-distances differ by less than this value (metres)
   * are considered a cluster and will be redistributed.
   */
  clusterThreshold: number;

  constructor(templatePoints: GpxPoint[], clusterThreshold = CONFIG.clusterThresholdMeters) {
    this.track = new TemplateTrack(templatePoints);
    this.clusterThreshold = clusterThreshold;
  }

  /** Total length of the template track in metres. */
  get templateLength(): number {
    return this.track.totalLength;
  }

  /**
   * Fix `brokenPoints` and return a new array of points snapped onto the template.
   * Original `ele` and `time` values are preserved unchanged.
   */
  fix(brokenPoints: GpxPoint[]): GpxPoint[] {
    const projected = this.projectAll(brokenPoints);  // pass 1
    this.enforceMonotone(projected);                   // pass 2
    this.redistributeClusters(projected);              // pass 3

    return projected.map(p => {
      const { lat, lon } = this.track.positionAt(p.templateDist);
      return { ...p, lat, lon };
    });
  }

  // ---- Pass 1: project ----

  private projectAll(pts: GpxPoint[]): ProjectedPoint[] {
    return pts.map(p => {
      const { arcDist } = this.track.project(p);
      return { ...p, templateDist: arcDist };
    });
  }

  // ---- Pass 2: monotone ----

  private enforceMonotone(pts: ProjectedPoint[]): void {
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].templateDist < pts[i - 1].templateDist) {
        pts[i].templateDist = pts[i - 1].templateDist;
      }
    }
  }

  // ---- Pass 3: redistribute clusters ----

  /**
   * Scan for runs of consecutive points all within `clusterThreshold` metres
   * of the first point in the run.  Each such cluster is then redistributed
   * into the gap between the preceding anchor and the following anchor,
   * with positions assigned proportionally to the points' timestamps.
   */
  private redistributeClusters(pts: ProjectedPoint[]): void {
    let i = 0;
    while (i < pts.length) {
      // Grow the cluster: keep adding points while they are within threshold of pts[i]
      let j = i + 1;
      while (j < pts.length && pts[j].templateDist - pts[i].templateDist < this.clusterThreshold) {
        j++;
      }

      if (j - i > 1) {
        // Spread the cluster from its own projected position to the next distinct position.
        // Using pts[i].templateDist (not the previous anchor) keeps the first cluster
        // point at its natural projection and avoids overlap with pts[i-1].
        const startDist = pts[i].templateDist;
        const endDist = j < pts.length ? pts[j].templateDist : this.track.totalLength;

        const fractions = this.timeFractions(pts.slice(i, j));
        for (let k = i; k < j; k++) {
          pts[k].templateDist = startDist + fractions[k - i] * (endDist - startDist);
        }
      }

      i = j;
    }
  }

  /**
   * Compute normalised [0..1] fractions for a set of points based on their timestamps.
   * Falls back to uniform distribution when timestamps are absent or all identical.
   */
  private timeFractions(pts: ProjectedPoint[]): number[] {
    const n = pts.length;
    if (n === 1) return [0];

    const ms = pts.map(p => (p.time ? Date.parse(p.time) : NaN));
    const allValid = ms.every(v => !isNaN(v));

    if (allValid) {
      const t0 = ms[0];
      const span = ms[n - 1] - t0;
      if (span > 0) return ms.map(t => (t - t0) / span);
    }

    // Fallback: uniform spacing
    return Array.from({ length: n }, (_, k) => k / (n - 1));
  }
}

// ============================================================
//  GPX READER
// ============================================================

/**
 * Parses a GPX file and extracts track points from the first track segment.
 * Preserves the full parsed tree (`raw`) so the writer can clone and patch it.
 */
class GpxReader {
  private readonly parser: XMLParser;

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseAttributeValue: true,
      // Always treat <trkpt> as an array, even when there is only one point
      isArray: (name: string) => name === 'trkpt',
    });
  }

  read(xml: string): { points: GpxPoint[]; raw: unknown } {
    const raw = this.parser.parse(xml);
    const trkpts = this.getTrkpts(raw);

    const points: GpxPoint[] = trkpts.map((pt: any) => ({
      lat: Number(pt['@_lat']),
      lon: Number(pt['@_lon']),
      ele: pt.ele != null ? Number(pt.ele) : undefined,
      time: pt.time != null ? String(pt.time) : undefined,
    }));

    return { points, raw };
  }

  private getTrkpts(parsed: any): any[] {
    const gpx = parsed.gpx;
    const trk = Array.isArray(gpx.trk) ? gpx.trk[0] : gpx.trk;
    const seg = Array.isArray(trk.trkseg) ? trk.trkseg[0] : trk.trkseg;
    const pts = seg.trkpt;
    return Array.isArray(pts) ? pts : [pts];
  }
}

// ============================================================
//  GPX WRITER
// ============================================================

/**
 * Patches the parsed GPX tree with new point coordinates and serialises it back to XML.
 * All original GPX metadata, namespaces, and attributes are preserved.
 */
class GpxWriter {
  private readonly builder: XMLBuilder;

  constructor() {
    this.builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      format: true,
      indentBy: '\t',
      suppressEmptyNode: true,
    });
  }

  /**
   * @param rawTemplate  The parsed tree from GpxReader (will be deep-cloned).
   * @param fixedPoints  New point array to inject.
   */
  write(rawTemplate: unknown, fixedPoints: GpxPoint[]): string {
    const out: any = JSON.parse(JSON.stringify(rawTemplate));

    // fast-xml-parser includes the XML declaration as "?xml" in the tree.
    // Remove it so we don't get a duplicate when we prepend it manually below.
    delete out['?xml'];

    const gpx = out.gpx;
    const trk = Array.isArray(gpx.trk) ? gpx.trk[0] : gpx.trk;
    const seg = Array.isArray(trk.trkseg) ? trk.trkseg[0] : trk.trkseg;

    seg.trkpt = fixedPoints.map(p => {
      const node: any = {
        '@_lat': p.lat.toFixed(CONFIG.coordPrecision),
        '@_lon': p.lon.toFixed(CONFIG.coordPrecision),
      };
      if (p.ele != null) node.ele = p.ele;
      if (p.time != null) node.time = p.time;
      return node;
    });

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + this.builder.build(out);
  }
}

// ============================================================
//  ENTRY POINT
// ============================================================

function parseArgs(): { templateName: string } {
  const args = process.argv.slice(2);
  const tIdx = args.indexOf('-t');
  if (tIdx === -1 || !args[tIdx + 1]) {
    console.error('Usage: npm run fix -- -t <template-name>');
    console.error('Example: npm run fix -- -t 1');
    process.exit(1);
  }
  return { templateName: args[tIdx + 1] };
}

/**
 * Resolve a directory path: env var → local subfolder → error.
 * Returns the resolved path without checking existence (caller decides).
 */
function resolveDir(envVar: string, fallbackName: string, root: string): string {
  const fromEnv = process.env[envVar];
  return fromEnv ? path.resolve(fromEnv) : path.join(root, fallbackName);
}

function requireDir(dirPath: string, envVar: string, fallbackName: string): void {
  if (!fs.existsSync(dirPath)) {
    console.error(`Directory not found: ${dirPath}`);
    console.error(`  → set ${envVar} in .env, or create a "${fallbackName}/" folder here`);
    process.exit(1);
  }
}

function main(): void {
  const { templateName } = parseArgs();
  const root = path.resolve(__dirname);

  const templatesDir = resolveDir('TEMPLATES_DIR', 'templates', root);
  const brokenDir    = resolveDir('BROKEN_DIR',    'broken',    root);
  const fixedDir     = resolveDir('FIXED_DIR',     'fixed',     root);

  requireDir(templatesDir, 'TEMPLATES_DIR', 'templates');
  requireDir(brokenDir,    'BROKEN_DIR',    'broken');

  // Resolve template file: accept "1", "1.gpx", etc.
  const templateFile = templateName.endsWith('.gpx') ? templateName : `${templateName}.gpx`;
  const templatePath = path.join(templatesDir, templateFile);

  if (!fs.existsSync(templatePath)) {
    console.error(`Template not found: ${templatePath}`);
    console.error(`  → check the file exists in ${templatesDir}`);
    process.exit(1);
  }

  fs.mkdirSync(fixedDir, { recursive: true });

  // Load and parse template
  const reader = new GpxReader();
  const { points: templatePts } = reader.read(fs.readFileSync(templatePath, 'utf-8'));
  const fixer = new TrackFixer(templatePts);

  console.log(`Template: ${templateFile} — ${templatePts.length} points, length ${Math.round(fixer.templateLength)} m`);

  // Process all .gpx files in broken/
  const brokenFiles = fs.readdirSync(brokenDir).filter(f => f.toLowerCase().endsWith('.gpx'));

  if (brokenFiles.length === 0) {
    console.log('No .gpx files found in broken/');
    return;
  }

  console.log(`Processing ${brokenFiles.length} file(s)...\n`);

  const writer = new GpxWriter();
  let ok = 0;
  let fail = 0;

  for (const filename of brokenFiles) {
    const brokenPath = path.join(brokenDir, filename);
    const fixedPath  = path.join(fixedDir, filename);
    try {
      const { points: brokenPts, raw: brokenRaw } = reader.read(fs.readFileSync(brokenPath, 'utf-8'));
      const fixedPts = fixer.fix(brokenPts);
      fs.writeFileSync(fixedPath, writer.write(brokenRaw, fixedPts), 'utf-8');
      console.log(`  ✓ ${filename}  (${brokenPts.length} → ${fixedPts.length} pts)`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${filename}  ERROR: ${(err as Error).message}`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} fixed, ${fail} failed → ${fixedDir}`);
}

main();
