import { Container, Graphics } from 'pixi.js';
import {
  buildAdultTree,
  FLOWER_POLLEN_OPEN,
  growTree,
  rootFeedActive,
  treeFlowersWorld,
  type PocketTarget,
  type TreeGeom,
  type TreeStroke,
} from '../sim/lsystem';
import {
  TREE_BURN_SECONDS,
  treeVisualScale,
  type Asteroid,
  type Seedling,
  type Tree,
  type TreeKind,
} from '../sim/types';
import { plantPose } from '../sim/world';
import {
  bucketHue,
  floraPalette,
  mixHex,
  resourceKindHex,
  sapRiseU,
  sapStage,
  SAP_WINDOW,
  type FloraPalette,
  type ScenePalette,
} from './palette';
import { paintCalyx, paintSeedHull } from './seedlingPaint';

const TREE_REDRAW_INTERVAL = 1 / 15;

function seedlingDepartureSignature(sprouts: readonly Seedling[]): number {
  let h = 0;
  for (let i = 0; i < sprouts.length; i++) {
    const s = sprouts[i];
    if (s.state !== 'sprout') continue;
    h = (Math.imul(h, 31) + s.id) | 0;
  }
  return h;
}

export class TreeView {
  readonly canopy = new Container();
  readonly roots = new Container();
  private wood = new Graphics();
  private wash = new Graphics();
  private blooms = new Graphics();
  private rootGfx = new Graphics();
  private rootSap = new Graphics();
  private woodSap = new Graphics();
  private sapPainted = false;
  private treeId: number;
  private treeSeed: number;
  private kind: TreeKind;
  private pal: FloraPalette;
  private scene: ScenePalette;
  private swayPhase: number;
  private baseRot = 0;
  private adult: TreeGeom | null = null;
  private adultKey = '';
  private grown: TreeGeom | null = null;
  private coreY = 0;
  private bloomDescriptors: {
    faction: import('../sim/types').FactionId;
    facing: number;
    hasSeedling: boolean;
  }[] = [];
  private lastHueBucket = -1;
  private lastTheme: ScenePalette['theme'] | undefined;
  private lastRedrawTime = -Infinity;
  private lastRedrawMaturity = 0;
  private needsRedraw = true;
  private lastDepartureSignature = -1;

  constructor(tree: Tree, asteroid: Asteroid, scene: ScenePalette) {
    this.treeId = tree.id;
    this.treeSeed = tree.seed;
    this.kind = tree.kind;
    this.pal = floraPalette(asteroid.stats, asteroid.seed, scene);
    this.scene = scene;
    this.swayPhase = (tree.seed % 1000) * 0.017;
    this.rootSap.blendMode = 'add';
    this.woodSap.blendMode = 'add';
    this.canopy.addChild(this.wash, this.wood, this.blooms, this.woodSap);
    this.roots.addChild(this.rootGfx, this.rootSap);
    this.layout(tree, asteroid);
    this.redraw(tree, asteroid);
    this.needsRedraw = false;
    this.lastRedrawTime = performance.now() / 1000;
    this.lastRedrawMaturity = tree.maturity;
  }

  destroy(): void {
    this.canopy.destroy({ children: true });
    this.roots.destroy({ children: true });
  }

  private layout(tree: Tree, asteroid: Asteroid): void {
    const pos = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
    this.baseRot = pos.angle + Math.PI / 2;
    this.canopy.position.set(pos.x, pos.y);
    this.canopy.rotation = this.baseRot;
    this.roots.position.set(pos.x, pos.y);
    this.roots.rotation = this.baseRot;
  }

  update(tree: Tree, asteroid: Asteroid): void {
    if (tree.id !== this.treeId) return;
    this.layout(tree, asteroid);
    const t = performance.now() / 1000;
    const young = 1 - tree.maturity;
    const breeze =
      (Math.sin(t * 0.55 + this.swayPhase) * 0.055 +
        Math.sin(t * 1.08 + this.swayPhase * 1.37) * 0.022 +
        Math.sin(t * 1.84 + this.swayPhase * 0.71) * 0.01) *
      (1 + young * 1.35);
    this.canopy.rotation = this.baseRot + breeze;
    this.roots.rotation = this.baseRot;
    this.canopy.scale.set(1 + Math.sin(t * 0.85 + this.swayPhase) * 0.014);
    // Throttle the geometry rebuild to ~30 Hz and only retrigger if
    // maturity moved enough that the per-frame interpolation would read
    // as a jump. The leaf transform above keeps the motion smooth at the
    // full 60 Hz redraw.
    const matureDelta = Math.abs(tree.maturity - this.lastRedrawMaturity);
    if (
      this.needsRedraw ||
      t - this.lastRedrawTime >= TREE_REDRAW_INTERVAL ||
      matureDelta > 0.004
    ) {
      this.redraw(tree, asteroid, t);
      this.needsRedraw = false;
      this.lastRedrawTime = t;
      this.lastRedrawMaturity = tree.maturity;
    }

    const burn =
      asteroid.burnTimer > 0
        ? Math.min(1, asteroid.burnTimer / TREE_BURN_SECONDS)
        : 0;
    const alpha = 1 - burn * 0.65;
    this.canopy.alpha = alpha;
    this.roots.alpha = alpha;
  }

