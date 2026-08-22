import { mulberry32, range, type Rng } from './rng';
import type { TreeKind } from './types';

export interface TreeStroke {
  points: { x: number; y: number }[];
  widthStart: number;
  widthEnd: number;
  kind: 'wood' | 'root' | 'tuft' | 'twig' | 'grass';
  /** 0..1 maturity when this stroke begins to extend. */
  emerge?: number;
  /** 0..1 maturity span over which the stroke reaches full length. */
  span?: number;
}

export interface TreeFlower {
  x: number;
  y: number;
  angle: number;
  size: number;
  emerge?: number;
  span?: number;
}

/**
 * Unscaled bloom size (× tree scale). Petals span about this in world units.
 * Must stay larger than a flying seed hull (~3.6 in seedlingView).
 */
export const FLOWER_SIZE_MIN = 11;
export const FLOWER_SIZE_SPREAD = 5;

export interface TreeTip {
  x: number;
  y: number;
  angle: number;
  emerge?: number;
}

export interface TreeBlob {
  x: number;
  y: number;
  r: number;
  alpha: number;
  emerge?: number;
  span?: number;
}

export interface TreeLeaf {
  x: number;
  y: number;
  angle: number;
  length: number;
  width: number;
  emerge?: number;
  span?: number;
}

export interface TreeCollar {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

export interface TreeGeom {
  strokes: TreeStroke[];
  flowers: TreeFlower[];
  tips: TreeTip[];
  blobs: TreeBlob[];
  leaves: TreeLeaf[];
  collar: TreeCollar;
  /** Tree-local core well Y (for live feed during reveal). */
  coreY: number;
  /** Tree-local surface Y. */
  surfaceY: number;
}

type Pt = { x: number; y: number };

/**
 * A subsurface pocket already converted into tree-local coordinates so the
 * L-system can fork a root toward it. Use `soilFor` to build these from an
 * asteroid + plant pose so the geometry stays deterministic for
 * `(treeSeed, asteroidSeed)` and identical between sim and renderer.
 */
export interface PocketTarget {
  /** Tree-local position of the pocket. */
  x: number;
  y: number;
  /**
   * 0..1 along the inward direction (tree-local +y). Drives the seek
   * curve's depth bias so deep pockets pull the tip further in.
   */
  depthT: number;
  /** Flag for the renderer (root hue, miner / water / energy tone). */
  kind: 'mineral' | 'water' | 'energy';
}

/**
 * Everything the root system needs to know about the rock it is burrowing
 * through. Tree-local: the rock centre sits at `(0, coreDepth)` by
 * construction, so only the radius has to travel with the pockets.
 */
export interface SoilContext {
  pockets: PocketTarget[];
  /** Mean rock radius, tree-local units. Tendrils never breach it. */
  rockRadius: number;
}

/**
 * How far a root will burrow for a pocket, as a multiple of rock radius,
 * measured from the tendril's anchor on the existing root system. Above
 * ~1.0 a tree reaches past the core into the far hemisphere; the cap keeps
 * the far crust out of reach so where a tree is planted still matters.
 */
export const POCKET_SEEK_REACH = 1.35;

/** Hard cap on burrowing tendrils per tree, for geometry cost. */
export const POCKET_SEEK_MAX = 8;

/** Fraction of the rock radius a burrowing tendril may not pass outward. */
const SEEK_RIM_LIMIT = 0.9;

/**
 * Convert an asteroid's subsurface pockets into the tree's local frame.
 * Structurally typed so simulation and renderer can both call it without
 * dragging the full `Asteroid` type (and its Pixi-free constraints) here.
 *
 * The tree frame is rotated by `pose.angle + PI/2` and translated to the
 * collar, which puts the rock centre at `(0, pose.dist)`.
 */
export function soilFor(
  rock: {
    x: number;
    y: number;
    radius: number;
    pockets: readonly {
      angle: number;
      radiusT: number;
      depthT: number;
      kind: 'mineral' | 'water' | 'energy';
    }[];
  },
  pose: { x: number; y: number; angle: number },
): SoilContext {
  const rot = pose.angle + Math.PI / 2;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const ox = pose.x - rock.x;
  const oy = pose.y - rock.y;
  const pockets: PocketTarget[] = [];
  for (const pocket of rock.pockets) {
    const pr = pocket.radiusT * rock.radius;
    const tx = Math.cos(pocket.angle) * pr - ox;
    const ty = Math.sin(pocket.angle) * pr - oy;
    pockets.push({
      x: tx * cos - ty * sin,
      y: tx * sin + ty * cos,
      depthT: pocket.depthT,
      kind: pocket.kind,
    });
  }
  return { pockets, rockRadius: rock.radius };
}

/**
 * One living plant: wood grows from the collar into the canopy, while
 * searching roots hunt the core. `maturity` extends length and thickens
 * wood/roots toward the baked adult silhouette.
 */
export function buildTree(
  seed: number,
  maturity: number,
  scale = 1,
  coreDepth = 70,
  surfaceY = 0,
  kind?: TreeKind,
): TreeGeom {
  return growTree(
    buildAdultTree(seed, scale, coreDepth, surfaceY, kind),
    maturity,
  );
}

export function buildAdultTree(
  seed: number,
  scale = 1,
  coreDepth = 70,
  surfaceY = 0,
  kind?: TreeKind,
  soil?: SoilContext,
): TreeGeom {
  const rng = mulberry32(seed >>> 0);
  const strokes: TreeStroke[] = [];
  const flowers: TreeFlower[] = [];
  const tips: TreeTip[] = [];
  const blobs: TreeBlob[] = [];
  const leaves: TreeLeaf[] = [];

  const curl = range(rng, 0.07, 0.15);
  const droop = range(rng, 0.03, 0.14);
  const spread = range(rng, 0.4, 0.62);
  const lean = range(rng, -0.16, 0.16);
  const bend = range(rng, 0.05, 0.3);
  const height = scale * 148;
  const collarW = 5.2 * scale;
  const twigW = Math.max(0.45, 0.52 * scale);
  const woodDepth = 4;
  const coreY = coreDepth;
  const collarX = range(rng, -1.8, 1.8);
  const collarPt: Pt = { x: collarX, y: surfaceY };

  const woodEmerge = 0;
  const woodSpan = 0.58;
  const rootEmerge = 0;
  const rootSpan = 0.45;
  const canopyPts = growRay(rng, collarPt, height, lean, curl, bend, false);

  strokes.push({
    points: canopyPts,
    widthStart: collarW * 1.55,
    widthEnd: Math.max(twigW * 1.8, collarW * 0.22),
    kind: 'wood',
    emerge: woodEmerge,
    span: woodSpan,
  });

  growNervousRoots(
    rng,
    collarPt,
    { x: range(rng, -2.2, 2.2) * scale, y: coreY },
    collarW,
    scale,
    kind === 'energy',
    rootEmerge,
    rootSpan,
    strokes,
  );

  // Pocket-seeking offshoots: tendrils that fork from the main root system
  // and burrow through the soil to each reachable subsurface pocket, so the
  // connection reads as a root that actually went looking for the resource
  // instead of a painted line across the rock. Caller passes pockets already
  // converted into tree-local space (= `soilFor`) so the geometry stays
  // deterministic for a given tree seed + asteroid seed.
  growPocketSeekers(rng, scale, soil, coreY, rootEmerge, rootSpan, strokes);

  const laterals = 2 + Math.floor(rng() * 2);
  spawnLaterals(
    rng,
    canopyPts,
    laterals,
    spread,
    curl,
    droop,
    false,
    0,
    woodDepth,
    scale,
    woodEmerge,
    woodSpan,
    coreY,
    strokes,
    flowers,
    tips,
    leaves,
  );

  forkTip(
    rng,
    canopyPts,
    height * (0.34 + rng() * 0.1),
    Math.max(twigW * 2.2, collarW * 0.42),
    curl,
    droop,
    false,
    woodDepth,
    scale,
    woodEmerge + woodSpan * 0.55,
    Math.max(0.18, woodSpan * 0.48),
    coreY,
    strokes,
    flowers,
    tips,
    leaves,
  );

  growScarFlora(rng, surfaceY, scale, strokes);

  paintCanopy(tips, flowers, blobs, leaves, rng, scale);

  const collar: TreeCollar = {
    x: collarX,
    y: surfaceY,
    rx: collarW * 1.35,
    ry: collarW * 1.15,
  };

  return {
    strokes,
    flowers,
    tips,
    blobs,
    leaves,
    collar,
    coreY,
    surfaceY,
  };
}

/** Searching roots that grew from the collar toward the core well. */
export function coreSeekingStrokes(geom: TreeGeom): TreeStroke[] {
  return geom.strokes.filter((s) => s.kind === 'root');
}

/** 0..1 from how close the nearest inward wood tip gets to the well. */
export function measureRootFeed(geom: TreeGeom, coreY: number): number {
  let best = Infinity;
  for (const r of coreSeekingStrokes(geom)) {
    const tip = r.points[r.points.length - 1];
    if (!tip) continue;
    best = Math.min(best, Math.hypot(tip.x, tip.y - coreY));
  }
  if (!Number.isFinite(best)) return 0;
  const fullR = 14;
  const falloff = 36;
  if (best <= fullR) return 1;
  return Math.max(0, 1 - (best - fullR) / falloff);
}

/** Maturity-gated feed: roots must reach the well before energy flows. */
export function rootFeedActive(maturity: number, coreFeed: number): number {
  const m = Math.min(1, Math.max(0, maturity));
  const feed = Math.min(1, Math.max(0, coreFeed));
  return feed * smoothstep(0.32, 0.72, m);
}

/**
 * How ready a tree is to drop seedlings (0 before side tips, 1 at adult).
 * Pass SPAWN_START_MATURITY from types as startMaturity.
 */
export function spawnReadiness(
  maturity: number,
  startMaturity: number,
): number {
  const m = Math.min(1, Math.max(0, maturity));
  if (m < startMaturity) return 0;
  return smoothstep(startMaturity, 1, m);
}

/** Reveal the adult plant from the collar in both directions. */
export function growTree(adult: TreeGeom, maturity: number): TreeGeom {
  const m = Math.min(1, Math.max(0, maturity));
  if (m >= 0.999) return adult;

  /** Global cambium: thickens wood/roots for the whole maturity span. */
  const girth = smoothstep(0.04, 1, m);

  const strokes: TreeStroke[] = [];
  for (const s of adult.strokes) {
    const grown = clipStroke(
      s,
      growthProgress(m, s.emerge ?? 0, s.span ?? 0.58),
      girth,
    );
    if (grown) strokes.push(grown);
  }

  const tips: TreeTip[] = [];
  for (const t of adult.tips) {
    const ready = growthProgress(m, t.emerge ?? 0.62, 0.2);
    if (ready <= 0.02) continue;
    tips.push(t);
  }

  const flowers: TreeFlower[] = [];
  for (const f of adult.flowers) {
    const t = growthProgress(m, f.emerge ?? 0.72, f.span ?? 0.22);
    if (t <= 0.02) continue;
    flowers.push({
      x: f.x,
      y: f.y,
      angle: f.angle,
      size: f.size * (0.12 + 0.88 * t),
    });
  }

  const leaves: TreeLeaf[] = [];
  for (const leaf of adult.leaves) {
    const t = growthProgress(m, leaf.emerge ?? 0.58, leaf.span ?? 0.22);
    if (t <= 0.02) continue;
    leaves.push({
      x: leaf.x,
      y: leaf.y,
      angle: leaf.angle + (1 - t) * 0.55,
      length: leaf.length * (0.12 + 0.88 * t),
      width: leaf.width * (0.2 + 0.8 * t),
    });
  }

  const blobs: TreeBlob[] = [];
  for (const b of adult.blobs) {
    const t = growthProgress(m, b.emerge ?? 0.5, b.span ?? 0.32);
    if (t <= 0.02) continue;
    blobs.push({
      x: b.x,
      y: b.y,
      r: b.r * (0.2 + 0.8 * t),
      alpha: b.alpha * t,
    });
  }

  const collar: TreeCollar = {
    x: adult.collar.x,
    y: adult.collar.y,
    rx: adult.collar.rx * (0.18 + 0.82 * girth),
    ry: adult.collar.ry * (0.16 + 0.84 * girth),
  };

  return {
    strokes,
    flowers,
    tips,
    blobs,
    leaves,
    collar,
    coreY: adult.coreY,
    surfaceY: adult.surfaceY,
  };
}

function growScarFlora(
  rng: Rng,
  surfaceY: number,
  scale: number,
  strokes: TreeStroke[],
): void {
  const tufts = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < tufts; i++) {
    const a = -Math.PI / 2 + range(rng, -0.7, 0.7);
    const len = (2.2 + rng() * 4.2) * scale;
    const ox = range(rng, -3.2, 3.2) * scale;
    const base: Pt = { x: ox, y: surfaceY };
    const pts = curveStroke(rng, base, a, len, 7, 0.48, 0.08, false);
    strokes.push({
      points: pts,
      widthStart: 1.25 * scale,
      widthEnd: 0.45 * scale,
      kind: 'tuft',
      emerge: 0.38 + rng() * 0.18,
      span: 0.16 + rng() * 0.1,
    });
  }

