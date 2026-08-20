import { Graphics } from 'pixi.js';
import { mulberry32 } from '../sim/rng';
import type { SeedlingKind, Stats } from '../sim/types';
import { paintGlowEllipse } from './glow';
import {
  seedlingColors,
  type FactionMark,
  type ScenePalette,
} from './palette';

export interface HullPaintOptions {
  stats: Stats;
  scene: ScenePalette;
  faction: import('../sim/types').FactionId;
  kind: SeedlingKind;
  id: number;
  /**
   * Multiplier applied to every drawn length. The flying seedling uses
   * 1; bloom calyxes use a fraction of the bloom size.
   */
  scale?: number;
  /**
   * 0..1 openness of the calyx; 0 = closed around the hull, 1 = wide open.
   * Petals spread and the aura grows as it opens. The hull itself never
   * changes — it is the seed that flies away.
   */
  open?: number;
  /**
   * 0..1 dust drift across the petals; 0 = still, 1 = recent departure.
   * Used to fade the calyx after a seed leaves.
   */
  departure?: number;
  /**
   * Non-color faction glyph stamped on the hull. 'none' (the default) draws
   * nothing, so the silhouette is byte-identical to before the pref existed.
   */
  mark?: FactionMark;
}

export interface HullPaintResult {
  bodyLength: number;
  bodyWidth: number;
}

const TWO_PI = Math.PI * 2;

/**
 * Same hull the seedling uses in flight. When called inside a bloom it draws
 * right where the seed begins, so the eye reads the bloom as a pod, not a
 * sticker. The Graphics is expected to be already positioned at the bloom
 * world location and rotated to `flower.angle`.
 */
export function paintSeedHull(
  g: Graphics,
  opts: HullPaintOptions,
): HullPaintResult {
  const open = clamp01(opts.open ?? 1);
  const departure = clamp01(opts.departure ?? 0);
  const scale = opts.scale ?? 1;

  const { wing, body: bodyColor } = seedlingColors(opts.stats, opts.scene, {
    faction: opts.faction,
    kind: opts.kind,
  });
  const e = opts.stats.energy / 200;
  const p = opts.stats.strength / 200;
  const v = opts.stats.speed / 200;
  const sentinel = opts.kind === 'sentinel';
  const k = sentinel ? 1.08 : 1;
  const rng = mulberry32((opts.id * 0x9e3779b9) ^ 0xa57e);

  const jBody = 0.94 + rng() * 0.12;
  const jWing = 0.9 + rng() * 0.2;
  const jNose = 0.92 + rng() * 0.16;
  const asym = (rng() - 0.5) * 0.14;

  const bodyL = (3.55 + e * 1.15 + p * 0.22) * k * jBody * scale;
  const bodyW = (0.95 + e * 0.45) * k * jBody * scale;
  const nose = bodyL * 0.54;
  const rump = -bodyL * 0.46;
  const husk = (0.45 + v * 1.05) * k * jWing * scale;
  const barb = (0.32 + p * 1.15) * k * jNose * scale;
  const extraWings = v >= 0.85;
  const twinBarb = p >= 1.05;

  // Aura grows when the pod is open; closes as the seed detaches. A baked
  // radial ramp, so the silhouette never shows a hard ellipse edge and the
  // aura costs one ellipse instead of a stack of them.
  const openAura = 0.4 + open * 0.6;
  const auraX = (bodyL * 0.62 + husk * 0.2) * openAura;
  const auraY = (bodyW + husk * 0.55) * openAura;
  const auraK = mixAlpha(1, departure, 0.35);
  paintGlowEllipse(g, bodyL * 0.02, 0, auraX * 1.05, auraY, wing, (sentinel ? 0.07 : 0.045) * auraK, 5);
  paintGlowEllipse(g, bodyL * 0.04, 0, auraX * 0.72, auraY * 0.68, wing, (sentinel ? 0.08 : 0.055) * auraK, 4);

  // Fins spread with openness. The sprite-level seedling already
  // animates openness via visualScale; here we just keep them.
  paintFins(g, bodyL * 0.08, bodyW, rump, husk, asym, wing, sentinel ? 0.82 : 0.68);
  if (extraWings) {
    paintFins(
      g,
      bodyL * 0.26,
      bodyW * 0.7,
      rump * 0.18,
      husk * 0.46,
      -asym * 0.5,
      wing,
      sentinel ? 0.72 : 0.56,
    );
  }

  // Hull body (the seed that will fly).
  g.moveTo(nose, 0);
  g.quadraticCurveTo(0, bodyW * 1.38, rump, 0);
  g.quadraticCurveTo(0, -bodyW * 1.38, nose, 0);
  g.closePath();
  g.fill({ color: bodyColor, alpha: 0.96 });
  g.moveTo(nose, 0);
  g.quadraticCurveTo(0, bodyW * 1.38, rump, 0);
  g.quadraticCurveTo(0, -bodyW * 1.38, nose, 0);
  g.closePath();
  g.stroke({ width: 0.45 * scale, color: wing, alpha: scale < 0.3 ? 0.45 : 0.28 });

  paintBarb(g, nose, bodyW, barb, twinBarb ? 0.34 : 0, bodyColor);
  if (twinBarb) {
    paintBarb(g, nose, bodyW, barb * 0.82, -0.34, bodyColor);
  }

  // Germ eye dot — same as the flying seedling.
  const germY = (rng() - 0.5) * 0.22;
  g.circle(bodyL * 0.1, bodyW * germY, Math.max(0.55 * scale, bodyW * 0.32));
  g.fill({ color: wing, alpha: 0.92 });

  paintFactionMark(g, opts.mark ?? 'none', bodyL, bodyW, scale, bodyColor);

  return { bodyLength: bodyL, bodyWidth: bodyW };
}