  retheme(tree: Tree, asteroid: Asteroid, scene: ScenePalette): void {
    const bucket = bucketHue(scene.hue);
    const themeChanged = scene.theme !== undefined && scene.theme !== this.lastTheme;
    if (bucket === this.lastHueBucket && !themeChanged) {
      this.scene = scene;
      return;
    }
    this.lastHueBucket = bucket;
    this.lastTheme = scene.theme;
    this.pal = floraPalette(asteroid.stats, asteroid.seed, scene);
    this.scene = scene;
    this.redraw(tree, asteroid);
  }

  /**
   * Mark which blooms are currently occupied by a sprout that hasn't left
   * the tree yet. The bloom with index `i` (matching `geom.flowers` order)
   * skips redrawing the hull, since the seedling sprite is already flying
   * that exact same hull from the same world coordinates.
   */
  setDepartingSeedlings(
    sprouts: readonly Seedling[],
    tree: Tree,
    asteroid: Asteroid,
  ): void {
    if (this.bloomDescriptors.length === 0) return;
    const signature = seedlingDepartureSignature(sprouts);
    if (signature === this.lastDepartureSignature) return;
    this.lastDepartureSignature = signature;
    const scale = treeVisualScale(asteroid.radius, asteroid.seed);
    const pose = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
    const flowers = treeFlowersWorld(
      tree.seed,
      tree.maturity,
      scale,
      pose.x,
      pose.y,
      pose.angle + Math.PI / 2,
      pose.dist,
      pose.surfaceY,
      tree.kind,
      FLOWER_POLLEN_OPEN,
    );
    const tol = 5;
    let changed = false;
    for (let i = 0; i < this.bloomDescriptors.length; i++) {
      const desc = this.bloomDescriptors[i]!;
      const flower = flowers[i];
      const wasOcc = desc.hasSeedling;
      let isOcc = false;
      if (flower) {
        for (const sp of sprouts) {
          if (sp.state !== 'sprout') continue;
          if (
            Math.hypot(sp.x - flower.x, sp.y - flower.y) < tol &&
            Math.hypot(sp.x - flower.x, sp.y - flower.y) > 0.01
          ) {
            // Sprout en route, bloom is open.
            isOcc = true;
            break;
          }
        }
      }
      if (wasOcc !== isOcc) {
        desc.hasSeedling = isOcc;
        changed = true;
      }
    }
    if (changed) this.repaintBlooms();
  }

  private repaintBlooms(): void {
    if (!this.grown) return;
    this.blooms.clear();
    for (let i = 0; i < this.grown.flowers.length; i++) {
      const f = this.grown.flowers[i]!;
      const desc = this.bloomDescriptors[i];
      if (!desc) continue;
      const facing = f.angle;
      this.blooms.save();
      this.blooms.position.set(f.x, f.y);
      this.blooms.rotation = facing;
      drawBloom(
        this.blooms,
        0,
        0,
        bloomSize(f.size, this.kind),
        this.pal,
        this.scene,
        this.kind,
        this.treeSeed,
        i,
        desc.faction,
        desc.hasSeedling,
      );
      this.blooms.restore();
    }
    // Sap is repainted every frame now, so nothing extra to schedule here —
    // the next update() tick will redraw the sap halo over the new blooms.
  }

  private adultGeom(tree: Tree, asteroid: Asteroid): TreeGeom {
    const polar = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
    const key = `${this.treeSeed}:${asteroid.radius}:${polar.dist.toFixed(2)}:${polar.surfaceY.toFixed(2)}:${this.kind}:${asteroid.pockets.length}:${asteroid.pockets.map((p) => `${p.angle.toFixed(3)}:${p.radiusT.toFixed(3)}`).join('|')}`;
    if (this.adult && this.adultKey === key) return this.adult;
    const scale = treeVisualScale(asteroid.radius, asteroid.seed);
    this.adult = buildAdultTree(
      this.treeSeed,
      scale,
      polar.dist,
      polar.surfaceY,
      this.kind,
      pocketsToTreeTargets(asteroid, polar),
    );
    this.adultKey = key;
    return this.adult;
  }