  const grasses = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < grasses; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const a = -Math.PI / 2 + side * range(rng, 0.55, 1.42);
    const len = (3.4 + rng() * 6.8) * scale;
    const ox = side * range(rng, 1.1, 7.8) * scale;
    const base: Pt = { x: ox, y: surfaceY };
    const pts = curveStroke(rng, base, a, len, 9, 0.62, 0.22, false);
    strokes.push({
      points: pts,
      widthStart: 1.08 * scale,
      widthEnd: 0.28 * scale,
      kind: 'grass',
      emerge: 0.42 + rng() * 0.28,
      span: 0.16 + rng() * 0.18,
    });
  }
}

function growRay(
  rng: Rng,
  origin: Pt,
  length: number,
  lean: number,
  curl: number,
  bend: number,
  inward: boolean,
  coreY?: number,
): Pt[] {
  const steps = Math.max(20, Math.round(length / 3.6));
  const points: Pt[] = [];
  let x = origin.x;
  let y = origin.y;
  let wander = 0;
  const dir = rng() < 0.5 ? -1 : 1;
  const waves = range(rng, 0.45, 0.82);
  const phase = range(rng, 0.2, 0.55) * Math.PI;
  const tropism = inward ? Math.PI / 2 : -Math.PI / 2;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({ x, y });
    if (i === steps) break;

    wander += range(rng, -curl, curl) * 0.14;
    wander *= 0.95;
    const sweep = Math.sin(t * waves * Math.PI + phase) * bend * 1.8 * dir;
    let angle = tropism + lean * (0.1 + 0.55 * t) + sweep + wander;
    if (inward && coreY != null) {
      const toCore = Math.atan2(coreY - y, -x);
      const dist = Math.hypot(x, y - coreY);
      const closeness = 1 - Math.min(1, dist / Math.max(1, length));
      angle += shortestAngle(angle, toCore) * (0.05 + 0.22 * closeness * closeness);
    }
    const step = length / steps;
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
    if (inward && y < origin.y) y = origin.y;
    if (inward && coreY != null && y > coreY - 1.2) {
      y = coreY - 1.2;
      points.push({ x, y });
      break;
    }
  }

  return points;
}