/**
 * Faction glyph on the hull's back, drawn in the wing color so it reads as a
 * marking rather than a second body. Sized off the hull, so it holds its
 * proportion at every zoom the atlas bakes.
 *
 * Deliberately three primitives at most: this runs once per atlas texture,
 * but the shapes have to stay legible when the hull is a few pixels wide.
 */
function paintFactionMark(
  g: Graphics,
  mark: FactionMark,
  bodyL: number,
  bodyW: number,
  scale: number,
  ink: number,
): void {
  if (mark === 'none') return;
  const w = Math.max(0.4 * scale, bodyW * 0.42);
  const cx = -bodyL * 0.06;
  const alpha = 0.95;

  if (mark === 'bar') {
    // A stripe across the back — reads at the smallest size of the three.
    g.moveTo(cx, -w);
    g.lineTo(cx, w);
    g.stroke({ width: Math.max(0.42 * scale, bodyW * 0.36), color: ink, alpha });
    return;
  }
  if (mark === 'chevron') {
    const h = w * 1.05;
    g.moveTo(cx - h * 0.55, -w);
    g.lineTo(cx + h * 0.5, 0);
    g.lineTo(cx - h * 0.55, w);
    g.stroke({
      width: Math.max(0.36 * scale, bodyW * 0.3),
      color: ink,
      alpha,
      join: 'miter',
    });
    return;
  }
  // 'ring' — an open circle, distinct in silhouette from bar and chevron.
  g.circle(cx, 0, w * 0.86);
  g.stroke({ width: Math.max(0.34 * scale, bodyW * 0.26), color: ink, alpha });
}

/**
 * Petals that bracket the hull along the pod axis. They surround the seed
 * rather than radiating around it, so the bloom reads as a closed pod that
 * can open.
 */
export function paintCalyx(
  g: Graphics,
  hull: { bodyLength: number; bodyWidth: number },
  _size: number,
  podColor: number,
  tipColor: number,
  open: number,
  gentle: boolean,
): void {
  const u = 0.55 + 0.45 * open;
  const back = hull.bodyLength * 0.6 * u;
  const side = hull.bodyWidth * 1.25 * (gentle ? 0.95 : 1.15);

  // Top shell — like an open shell, hull rotates around x.
  g.moveTo(-back * 0.4, -hull.bodyWidth * 0.05);
  g.quadraticCurveTo(back * 0.2, -side * 0.85, back * 0.85, -side * 0.18);
  g.lineTo(back * 0.85, side * 0.18);
  g.quadraticCurveTo(back * 0.2, side * 0.85, -back * 0.4, hull.bodyWidth * 0.05);
  g.closePath();
  g.fill({ color: podColor, alpha: 0.95 * u });
  g.stroke({ width: 0.9, color: tipColor, alpha: 0.65 });

  // Central spine highlights the hull axis.
  g.moveTo(-back * 0.35, 0);
  g.lineTo(back * 0.95, 0);
  g.stroke({ width: 0.7, color: tipColor, alpha: 0.7 * u });

  // Forward beak — closes over the nose.
  g.moveTo(back * 0.55, 0);
  g.quadraticCurveTo(back * 0.7, -side * 0.18, back * (1.0 - 0.55 * open), 0);
  g.quadraticCurveTo(back * 0.7, side * 0.18, back * 0.55, 0);
  g.closePath();
  g.fill({ color: podColor, alpha: 0.95 * u });
  g.stroke({ width: 0.7, color: tipColor, alpha: 0.7 });

  // Rear sepal — splits off when the seed launches.
  g.moveTo(-back * 0.55, 0);
  g.quadraticCurveTo(-back * 0.85, -side * 0.15, -back * (0.85 - 0.5 * open), 0);
  g.quadraticCurveTo(-back * 0.85, side * 0.15, -back * 0.55, 0);
  g.closePath();
  g.fill({ color: podColor, alpha: 0.85 * u });
  g.stroke({ width: 0.6, color: tipColor, alpha: 0.55 });
}

function paintFins(
  g: Graphics,
  attachX: number,
  bodyW: number,
  rump: number,
  husk: number,
  asym: number,
  color: number,
  alpha: number,
): void {
  for (const side of [1, -1]) {
    const span = husk * (1 + side * asym);
    g.moveTo(attachX, side * bodyW * 0.2);
    g.lineTo(rump * 0.08, side * (bodyW + span));
    g.lineTo(rump * 1.08, side * span * 0.18);
    g.closePath();
    g.fill({ color, alpha });
  }
}

function paintBarb(
  g: Graphics,
  nose: number,
  bodyW: number,
  len: number,
  yaw: number,
  color: number,
): void {
  const tipY = yaw * bodyW;
  const half = Math.max(0.32, bodyW * 0.2);
  g.moveTo(nose + len, tipY);
  g.lineTo(nose * 0.72, tipY + half);
  g.lineTo(nose * 0.72, tipY - half);
  g.closePath();
  g.fill({ color, alpha: 0.95 });
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function mixAlpha(a: number, dep: number, weight: number): number {
  return a * (1 - dep * weight);
}

export const HULL_TWO_PI = TWO_PI;