  private redraw(tree: Tree, asteroid: Asteroid, time: number = performance.now() / 1000): void {
    const pose = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
    this.coreY = pose.dist;
    const geom = growTree(this.adultGeom(tree, asteroid), tree.maturity);
    this.grown = geom;
    const wood = this.wood;
    const wash = this.wash;
    const blooms = this.blooms;
    const rootGfx = this.rootGfx;
    wood.clear();
    wash.clear();
    blooms.clear();
    rootGfx.clear();

    const c = geom.collar;
    const coreY = this.coreY;
    const pal = this.pal;
    const wellSpan = Math.max(1, coreY - geom.surfaceY);
    const wellR = Math.max(12, coreY * 0.18);
    const canopySpine = longestFromCollar(geom.strokes, c, false);
    const inwardSpine = longestFromCollar(geom.strokes, c, true);
    paintThroughCrust(wood, canopySpine, inwardSpine, pal, false);
    paintThroughCrust(rootGfx, canopySpine, inwardSpine, pal, true);

    const join = mixHex(pal.wood, pal.root, 0.5);
    const joinSoft = mixHex(pal.wood, pal.rootSoft, 0.48);
    for (const r of geom.strokes) {
      if (r.kind !== 'root') continue;
      ribbon(
        rootGfx,
        r.points,
        r.widthStart * 1.2,
        r.widthEnd * 1.2,
        mixHex(pal.outline, join, 0.5),
        0.7,
        2,
        pal.outline,
        0.18,
        0.78,
        false,
        true,
      );
      ribbon(
        rootGfx,
        r.points,
        r.widthStart * 1.85 + 1.4,
        r.widthEnd * 1.85 + 1.0,
        joinSoft,
        0.32,
        2,
        pal.rootSoft,
        0.2,
        0.82,
        false,
        true,
      );
      ribbon(
        rootGfx,
        r.points,
        r.widthStart,
        r.widthEnd,
        join,
        1,
        2,
        pal.root,
        0.22,
        0.84,
        false,
        true,
      );
      ribbon(
        rootGfx,
        r.points,
        Math.max(0.6, r.widthStart * 0.42),
        Math.max(0.45, r.widthEnd * 0.42),
        mixHex(join, pal.coreHot, 0.3),
        0.85,
        2,
        pal.coreHot,
        0.24,
        0.86,
        false,
        true,
      );
      const tip = r.points[r.points.length - 1];
      if (!tip) continue;
      const d = Math.hypot(tip.x, tip.y - coreY);
      const near = d < wellR * 1.6;
      const glow = near ? 1 - d / (wellR * 1.6) : 0.2;
      rootGfx.circle(
        tip.x,
        tip.y,
        (2.2 + glow * 3.2) * (0.75 + tree.maturity * 0.35),
      );
      rootGfx.fill({
        color: near ? pal.core : pal.rootSoft,
        alpha: 0.22 + glow * 0.4,
      });
      rootGfx.circle(tip.x, tip.y, 0.85 + glow * 1.1);
      rootGfx.fill({
        color: near ? pal.coreWhite : pal.root,
        alpha: 0.55 + glow * 0.35,
      });
    }

    for (const s of geom.strokes) {
      if (s.kind === 'tuft' || s.kind === 'grass' || s.kind === 'root') continue;
      const tip = s.points[s.points.length - 1];
      const isIn = tip != null && tip.y > geom.surfaceY + 2;
      paintWoodBands(
        isIn ? rootGfx : wood,
        s,
        pal,
        isIn,
        geom.surfaceY,
        wellSpan,
      );
    }

    for (const b of geom.blobs) {
      wash.circle(b.x, b.y, b.r);
      wash.fill({ color: dietTinted(this.pal.leaf, this.pal, tree, 0.4), alpha: b.alpha * 0.85 });
      wash.circle(b.x + b.r * 0.18, b.y - b.r * 0.12, b.r * 0.55);
      wash.fill({ color: dietTinted(this.pal.tuft, this.pal, tree, 0.5), alpha: b.alpha * 0.45 });
    }

    for (const s of geom.strokes) {
      if (s.kind !== 'tuft' && s.kind !== 'grass') continue;
      if (s.kind === 'tuft') {
        ribbon(wood, s.points, s.widthStart, s.widthEnd, dietTinted(this.pal.tuft, this.pal, tree, 0.5), 0.72);
        continue;
      }
      ribbon(wood, s.points, s.widthStart, s.widthEnd, this.pal.grass, 0.78);
      ribbon(
        wood,
        s.points,
        s.widthStart * 0.45,
        s.widthEnd * 0.4,
        dietTinted(this.pal.leaf, this.pal, tree, 0.4),
        0.55,
      );
    }

    for (const leaf of geom.leaves) {
      drawLeaf(
        wood,
        leaf.x,
        leaf.y,
        leaf.angle,
        leaf.length,
        leaf.width,
        dietTinted(this.pal.leaf, this.pal, tree, 0.45),
        0.82,
      );
    }

    this.bloomDescriptors = geom.flowers.map((f) => ({
      faction: tree.faction,
      facing: f.angle,
      hasSeedling: false,
    }));
    for (let i = 0; i < geom.flowers.length; i++) {
      const f = geom.flowers[i]!;
      const desc = this.bloomDescriptors[i]!;
      blooms.save();
      blooms.position.set(f.x, f.y);
      blooms.rotation = f.angle;
      drawBloom(
        blooms,
        0,
        0,
        bloomSize(f.size, this.kind),
        this.pal,
        this.scene,
        this.kind,
        this.treeSeed,
        i,
        desc.faction,
        desc.hasSeedling,
      );
      blooms.restore();
    }

    const scale = treeVisualScale(asteroid.radius, asteroid.seed);
    if (this.kind === 'energy') {
      wash.ellipse(c.x, c.y - 14 * scale, 22 * scale, 16 * scale);
      wash.fill({
        color: this.pal.core,
        alpha: 0.12 * Math.min(1, tree.maturity * 1.4),
      });
    }
    if (this.kind === 'defense') {
      wood.ellipse(c.x, c.y - 10 * scale, 18 * scale, 10 * scale);
      wood.stroke({
        width: 1.6,
        color: this.pal.ring,
        alpha: 0.4 * Math.min(1, tree.maturity * 1.4),
      });
    }

    this.paintSap(tree, time);
  }