function forkTip(
  rng: Rng,
  spine: Pt[],
  length: number,
  width: number,
  curl: number,
  droop: number,
  inward: boolean,
  maxDepth: number,
  scale: number,
  emerge: number,
  span: number,
  coreY: number,
  strokes: TreeStroke[],
  flowers: TreeFlower[],
  tips: TreeTip[],
  leaves: TreeLeaf[],
): void {
  if (spine.length < 2) return;
  const tip = spine[spine.length - 1]!;
  const pre = spine[spine.length - 2]!;
  const tipA = Math.atan2(tip.y - pre.y, tip.x - pre.x);
  const open = 0.28 + rng() * 0.2;
  for (const side of [-1, 1] as const) {
    growBranch(
      rng,
      tip,
      tipA + side * open * (0.88 + rng() * 0.24),
      length * (0.9 + rng() * 0.16),
      width,
      curl,
      droop,
      inward,
      0,
      maxDepth,
      scale,
      emerge,
      span,
      coreY,
      strokes,
      flowers,
      tips,
      leaves,
    );
  }
}

function growNervousRoots(
  rng: Rng,
  collar: Pt,
  core: Pt,
  collarW: number,
  scale: number,
  energyRich: boolean,
  emerge: number,
  span: number,
  roots: TreeStroke[],
): void {
  const reach = Math.hypot(core.x - collar.x, core.y - collar.y);
  const baseAngle = Math.atan2(core.y - collar.y, core.x - collar.x);
  const axonCount = (energyRich ? 6 : 4) + Math.floor(rng() * 2);
  const maxDepth = energyRich ? 3 : 2;

  growNeuronAxon(
    rng,
    collar,
    baseAngle + range(rng, -0.08, 0.08),
    reach * range(rng, 0.94, 1.04),
    collarW * 1.42,
    0,
    maxDepth,
    core,
    reach,
    scale,
    emerge,
    span * 0.92,
    true,
    roots,
  );

  // Side roots fan out well beyond the tap axis: wider angles, with a
  // gentler radial reach so they skirt the crust rather than dropping
  // straight into the well.
  const fanSpread = 1.35;
  const fanBase = 0.45;
  for (let i = 0; i < axonCount; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const t = axonCount > 1 ? i / (axonCount - 1) : 0.5;
    const dive = (fanBase + t * fanSpread) * side + range(rng, -0.06, 0.06);
    const radial = 0.5 + t * 0.45;
    growNeuronAxon(
      rng,
      { x: collar.x, y: collar.y },
      baseAngle + dive,
      reach * (0.48 + radial * 0.42) * range(rng, 0.88, 1.08),
      collarW * range(rng, 0.5, 0.72),
      0,
      maxDepth,
      core,
      reach,
      scale,
      emerge + span * (0.04 + (i / axonCount) * 0.12),
      Math.max(0.16, span * (0.55 + rng() * 0.3)),
      false,
      roots,
    );
  }
}