  private paintSap(tree: Tree, time: number): void {
    const rootSap = this.rootSap;
    const woodSap = this.woodSap;
    const geom = this.grown;
    if (!geom) return;

    let feed = rootFeedActive(tree.maturity, tree.coreFeed);
    if (this.kind === 'energy') feed = Math.min(1, feed * 1.25);
    if (this.kind === 'defense') feed = feed * 0.85;
    if (feed <= 0.02) {
      if (this.sapPainted) {
        rootSap.clear();
        woodSap.clear();
        this.sapPainted = false;
      }
      return;
    }

    rootSap.clear();
    woodSap.clear();
    this.sapPainted = true;

    const u = sapRiseU(time, tree.seed);
    const breathe = 0.88 + 0.12 * Math.sin(time * 1.41 + this.swayPhase);
    const strength = feed * breathe * 0.56;
    const core = sapStage(u, SAP_WINDOW.core[0], SAP_WINDOW.core[1], 0.28);
    const roots = sapStage(u, SAP_WINDOW.roots[0], SAP_WINDOW.roots[1]);
    const trunk = sapStage(u, SAP_WINDOW.trunk[0], SAP_WINDOW.trunk[1]);
    const twig = sapStage(u, SAP_WINDOW.twig[0], SAP_WINDOW.twig[1]);
    const grass = sapStage(u, SAP_WINDOW.grass[0], SAP_WINDOW.grass[1], 0.2);

    // Nucleus — sap launches from here. Stacked soft rings instead of
    // hard concentric circles so the silhouette never reads as a disc.
    const wellR = Math.max(14, this.coreY * 0.2);
    const launch = Math.max(core.glow, roots.glow * 0.45) * strength;
    if (launch > 0.02) {
      const throb = 1 + core.progress * 0.22;
      const r = wellR * (1.85 + 0.7 * throb) * (0.75 + launch);
      paintSoftRing(rootSap, 0, this.coreY, r, -1, this.pal.core, 0.16 * launch, 5);
      paintSoftRing(
        rootSap,
        0,
        this.coreY,
        wellR * 1.05 * throb,
        -1,
        this.pal.coreHot,
        0.22 * launch,
        4,
      );
      paintSoftRing(
        rootSap,
        0,
        this.coreY,
        wellR * 0.48 * throb,
        -1,
        this.pal.coreWhite,
        0.18 * launch,
        3,
      );
    }

    // Roots: stored collar → core; reverse so sap rises toward the surface.
    if (roots.glow > 0.02) {
      for (const r of geom.strokes) {
        if (r.kind !== 'root') continue;
        paintSapStroke(rootSap, r, roots, strength, this.pal, true);
      }
    }

    for (const s of geom.strokes) {
      const tip = s.points[s.points.length - 1];
      const inward = tip != null && tip.y > geom.surfaceY + 2;
      const layer = inward ? rootSap : woodSap;
      if (s.kind === 'wood' && trunk.glow > 0.02) {
        paintSapStroke(layer, s, trunk, strength, this.pal, false);
        continue;
      }
      // Branches fade as sap leaves the trunk — only a short haze at the join.
      if (s.kind === 'twig' && twig.glow > 0.02) {
        paintSapStroke(layer, s, twig, strength * 0.22, this.pal, false, 0.28);
        continue;
      }
      if ((s.kind === 'grass' || s.kind === 'tuft') && grass.glow > 0.02) {
        paintSapStroke(woodSap, s, grass, strength * 0.8, this.pal, false);
      }
    }

    // Continuous ambient glow over the canopy — keeps the transition
    // between trunk and twig stages luminous instead of snapping dark.
    const ambient = trunk.glow * 0.18 + twig.glow * 0.42;
    if (ambient > 0.02) {
      for (const f of geom.flowers) {
        const k = ambient * strength;
        const r = f.size * (1.15 + Math.max(trunk.progress, twig.progress) * 0.35);
        paintSoftRing(woodSap, f.x, f.y, r * 2.1, -1, this.pal.core, 0.12 * k, 5);
        paintSoftRing(woodSap, f.x, f.y, r * 0.85, -1, this.pal.coreHot, 0.16 * k, 4);
      }
    }
  }
}