/**
 * Burrowing root tendrils: for every pocket the tree can reach, fork a
 * tendril off the nearest point of the existing root system and drive it
 * through the soil until it touches the pocket.
 *
 * Three properties make it read as *searching* rather than as a straight
 * wire to a known target:
 *
 *  - the tendril leaves its anchor on the anchor's own heading and only
 *    swings onto the pocket bearing as it closes, so the early run wanders;
 *  - lateral sweep decays with `closeness`, so the wander tightens into a
 *    lock-on over the last third;
 *  - `emerge`/`span` scale with distance, so a growing tree visibly reaches
 *    the near pockets first and is still burrowing toward the far ones at
 *    high maturity.
 *
 * Every point is clamped inside the rock (centre `(0, coreY)`, radius
 * `rockRadius`), so a tendril crossing the disc never surfaces mid-flight.
 * The renderer reads `points` as a normal root stroke, so tendrils inherit
 * the wood→root crossfade and sap flow; the simulation reads their tips as
 * extraction points, so what you see feeding is what feeds.
 */
function growPocketSeekers(
  rng: Rng,
  scale: number,
  soil: SoilContext | undefined,
  coreY: number,
  emerge: number,
  span: number,
  roots: TreeStroke[],
): void {
  if (!soil || soil.pockets.length === 0) return;
  const rootStrokes = roots.filter((s) => s.kind === 'root');
  if (rootStrokes.length === 0) return;

  const rockRadius = soil.rockRadius > 0 ? soil.rockRadius : coreY;
  const maxReach = rockRadius * POCKET_SEEK_REACH;

  // Anchor first, then sort by burrow length: nearest pockets get the
  // earliest emerge windows, and the per-tree cap spends its budget on the
  // tendrils the tree can actually complete.
  const runs: { p: PocketTarget; anchor: Pt; heading: number; reach: number }[] = [];
  const rimLimit = rockRadius * SEEK_RIM_LIMIT;
  for (const p of soil.pockets) {
    // Roots burrow through soil, not through the crust into space. A target
    // outside the rock is unreachable however close it is to a root.
    if (Math.hypot(p.x, p.y - coreY) > rimLimit) continue;
    const anchor = nearestOnStrokes(rootStrokes, p);
    if (!anchor) continue;
    const reach = Math.hypot(p.x - anchor.pt.x, p.y - anchor.pt.y);
    if (reach < 1.5 || reach > maxReach) continue;
    runs.push({ p, anchor: anchor.pt, heading: anchor.heading, reach });
  }
  runs.sort((a, b) => a.reach - b.reach);

  const count = Math.min(runs.length, POCKET_SEEK_MAX);
  for (let i = 0; i < count; i++) {
    const { p, anchor, heading, reach } = runs[i]!;
    const distNorm = Math.min(1, reach / maxReach);

    const steps = Math.max(8, Math.min(72, Math.round(reach / (2.4 * scale))));
    const phase = rng() * Math.PI * 2;
    const waves = range(rng, 0.6, 1.4);
    const amp = range(rng, 0.10, 0.22) * (rng() < 0.5 ? -1 : 1);
    const pts: Pt[] = [{ x: anchor.x, y: anchor.y }];
    let x = anchor.x;
    let y = anchor.y;
    // Leave along the parent root, not straight at the pocket: the turn
    // onto the target bearing is what makes the tendril look like it hunted.
    let a = heading;
    const stepLen = reach / steps;
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const closeness = u * u;
      const sweep = Math.sin(u * waves * Math.PI * 2 + phase) * amp * (1 - closeness);
      const toPocket = Math.atan2(p.y - y, p.x - x);
      a = a + angleDelta(a, toPocket) * (0.12 + 0.5 * closeness) + sweep;
      x += Math.cos(a) * stepLen;
      y += Math.sin(a) * stepLen;
      if (k === steps) {
        x = p.x;
        y = p.y;
      } else {
        const held = holdInsideRock(x, y, coreY, rockRadius, anchor);
        x = held.x;
        y = held.y;
      }
      pts.push({ x, y });
    }

    // Near pockets are tapped early; the far ones are still being burrowed
    // toward past mid-maturity. `depthT` nudges deep pockets a touch later.
    const tipEmerge =
      emerge + span * 0.35 + distNorm * 0.3 + p.depthT * 0.06;
    const tipSpan = Math.max(0.2, 0.28 + distNorm * 0.3);

    // Longer runs carry a slightly thicker trunk — a tendril that crossed
    // the disc had to be a real root, not a hair.
    const baseW = (0.5 + 0.35 * distNorm) * scale;
    roots.push({
      points: pts,
      widthStart: baseW,
      widthEnd: Math.max(0.22 * scale, baseW * 0.4),
      kind: 'root',
      emerge: tipEmerge,
      span: tipSpan,
    });
  }
}

/** Shortest signed turn from `from` to `to`, radians. */
function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Closest point on any of `strokes` to `target`, plus the local heading of
 * the segment it landed on. The heading seeds the tendril so it peels off
 * its parent root instead of teleporting onto the pocket bearing.
 */
function nearestOnStrokes(
  strokes: TreeStroke[],
  target: Pt,
): { pt: Pt; heading: number } | null {
  let bestDist = Infinity;
  let best: { pt: Pt; heading: number } | null = null;
  for (const s of strokes) {
    const pts = s.points;
    if (pts.length < 2) continue;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) continue;
      let t = ((target.x - a.x) * dx + (target.y - a.y) * dy) / len2;
      t = Math.min(1, Math.max(0, t));
      const cx = a.x + dx * t;
      const cy = a.y + dy * t;
      const d = Math.hypot(target.x - cx, target.y - cy);
      if (d < bestDist) {
        bestDist = d;
        best = { pt: { x: cx, y: cy }, heading: Math.atan2(dy, dx) };
      }
    }
  }
  return best;
}

/**
 * Pull a burrowing point back inside the rock. The limit never tightens
 * past where the tendril started, so a tendril anchored high on a root near
 * the crust is not yanked toward the core on its first step.
 */
function holdInsideRock(
  x: number,
  y: number,
  coreY: number,
  rockRadius: number,
  anchor: Pt,
): Pt {
  const anchorDist = Math.hypot(anchor.x, anchor.y - coreY);
  const limit = Math.max(rockRadius * SEEK_RIM_LIMIT, anchorDist);
  const dx = x;
  const dy = y - coreY;
  const d = Math.hypot(dx, dy);
  if (d <= limit || d < 1e-6) return { x, y };
  const k = limit / d;
  return { x: dx * k, y: coreY + dy * k };
}

function growNeuronAxon(
  rng: Rng,
  origin: Pt,
  angle: number,
  length: number,
  widthStart: number,
  depth: number,
  maxDepth: number,
  core: Pt,
  reach: number,
  scale: number,
  emerge: number,
  span: number,
  isTap: boolean,
  roots: TreeStroke[],
): void {
  if (length < 4 * scale || widthStart < 0.28 * scale) return;

  const pts = traceRoot(rng, origin, angle, length, core, reach, scale, isTap);
  if (pts.length < 2) return;

  const end = pts[pts.length - 1]!;
  const tipDist = Math.hypot(core.x - end.x, core.y - end.y);
  const wellR = Math.max(3.5, 5 * scale);
  const reached = tipDist < wellR * 1.8;
  const tipW = Math.max(0.32 * scale, widthStart * (reached ? 0.22 : 0.14));
  roots.push({
    points: pts,
    widthStart,
    widthEnd: tipW,
    kind: 'root',
    emerge,
    span,
  });

  if (reached) {
    growTipFan(rng, pts, tipW, scale, emerge, span, roots);
    return;
  }

  if (depth >= maxDepth) return;

  const pre = pts[pts.length - 2] ?? origin;
  const endAngle = Math.atan2(end.y - pre.y, end.x - pre.x);
  const forkCount = depth === 0 ? 2 : rng() > 0.45 ? 2 : 1;
  for (let k = 0; k < forkCount; k++) {
    const side = k === 0 ? -1 : 1;
    const open =
      (0.16 + rng() * 0.22) * (forkCount === 1 ? (rng() > 0.5 ? 1 : -1) : side);
    growNeuronAxon(
      rng,
      end,
      endAngle + open,
      length * (0.4 + rng() * 0.28) * (isTap ? 0.92 : 1),
      Math.max(0.3 * scale, widthStart * (0.44 + rng() * 0.14)),
      depth + 1,
      maxDepth,
      core,
      reach,
      scale,
      emerge + span * (0.45 + rng() * 0.2),
      Math.max(0.12, span * (0.4 + rng() * 0.2)),
      false,
      roots,
    );
  }
}