function paintSapStroke(
  g: Graphics,
  stroke: TreeStroke,
  stage: { progress: number; glow: number; rising: boolean },
  strength: number,
  pal: FloraPalette,
  fromTip: boolean,
  taper = 1,
): void {
  const src = stroke.points;
  if (src.length < 2 || stage.glow <= 0.02 || strength <= 0.02) return;

  const pts = fromTip ? reversePts(src) : src;
  const w0 = fromTip ? stroke.widthEnd : stroke.widthStart;
  const w1 = fromTip ? stroke.widthStart : stroke.widthEnd;

  const lens: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
    lens.push(total);
  }
  if (total < 1.2) return;

  const headT = Math.max(0.02, stage.progress * taper);
  const trail = sliceStroke(pts, lens, total, 0, headT);
  if (trail.length >= 2) {
    sapVein(
      g,
      trail,
      Math.max(0.7, w0 * 0.55),
      Math.max(0.55, widthAt(w0, w1, headT)),
      stage.glow * strength * (stage.rising ? 0.62 : 0.4),
      pal,
      false,
    );
  }

  if (!stage.rising && stage.glow < 0.12) return;

  const pulseLo = Math.max(0, headT - (stage.rising ? 0.4 : 0.18) * taper);
  const pulseHi = Math.min(taper, headT + 0.06);
  const pulse = sliceStroke(pts, lens, total, pulseLo, pulseHi);
  const head = pointAlong(pts, lens, total, headT * total);
  if (pulse.length >= 2) {
    sapVein(
      g,
      pulse,
      Math.max(0.85, widthAt(w0, w1, pulseLo) * 0.7),
      Math.max(0.7, widthAt(w0, w1, pulseHi) * 0.7),
      stage.glow * strength * (taper < 1 ? 0.55 : 1),
      pal,
      taper >= 1,
    );
  }
  if (taper >= 0.85) {
    sapHead(g, head.x, head.y, Math.max(w0, w1), stage.glow * strength, pal);
  }
}

/**
 * Soft-edged glow approximated by stacked concentric shapes of decreasing
 * alpha. Avoids the hard silhouette a single `g.fill({color, alpha})` would
 * leave at low alpha, especially over additive blending. Pass `ry < 0` to
 * use a circle of radius `r`; otherwise the rings are ellipses with axes
 * (r, ry).
 */
export function paintSoftRing(
  g: Graphics,
  x: number,
  y: number,
  r: number,
  ry: number,
  color: number,
  alpha: number,
  rings: number,
): void {
  if (alpha <= 0.002 || r <= 0.05) return;
  const n = Math.max(2, rings | 0);
  const useCircle = ry < 0;
  for (let i = 0; i < n; i++) {
    const u = 1 - i / n;
    const e = u * u;
    if (useCircle) {
      g.circle(x, y, r * u);
    } else {
      g.ellipse(x, y, r * u, ry * u);
    }
    g.fill({ color, alpha: alpha * e });
  }
}

function reversePts(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) out.push(pts[i]!);
  return out;
}

function widthAt(w0: number, w1: number, t: number): number {
  return w0 + (w1 - w0) * t;
}