/** Gentle S-curve toward the well. Turn is capped so tips cannot orbit. */
function traceRoot(
  rng: Rng,
  origin: Pt,
  angle: number,
  length: number,
  core: Pt,
  reach: number,
  scale: number,
  isTap: boolean,
): Pt[] {
  const stepLen = Math.max(2.8, (isTap ? 4.2 : 3.6) * scale);
  const maxSteps = Math.max(8, Math.round(length / stepLen));
  const pts: Pt[] = [{ x: origin.x, y: origin.y }];
  const waves = range(rng, 0.35, 0.7);
  const phase = range(rng, 0, Math.PI * 2);
  const waveAmp = range(rng, 0.05, 0.12) * (rng() < 0.5 ? -1 : 1);
  const wellR = Math.max(3.5, 5 * scale);
  let x = origin.x;
  let y = origin.y;
  let a = angle;
  let wander = 0;

  for (let i = 1; i <= maxSteps; i++) {
    const t = i / maxSteps;
    const dist = Math.hypot(core.x - x, core.y - y);
    if (dist < wellR) break;

    const proximity = 1 - Math.min(1, dist / Math.max(1e-3, reach));
    const toCore = Math.atan2(core.y - y, core.x - x);
    wander += range(rng, -0.045, 0.045);
    wander *= 0.9;
    const wave = Math.sin(t * waves * Math.PI * 2 + phase) * waveAmp * (1 - proximity);
    let desired = a + wander + wave;
    desired += shortestAngle(desired, toCore) * (0.18 + 0.55 * proximity);

    const maxOff = 0.72 - 0.42 * proximity;
    const off = shortestAngle(toCore, desired);
    if (Math.abs(off) > maxOff) desired = toCore + Math.sign(off) * maxOff;

    const maxTurn = 0.11 + 0.04 * proximity;
    a += clampTurn(shortestAngle(a, desired), maxTurn);

    const step = Math.min(stepLen, dist * 0.42 + 1.4);
    const nx = x + Math.cos(a) * step;
    const ny = Math.max(origin.y, y + Math.sin(a) * step);
    const nextDist = Math.hypot(core.x - nx, core.y - ny);
    if (nextDist > dist && proximity > 0.7) break;
    if (nextDist < wellR) {
      pts.push({ x: nx, y: ny });
      break;
    }
    pts.push({ x: nx, y: ny });
    x = nx;
    y = ny;
  }
  return pts;
}

function growTipFan(
  rng: Rng,
  parent: Pt[],
  width: number,
  scale: number,
  emerge: number,
  span: number,
  roots: TreeStroke[],
): void {
  if (parent.length < 2) return;
  const end = parent[parent.length - 1]!;
  const pre = parent[parent.length - 2]!;
  const endAngle = Math.atan2(end.y - pre.y, end.x - pre.x);
  const n = 2 + Math.floor(rng() * 2);
  for (let k = 0; k < n; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const a = endAngle + side * (0.18 + rng() * 0.22) + range(rng, -0.05, 0.05);
    const len = (5 + rng() * 7) * scale;
    const bend = range(rng, -0.12, 0.12);
    const steps = 5;
    const pts: Pt[] = [{ x: end.x, y: end.y }];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const heading = a + bend * t;
      pts.push({
        x: end.x + Math.cos(heading) * len * t,
        y: end.y + Math.sin(heading) * len * t,
      });
    }
    roots.push({
      points: pts,
      widthStart: Math.max(0.28 * scale, width * 0.7),
      widthEnd: Math.max(0.22 * scale, width * 0.28),
      kind: 'root',
      emerge: emerge + span * 0.72,
      span: Math.max(0.1, span * 0.28),
    });
  }
}

function clampTurn(delta: number, max: number): number {
  if (delta > max) return max;
  if (delta < -max) return -max;
  return delta;
}

function spawnLaterals(
  rng: Rng,
  spine: Pt[],
  count: number,
  spread: number,
  curl: number,
  droop: number,
  inward: boolean,
  depth: number,
  maxDepth: number,
  scale: number,
  parentEmerge: number,
  parentSpan: number,
  coreY: number,
  strokes: TreeStroke[],
  flowers: TreeFlower[],
  tips: TreeTip[],
  leaves: TreeLeaf[],
): void {
  const last = Math.max(1, spine.length - 1);
  for (let k = 0; k < count; k++) {
    const t = 0.22 + ((k + 0.35 + rng() * 0.4) / count) * 0.62;
    const idx = Math.max(1, Math.min(last - 1, Math.round(t * last)));
    const p = spine[idx]!;
    const prev = spine[Math.max(0, idx - 1)]!;
    const stemA = Math.atan2(p.y - prev.y, p.x - prev.x);
    const side = k % 2 === 0 ? -1 : 1;
    const fork = side * (0.26 + rng() * spread * 0.65);
    const len = 24 * scale * (0.5 + rng() * 0.4);
    const w = 1.85 * scale * (1 - t * 0.42);
    const emerge = parentEmerge + parentSpan * t * 0.82 + rng() * 0.03;
    const span = Math.max(0.14, parentSpan * (0.48 + rng() * 0.22));
    growBranch(
      rng,
      p,
      stemA + fork,
      len,
      Math.max(0.65, w),
      curl * (1.02 + rng() * 0.2),
      droop,
      inward,
      depth,
      maxDepth,
      scale,
      emerge,
      span,
      coreY,
      strokes,
      flowers,
      tips,
      leaves,
    );
  }
}

function growBranch(
  rng: Rng,
  origin: Pt,
  angle: number,
  length: number,
  widthStart: number,
  curl: number,
  droop: number,
  inward: boolean,
  depth: number,
  maxDepth: number,
  scale: number,
  emerge: number,
  span: number,
  coreY: number,
  strokes: TreeStroke[],
  flowers: TreeFlower[],
  tips: TreeTip[],
  leaves: TreeLeaf[],
): void {
  if (length < 5 * scale) return;

  const steps = Math.max(7, Math.round(length / 3.3));
  const pts = curveStroke(
    rng,
    origin,
    angle,
    length,
    steps,
    curl * (1 + depth * 0.04),
    droop,
    inward,
    coreY,
  );
  const widthEnd = Math.max(0.38, widthStart * (depth >= maxDepth ? 0.2 : 0.44));
  const kind: TreeStroke['kind'] =
    depth >= maxDepth - 1 || widthStart < 1.0 * scale ? 'twig' : 'wood';
  strokes.push({
    points: pts,
    widthStart,
    widthEnd,
    kind,
    emerge,
    span,
  });

  const end = pts[pts.length - 1]!;
  const pre = pts[pts.length - 2] ?? origin;
  const endAngle = Math.atan2(end.y - pre.y, end.x - pre.x);
  const tipEmerge = emerge + span * 0.88;
  const join: Pt = {
    x: end.x * 0.84 + pre.x * 0.16,
    y: end.y * 0.84 + pre.y * 0.16,
  };

  const finishTip = (): void => {
    if (inward) return;
    tips.push({ x: end.x, y: end.y, angle: endAngle, emerge: tipEmerge });
    if (rng() < 0.9) {
      flowers.push({
        x: end.x,
        y: end.y,
        angle: endAngle,
        size: (FLOWER_SIZE_MIN + rng() * FLOWER_SIZE_SPREAD) * scale,
        emerge: tipEmerge + 0.03,
        span: 0.15,
      });
    }
  };

  if (depth >= maxDepth || length < 9 * scale) {
    finishTip();
    return;
  }

  const open = (0.22 + rng() * 0.2) * (1 - depth * 0.04);
  const leaderSide = rng() < 0.5 ? -1 : 1;
  const childSpan = Math.max(0.12, span * (0.48 + rng() * 0.16));
  const childEmerge = emerge + span * 0.76;

  growBranch(
    rng,
    join,
    endAngle + leaderSide * open * 0.38,
    length * (0.62 + rng() * 0.14),
    Math.max(0.4, widthEnd * 0.92),
    curl,
    droop,
    inward,
    depth + 1,
    maxDepth,
    scale,
    childEmerge,
    childSpan,
    coreY,
    strokes,
    flowers,
    tips,
    leaves,
  );
  growBranch(
    rng,
    join,
    endAngle - leaderSide * open * 0.95,
    length * (0.46 + rng() * 0.14),
    Math.max(0.38, widthEnd * 0.58),
    curl,
    droop,
    inward,
    depth + 1,
    maxDepth,
    scale,
    childEmerge + 0.02,
    childSpan,
    coreY,
    strokes,
    flowers,
    tips,
    leaves,
  );
}

function curveStroke(
  rng: Rng,
  origin: Pt,
  angle: number,
  length: number,
  steps: number,
  curl: number,
  droop: number,
  inward: boolean,
  coreY?: number,
): Pt[] {
  const pts: Pt[] = [{ x: origin.x, y: origin.y }];
  let x = origin.x;
  let y = origin.y;
  let wander = range(rng, -curl, curl) * 0.28;
  const tropism = inward ? Math.PI / 2 : -Math.PI / 2;
  const tropismK = inward ? 0.085 : 0.045;
  const waves = range(rng, 0.32, 0.7);
  const phase = range(rng, 0, Math.PI * 2);
  const waveAmp = curl * range(rng, 0.85, 1.4);
  const arc = range(rng, -1, 1) * curl * 1.15;
  const n = Math.max(steps, 5);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    wander += range(rng, -curl, curl) * 0.1;
    wander *= 0.95;
    const wave = Math.sin(t * waves * Math.PI * 2 + phase) * waveAmp * (0.25 + 0.75 * t);
    const droopBend = droop * t * t * 1.1;
    let a = angle + arc * t + wave + wander + droopBend;
    a += shortestAngle(a, tropism) * tropismK;
    if (inward && coreY != null) {
      const toCore = Math.atan2(coreY - y, -x);
      const dist = Math.hypot(x, y - coreY);
      const closeness = 1 - Math.min(1, dist / Math.max(1, length));
      a += shortestAngle(a, toCore) * (0.04 + 0.18 * closeness * closeness);
    }
    const step = length / n;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    if (inward && y < origin.y) y = origin.y;
    if (inward && coreY != null && y > coreY - 1.2) {
      y = coreY - 1.2;
      pts.push({ x, y });
      break;
    }
    pts.push({ x, y });
  }
  return pts;
}

function paintCanopy(
  tips: TreeTip[],
  flowers: TreeFlower[],
  blobs: TreeBlob[],
  leaves: TreeLeaf[],
  rng: Rng,
  scale: number,
): void {
  if (tips.length === 0) return;
  let cx = 0;
  let cy = 0;
  for (const t of tips) {
    cx += t.x;
    cy += t.y;
  }
  cx /= tips.length;
  cy /= tips.length;

  blobs.push({
    x: cx,
    y: cy,
    r: 22 * scale,
    alpha: 0.1,
    emerge: 0.5,
    span: 0.36,
  });
  for (const t of tips) {
    const tipEmerge = t.emerge ?? 0.62;
    blobs.push({
      x: t.x + range(rng, -2.5, 2.5) * scale,
      y: t.y + range(rng, -2.5, 2.5) * scale,
      r: (3.2 + rng() * 5.5) * scale,
      alpha: 0.05 + rng() * 0.07,
      emerge: tipEmerge - 0.05,
      span: 0.24,
    });
    // Two leaves per tip, opposite sides — a real leaf pair instead of a coin flip.
    const baseAngle = t.angle + range(rng, -0.3, 0.3);
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      leaves.push({
        x: t.x + Math.cos(baseAngle + Math.PI / 2) * side * 0.8 * scale,
        y: t.y + Math.sin(baseAngle + Math.PI / 2) * side * 0.8 * scale,
        angle: baseAngle + side * (0.85 + rng() * 0.35),
        length: (5.2 + rng() * 4.6) * scale,
        width: (1.4 + rng() * 1.2) * scale,
        emerge: tipEmerge + rng() * 0.06,
        span: 0.16 + rng() * 0.06,
      });
    }
  }
  for (const f of flowers) {
    blobs.push({
      x: f.x,
      y: f.y,
      r: f.size * 0.9,
      alpha: 0.16,
      emerge: (f.emerge ?? 0.72) - 0.04,
      span: 0.22,
    });
  }
}