function pointAlong(
  pts: { x: number; y: number }[],
  lens: number[],
  total: number,
  dist: number,
): { x: number; y: number } {
  const d = Math.min(total, Math.max(0, dist));
  for (let i = 1; i < pts.length; i++) {
    if (lens[i]! >= d) {
      const span = lens[i]! - lens[i - 1]! || 1;
      const t = (d - lens[i - 1]!) / span;
      const a = pts[i - 1]!;
      const b = pts[i]!;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return pts[pts.length - 1]!;
}

function sliceStroke(
  pts: { x: number; y: number }[],
  lens: number[],
  total: number,
  t0: number,
  t1: number,
): { x: number; y: number }[] {
  const lo = Math.max(0, Math.min(t0, t1) * total);
  const hi = Math.min(total, Math.max(t0, t1) * total);
  if (hi - lo < 0.45) return [];
  const out: { x: number; y: number }[] = [pointAlong(pts, lens, total, lo)];
  for (let i = 0; i < pts.length; i++) {
    const d = lens[i]!;
    if (d > lo + 0.15 && d < hi - 0.15) out.push(pts[i]!);
  }
  out.push(pointAlong(pts, lens, total, hi));
  return out;
}

function sapVein(
  g: Graphics,
  pts: { x: number; y: number }[],
  w0: number,
  w1: number,
  strength: number,
  pal: FloraPalette,
  hot: boolean,
): void {
  if (pts.length < 2 || strength <= 0.02) return;
  const k = hot ? 1 : 0.7;
  // Outer halo: very wide, very faint, more Chaikin passes — diffuses the
  // ribbon outline so the vein reads as light, not a tube.
  ribbon(g, pts, w0 * 6.5 + 12, w1 * 6.5 + 10, pal.core, 0.09 * strength * k, 4);
  ribbon(g, pts, w0 * 4.4 + 7.2, w1 * 4.4 + 6.2, pal.core, 0.14 * strength * k, 3);
  ribbon(g, pts, w0 * 2.2 + 3.2, w1 * 2.2 + 2.6, pal.coreHot, 0.2 * strength * k, 2);
  ribbon(
    g,
    pts,
    Math.max(0.7, w0 * 0.85),
    Math.max(0.55, w1 * 0.75),
    pal.coreWhite,
    (hot ? 0.22 : 0.14) * strength,
    1,
  );
}

function sapHead(
  g: Graphics,
  x: number,
  y: number,
  width: number,
  strength: number,
  pal: FloraPalette,
): void {
  if (strength <= 0.04) return;
  const r = Math.max(3.8, width * 1.35);
  paintSoftRing(g, x, y, r * 3.2, -1, pal.core, 0.16 * strength, 5);
  paintSoftRing(g, x, y, r * 1.85, -1, pal.coreHot, 0.2 * strength, 4);
  paintSoftRing(g, x, y, r * 0.85, -1, pal.coreWhite, 0.18 * strength, 3);
}

function nearPt(
  a: { x: number; y: number } | undefined,
  b: { x: number; y: number },
  r: number,
): boolean {
  if (!a) return false;
  return Math.hypot(a.x - b.x, a.y - b.y) < r;
}

function polylineLen(pts: { x: number; y: number }[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    n += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  return n;
}

function prefixUntil(
  pts: { x: number; y: number }[],
  dist: number,
): { x: number; y: number }[] {
  if (pts.length < 2) return pts.slice();
  const out = [{ x: pts[0]!.x, y: pts[0]!.y }];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    out.push({ x: pts[i]!.x, y: pts[i]!.y });
    if (acc >= dist) break;
  }
  return out;
}

/**
 * Distance from (px, py) to segment a–b, plus the parametric position along
/**
 * Convert asteroid pockets (polar, world units) into tree-local targets
 * for the L-system seeker tendrils. The transform mirrors the inverse
 * applied in `paintTendrils` so the geometry the L-system bakes matches
 * the same frame the renderer will draw into.
 */
/**
 * Tint a flora color by the tree's dietary bias. The dominant pocket kind
 * (when the tree's intake is loud enough) pulls the foliage / tuft toward
 * that resource's color, so the player can read at a glance whether a
 * tree is feeding on mineral, water, or energy pockets. `amount` is the
 * max blend (0..1); the effective blend is scaled by how strongly the
 * bias dominates (so a barely-fed tree barely tints).
 */
function dietTinted(base: number, pal: FloraPalette, tree: Tree, amount: number): number {
  const bias = tree.dietaryBias;
  if (!bias) return base;
  const total = bias.mineral + bias.water + bias.energy;
  if (total < 1e-3) return base;
  let bestKind: 'mineral' | 'water' | 'energy' = 'mineral';
  let bestShare = bias.mineral;
  if (bias.water > bestShare) { bestKind = 'water'; bestShare = bias.water; }
  if (bias.energy > bestShare) { bestKind = 'energy'; bestShare = bias.energy; }
  const tint = resourceKindHex(bestKind, pal);
  // Strength: dominant share's surplus above an even split, plus a min
  // floor so a clear bias (0.8) still bleeds through.
  const strength = Math.min(1, (bestShare - 1 / 3) * 1.4 + 0.25) * (tree.maturity < 0.25 ? 0.4 : 1);
  return mixHex(base, tint, amount * strength);
}

function pocketsToTreeTargets(
  asteroid: Asteroid,
  pose: { x: number; y: number; angle: number },
): PocketTarget[] {
  const rot = pose.angle + Math.PI / 2;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const ox = pose.x - asteroid.x;
  const oy = pose.y - asteroid.y;
  const out: PocketTarget[] = [];
  for (const pocket of asteroid.pockets) {
    const pr = pocket.radiusT * asteroid.radius;
    const tx = Math.cos(pocket.angle) * pr - ox;
    const ty = Math.sin(pocket.angle) * pr - oy;
    const lx = tx * cos - ty * sin;
    const ly = tx * sin + ty * cos;
    out.push({
      x: lx,
      y: ly,
      depthT: pocket.depthT,
      kind: pocket.kind,
    });
  }
  return out;
}

function longestFromCollar(
  strokes: TreeStroke[],
  collar: { x: number; y: number },
  inward: boolean,
): TreeStroke | null {
  let best: TreeStroke | null = null;
  let bestLen = 0;
  for (const s of strokes) {
    if (inward) {
      if (s.kind !== 'root') continue;
    } else if (s.kind !== 'wood' && s.kind !== 'twig') continue;
    if (!nearPt(s.points[0], collar, 2.8)) continue;
    const tip = s.points[s.points.length - 1];
    if (!tip) continue;
    const isIn = tip.y > collar.y + 2;
    if (isIn !== inward) continue;
    const len = polylineLen(s.points);
    if (len > bestLen) {
      best = s;
      bestLen = len;
    }
  }
  return best;
}

function paintThroughCrust(
  g: Graphics,
  canopy: TreeStroke | null,
  inward: TreeStroke | null,
  pal: FloraPalette,
  inwardLayer: boolean,
): void {
  if (!canopy || !inward) return;
  const w = Math.max(canopy.widthStart, inward.widthStart);
  const nick = Math.max(2.2, w * 0.38);
  const reach = Math.max(6.5, w * 1.15);
  const down = prefixUntil(inward.points, inwardLayer ? reach : nick);
  const up = prefixUntil(canopy.points, inwardLayer ? nick : reach);
  const plug = [...down.slice().reverse(), ...up.slice(1)];
  if (plug.length < 2) return;
  // Plug geometry: t=0 sits at the deepest root tip, t=1 climbs into the
  // canopy. Anchor the root hue at the deep end and wood hue at the top so
  // the surface (midpoint) gets a wide, soft crossover instead of a hard
  // line. The wood-layer plug is almost entirely canopy, so both anchors
  // collapse to wood and the blend stays invisible.
  const from = inwardLayer ? pal.root : pal.wood;
  const to = pal.wood;
  const join = mixHex(from, to, 0.5);
  // Feathered outer halo: spread the gradient across almost the whole plug.
  ribbon(g, plug, w * 1.18, w * 1.02, join, 0.18, 3, join, 0, 1, false, false);
  // Wide mid-body wash: keeps wood and root visible at their ends while
  // blending smoothly through the join.
  ribbon(g, plug, w * 1.02, w * 0.94, from, 0.38, 3, to, 0.1, 0.9, false, false);
  // Inner definition: a narrower crossover band gives the eye something
  // to land on without snapping the colour.
  ribbon(g, plug, w * 0.92, w * 0.82, from, 0.82, 3, to, 0.3, 0.7, false, false);
}

function paintWoodBands(
  g: Graphics,
  s: TreeStroke,
  pal: FloraPalette,
  inward: boolean,
  surfaceY: number,
  wellSpan: number,
): void {
  let midY = 0;
  for (const p of s.points) midY += p.y;
  midY /= Math.max(1, s.points.length);
  const depth = Math.min(1, Math.max(0, (midY - surfaceY) / wellSpan));
  const tint = inward ? Math.max(0, depth - 0.18) * 0.4 : 0;
  const base = s.kind === 'twig' ? pal.tuft : pal.wood;
  const color = mixHex(base, pal.root, tint);
  ribbon(g, s.points, s.widthStart + 0.9, s.widthEnd + 0.45, color, 0.16, 3, color, 0, 1, false, true);
  ribbon(g, s.points, s.widthStart, s.widthEnd, color, 0.96, 3, color, 0, 1, false, true);
  if (s.kind === 'wood') {
    ribbon(
      g,
      s.points,
      s.widthStart * 0.4,
      s.widthEnd * 0.32,
      mixHex(pal.tuft, pal.root, tint * 0.7),
      0.24,
      3,
      mixHex(pal.tuft, pal.root, tint * 0.7),
      0,
      1,
      false,
      true,
    );
  }
}

function chaikin(
  points: { x: number; y: number }[],
  iterations = 2,
): { x: number; y: number }[] {
  let pts = points;
  for (let k = 0; k < iterations; k++) {
    if (pts.length < 2) break;
    const next: { x: number; y: number }[] = [{ x: pts[0]!.x, y: pts[0]!.y }];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      next.push({
        x: a.x * 0.75 + b.x * 0.25,
        y: a.y * 0.75 + b.y * 0.25,
      });
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        y: a.y * 0.25 + b.y * 0.75,
      });
    }
    next.push({
      x: pts[pts.length - 1]!.x,
      y: pts[pts.length - 1]!.y,
    });
    pts = next;
  }
  return pts;
}