function growthProgress(maturity: number, emerge: number, span: number): number {
  if (span <= 1e-6) return maturity >= emerge ? 1 : 0;
  return smoothstep(emerge, emerge + span, maturity);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function isWoodyStroke(kind: TreeStroke['kind']): boolean {
  return kind === 'wood' || kind === 'root' || kind === 'twig';
}
/**
 * Length progress `t` and global `girth` are independent for wood/roots:
 * incomplete tips stay young-thin while the base thickens toward adult.
 * Scar flora (tuft/grass) keeps the old length-tied width curve.
 */
function clipStroke(
  stroke: TreeStroke,
  t: number,
  girth: number,
): TreeStroke | null {
  if (t <= 0.012) return null;

  const pts = stroke.points;
  if (pts.length < 2) return null;

  const woody = isWoodyStroke(stroke.kind);
  const fullLength = t >= 0.999;

  let clipped: Pt[] = pts;
  if (!fullLength) {
    const lens: number[] = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      total += Math.hypot(b.x - a.x, b.y - a.y);
      lens.push(total);
    }
    if (total < 1e-4) return null;

    const eased = 1 - (1 - t) ** 3;
    const target = Math.max(total * eased, Math.min(1.4, total * 0.04));
    clipped = [{ x: pts[0]!.x, y: pts[0]!.y }];
    for (let i = 1; i < pts.length; i++) {
      if (lens[i]! <= target) {
        clipped.push(pts[i]!);
        continue;
      }
      const prev = pts[i - 1]!;
      const next = pts[i]!;
      const seg = lens[i]! - lens[i - 1]!;
      const u = seg > 1e-6 ? (target - lens[i - 1]!) / seg : 1;
      clipped.push({
        x: prev.x + (next.x - prev.x) * u,
        y: prev.y + (next.y - prev.y) * u,
      });
      break;
    }

    if (clipped.length < 2) {
      const d = pts[1]!;
      const len = Math.hypot(d.x - pts[0]!.x, d.y - pts[0]!.y) || 1;
      clipped.push({
        x: pts[0]!.x + ((d.x - pts[0]!.x) / len) * target,
        y: pts[0]!.y + ((d.y - pts[0]!.y) / len) * target,
      });
    }
  }

  let widthStart: number;
  let widthEnd: number;
  if (woody) {
    const sproutFrac = 0.16;
    const baseFloor = Math.max(0.35, stroke.widthStart * sproutFrac);
    widthStart = baseFloor + (stroke.widthStart - baseFloor) * girth;
    if (fullLength) {
      const tipFloor = Math.max(0.35, stroke.widthEnd * sproutFrac);
      widthEnd = tipFloor + (stroke.widthEnd - tipFloor) * girth;
    } else {
      // Growing tip stays young; only the established base thickens.
      const tipYoung = Math.max(0.35, widthStart * (0.22 + 0.18 * t));
      widthEnd = tipYoung;
    }
  } else {
    widthStart = stroke.widthStart * (0.38 + 0.62 * t);
    widthEnd =
      widthStart *
      (0.18 + 0.82 * t) *
      (stroke.widthEnd / Math.max(stroke.widthStart, 0.01));
    widthEnd = Math.max(0.35, widthEnd);
  }

  return {
    points: clipped,
    widthStart,
    widthEnd: Math.max(0.35, widthEnd),
    kind: stroke.kind,
  };
}

function shortestAngle(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Min bloom growth (0..1) before a flower sheds pollen. */
export const FLOWER_POLLEN_OPEN = 0.22;

/**
 * World-space flowers open enough to shed pollen.
 * Uses adult bloom positions so grains leave the blooms, not the scar.
 */
export function treeFlowersWorld(
  seed: number,
  maturity: number,
  scale: number,
  originX: number,
  originY: number,
  rotation: number,
  coreDepth: number,
  surfaceY = 0,
  kind: TreeKind = 'dyson',
  minOpen = FLOWER_POLLEN_OPEN,
): TreeFlower[] {
  const adult = buildAdultTree(seed, scale, coreDepth, surfaceY, kind);
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const out: TreeFlower[] = [];
  for (const f of adult.flowers) {
    const t = growthProgress(maturity, f.emerge ?? 0.72, f.span ?? 0.2);
    if (t < minOpen) continue;
    out.push({
      x: originX + f.x * c - f.y * s,
      y: originY + f.x * s + f.y * c,
      angle: f.angle + rotation,
      size: f.size * (0.12 + 0.88 * t),
      emerge: f.emerge,
      span: f.span,
    });
  }
  return out;
}

/** World-space branch tips for budding seedlings. */
export function treeTipsWorld(
  seed: number,
  maturity: number,
  scale: number,
  originX: number,
  originY: number,
  rotation: number,
  coreDepth: number,
  surfaceY = 0,
): TreeTip[] {
  const geom = buildTree(seed, maturity, scale, coreDepth, surfaceY);
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return geom.tips.map((t) => ({
    x: originX + t.x * c - t.y * s,
    y: originY + t.x * s + t.y * c,
    angle: t.angle + rotation,
  }));
}

export function maturityStep(maturity: number): number {
  return Math.floor(Math.min(1, Math.max(0, maturity)) / 0.05);
}

export function buildLSystemSegments(
  seed: number,
  maturity: number,
  scale = 1,
): { x0: number; y0: number; x1: number; y1: number }[] {
  const geom = buildTree(seed, maturity, scale);
  const segs: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const st of geom.strokes) {
    for (let i = 1; i < st.points.length; i++) {
      const a = st.points[i - 1]!;
      const b = st.points[i]!;
      segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
    }
  }
  return segs;
}