function ribbon(
  g: Graphics,
  points: { x: number; y: number }[],
  widthStart: number,
  widthEnd: number,
  color: number,
  alpha: number,
  chaikinPasses = 3,
  colorEnd?: number,
  blendFrom = 0,
  blendTo = 1,
  capStart = true,
  capEnd = true,
): void {
  const pts = chaikin(points, chaikinPasses);
  if (pts.length < 2) return;

  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    const u = t ** 0.68;
    const w = (widthStart + (widthEnd - widthStart) * u) * 0.5;
    let dx: number;
    let dy: number;
    if (i === 0) {
      dx = pts[1]!.x - pts[0]!.x;
      dy = pts[1]!.y - pts[0]!.y;
    } else if (i === pts.length - 1) {
      dx = pts[i]!.x - pts[i - 1]!.x;
      dy = pts[i]!.y - pts[i - 1]!.y;
    } else {
      dx = pts[i + 1]!.x - pts[i - 1]!.x;
      dy = pts[i + 1]!.y - pts[i - 1]!.y;
    }
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const p = pts[i]!;
    left.push({ x: p.x + nx * w, y: p.y + ny * w });
    right.push({ x: p.x - nx * w, y: p.y - ny * w });
  }

  const end = colorEnd ?? color;
  const blendT = (t: number) => {
    if (end === color) return 0;
    const lo = blendFrom;
    const hi = Math.max(lo + 1e-4, blendTo);
    const u = Math.min(1, Math.max(0, (t - lo) / (hi - lo)));
    return u * u * (3 - 2 * u);
  };

  if (end === color) {
    g.moveTo(left[0]!.x, left[0]!.y);
    for (let i = 1; i < left.length; i++) g.lineTo(left[i]!.x, left[i]!.y);
    for (let i = right.length - 1; i >= 0; i--) g.lineTo(right[i]!.x, right[i]!.y);
    g.closePath();
    g.fill({ color, alpha });
  } else {
    for (let i = 0; i < pts.length - 1; i++) {
      const t0 = i / (pts.length - 1);
      const t1 = (i + 1) / (pts.length - 1);
      const col = mixHex(color, end, blendT((t0 + t1) * 0.5));
      g.moveTo(left[i]!.x, left[i]!.y);
      g.lineTo(left[i + 1]!.x, left[i + 1]!.y);
      g.lineTo(right[i + 1]!.x, right[i + 1]!.y);
      g.lineTo(right[i]!.x, right[i]!.y);
      g.closePath();
      g.fill({ color: col, alpha });
    }
  }

  if (capStart) {
    g.circle(pts[0]!.x, pts[0]!.y, widthStart * 0.5);
    g.fill({ color, alpha });
  }
  if (capEnd) {
    g.circle(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y, widthEnd * 0.5);
    g.fill({ color: end, alpha });
  }
}

function drawLeaf(
  g: Graphics,
  x: number,
  y: number,
  angle: number,
  length: number,
  width: number,
  color: number,
  alpha: number,
): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const px = -s;
  const py = c;
  const tipX = x + c * length + px * width * 0.22;
  const tipY = y + s * length + py * width * 0.22;
  g.moveTo(x, y);
  g.quadraticCurveTo(
    x + c * length * 0.4 + px * width * 1.15,
    y + s * length * 0.4 + py * width * 1.15,
    tipX,
    tipY,
  );
  g.quadraticCurveTo(
    x + c * length * 0.58 - px * width * 0.72,
    y + s * length * 0.58 - py * width * 0.72,
    x,
    y,
  );
  g.closePath();
  g.fill({ color, alpha });
}

function bloomSize(base: number, kind: TreeKind): number {
  return kind === 'energy' ? base * 1.35 : kind === 'defense' ? base * 0.9 : base;
}

function hashBloomId(treeSeed: number, index: number): number {
  return (treeSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
}

function drawBloom(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  pal: FloraPalette,
  scene: ScenePalette,
  kind: TreeKind,
  treeSeed: number,
  index: number,
  faction: import('../sim/types').FactionId,
  hasSeedling: boolean,
): void {
  const seedlingKind: import('../sim/types').SeedlingKind =
    kind === 'energy' ? 'sentinel' : 'basic';
  const hullId = hashBloomId(treeSeed, index);
  // Pod color must read against the leaf green wash behind it.
  const podColor =
    kind === 'energy'
      ? mixHex(pal.core, pal.coreWhite, 0.35)
      : pal.core;
  const podTip = pal.coreWhite;
  const open = hasSeedling ? 0.95 : 0.55;

  // Approximate hull size for the calyx brackets.
  const approxHull = {
    bodyLength: size * 0.36,
    bodyWidth: size * 0.13,
  };

  // Faint glow halo behind the pod — soft rings, not a hard ellipse edge.
  // Sized wide enough that the bloom dominates the leaf blob sitting at
  // the same point instead of being eaten by it.
  paintSoftRing(g, x, y, size * 1.4, size * 0.85, podColor, 0.22, 5);
  paintSoftRing(g, x, y, size * 1.0, size * 0.62, podColor, 0.32, 4);

  // Calyx brackets.
  paintCalyx(g, approxHull, size, podColor, podTip, open, kind === 'defense');

  // The seed hull drawn through the same painter as the flying seedling.
  // Sized so the bodyLength of the bloom ≈ the flying hull. When the seed
  // has departed, the seedling sprite owns this hull — drawing it again
  // here produced a doubled silhouette where the two layers disagreed.
  if (!hasSeedling) {
    const hullScale = size * 0.2;
    paintSeedHull(g, {
      stats: { energy: 100, strength: 70, speed: 90 },
      scene,
      faction,
      kind: seedlingKind,
      id: hullId,
      scale: hullScale,
      open,
      departure: 0.5,
    });
  }

  // Energy trees get an extra rim of light around the pod — also softened.
  if (kind === 'energy') {
    paintSoftRing(g, x, y, size * 0.55, size * 0.38, pal.core, 0.22, 4);
  }
}
