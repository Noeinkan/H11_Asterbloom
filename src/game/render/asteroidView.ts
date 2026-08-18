import { Container, Graphics, Text } from 'pixi.js';
import {
  groveSpread,
  lifeDensity,
  lifeLushScale,
  lifeProximity,
  lifeReach,
  lifeSpread,
  shortestAngle,
} from '../sim/life';
import {
  FLOWER_POLLEN_OPEN,
  rootFeedActive,
  treeFlowersWorld,
  type TreeFlower,
} from '../sim/lsystem';
import { mulberry32, range } from '../sim/rng';
import { rockOutline, rockRadiusAt, slotPolar } from '../sim/rock';
import {
  canPlantKind,
  treeVisualScale,
  type Asteroid,
  type FactionId,
  type Tree,
  type TreeKind,
  type World,
} from '../sim/types';
import {
  getOccupiedSlots,
  hasHostileOrbiters,
  hasHostileTrees,
  plantPose,
} from '../sim/world';
import {
  bucketHue,
  factionCoreHue,
  floraPalette,
  hslToHex,
  mixHex,
  resourceKindHex,
  sapRiseU,
  sapStage,
  SAP_WINDOW,
  type FloraPalette,
  type ScenePalette,
} from './palette';
import { paintSoftRing } from './treeView';

const NO_TREES: Tree[] = [];
const SUBSTRATE_BINS = 180;
const POLLEN_CAP = 64;
const LIFE_ANIM_DT = 1 / 12;
/**
 * Pocket orbs and the moss film breathe slowly, but both were rebuilding
 * their whole `Graphics` every frame — the pockets alone are ~15 filled
 * shapes each, and the film re-tessellates a rim polygon plus 180 speckles.
 * Rebuilding at 12 Hz is indistinguishable from 60 Hz for a 1 Hz pulse and
 * costs a fifth of the geometry work.
 */
const POCKET_ANIM_DT = 1 / 12;
const FILM_ANIM_DT = 1 / 12;

/**
 * Film inset as a fraction of rock radius — stays near ROCK_SURFACE_INSET.
 * Unused constants from the original film-front model were dropped after the
 * substrate Float32Array took over; the leftover comments document the
 * intent that drove their values if the model is ever revived.
 */

export class AsteroidView {
  readonly root = new Container();
  readonly pollenRoot = new Container();
  readonly asteroidId: number;
  private core: Graphics;
  private slotsGfx: Graphics;
  private selectionRing: Graphics;
  private label: Text;
  private pal: FloraPalette;
  private rock: Graphics;
  private film: Graphics;
  private grass: Graphics;
  private grassSap: Graphics;
  private pocketsGfx: Graphics;
  private pocketFlashUntil = new Map<number, number>();
  private pocketLastAmount = new Map<number, number>();
  private pollenGfx: Graphics;
  private halo: Graphics;
  private lastSelected = false;
  private lastPlantKey = '';
  private lastOwner: FactionId;
  private lastShieldKey = '';
  private lastShield = -1;
  private lastLifeKey = '';
  private lastFeedKey = '';
  private hitPulseUntil = 0;
  private pulsePhase: number;
  private bits: GrassBit[] = [];
  private fieldKey = '';
  private localTrees: Tree[] = NO_TREES;
  private pollen: PollenGrain[] = [];
  private pollenAcc = 0;
  private pollenTime = 0;
  private pollenRng: () => number;
  private substrate: Float32Array = new Float32Array(SUBSTRATE_BINS);
  private filmJitter: Float32Array = new Float32Array(SUBSTRATE_BINS);
  private bloomCache = new Map<number, { key: string; blooms: TreeFlower[] }>();
  private grassAcc = 0;
  private lastGrassTime = 0;
  private pocketPaintedAt = -Infinity;
  private filmPaintedAt = -Infinity;
  private stainAcc = 0;
  private substrateDirty = true;
  private lifeDirty = true;
  private seededTrees = new Set<number>();
  private lastHueBucket = -1;
  private lastTheme: ScenePalette['theme'] | undefined;

  constructor(asteroid: Asteroid, scene: ScenePalette) {
    this.asteroidId = asteroid.id;
    this.pal = floraPalette(asteroid.stats, asteroid.seed, scene);
    this.lastOwner = asteroid.owner;
    this.lastShield = asteroid.shield;
    this.pulsePhase = (asteroid.seed % 1000) * 0.013;
    this.pollenRng = mulberry32((asteroid.seed ^ 0x51ed) >>> 0);
    const jitterRng = mulberry32((asteroid.seed ^ 0x51edc0de) >>> 0);
    for (let i = 0; i < SUBSTRATE_BINS; i++) this.filmJitter[i] = jitterRng();
    this.root.position.set(asteroid.x, asteroid.y);
    this.pollenRoot.position.set(asteroid.x, asteroid.y);
    this.pollenRoot.eventMode = 'none';

    this.halo = new Graphics();
    this.root.addChild(this.halo);

    this.rock = new Graphics();
    this.root.addChild(this.rock);
    paintRock(this.rock, asteroid, this.pal);

    this.film = new Graphics();
    this.film.eventMode = 'none';
    this.root.addChild(this.film);

    this.grass = new Graphics();
    this.grass.eventMode = 'none';
    this.root.addChild(this.grass);

    this.grassSap = new Graphics();
    this.grassSap.eventMode = 'none';
    this.grassSap.blendMode = 'add';
    this.root.addChild(this.grassSap);

    this.pocketsGfx = new Graphics();
    this.pocketsGfx.eventMode = 'none';
    this.root.addChild(this.pocketsGfx);

    this.pollenGfx = new Graphics();
    this.pollenGfx.eventMode = 'none';
    this.pollenRoot.addChild(this.pollenGfx);

    this.core = new Graphics();
    this.root.addChild(this.core);

    this.selectionRing = new Graphics();
    this.root.addChild(this.selectionRing);

    this.slotsGfx = new Graphics();
    this.root.addChild(this.slotsGfx);

    this.label = new Text({
      text: asteroid.name,
      style: {
        fontFamily: 'Comfortaa, Nunito, "Segoe UI", system-ui, sans-serif',
        fontSize: 13,
        fontWeight: '600',
        fill: scene.inkSoft,
        align: 'center',
      },
    });
    this.label.anchor.set(0.5, 0);
    this.label.position.set(0, asteroid.radius + 18);
    this.label.alpha = 0.7;
    this.root.addChild(this.label);

    this.redrawCore(asteroid, false);
    this.redrawSlots(asteroid, new Set(), false);
    this.redrawHalo(asteroid, false);
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.pollenRoot.destroy({ children: true });
  }

  update(
    asteroid: Asteroid,
    selected: boolean,
    plantableSlots: Set<number>,
    trees: Tree[] = NO_TREES,
  ): void {
    this.root.position.set(asteroid.x, asteroid.y);
    this.pollenRoot.position.set(asteroid.x, asteroid.y);
    let plantKey = `${plantableSlots.size}`;
    for (const i of plantableSlots) plantKey += `,${i}`;
    const shieldKey = `${Math.round(asteroid.shield)}/${Math.round(asteroid.maxShield)}`;
    const selChanged = selected !== this.lastSelected;
    const ownerChanged = asteroid.owner !== this.lastOwner;
    const shieldChanged = shieldKey !== this.lastShieldKey;
    const now = performance.now();
    const t = now / 1000;
    const dt = Math.min(0.05, Math.max(0, t - this.lastGrassTime));
    this.lastGrassTime = t;
    if (this.lastShield >= 0 && asteroid.shield < this.lastShield - 0.05) {
      this.hitPulseUntil = now + 280;
    }
    this.lastShield = asteroid.shield;
    this.localTrees = trees;
    const feedKey = feedKeyFor(trees);
    const feedChanged = feedKey !== this.lastFeedKey;
    if (selChanged || ownerChanged || shieldChanged || feedChanged) {
      this.redrawCore(asteroid, selected, trees);
      this.redrawHalo(asteroid, selected);
      this.lastSelected = selected;
      this.lastOwner = asteroid.owner;
      this.lastShieldKey = shieldKey;
      this.lastFeedKey = feedKey;
    }
    if (ownerChanged) {
      paintRock(this.rock, asteroid, this.pal);
    }
    if (plantKey !== this.lastPlantKey || selChanged) {
      this.redrawSlots(asteroid, plantableSlots, selected);
      this.lastPlantKey = plantKey;
    }
    this.tickPollen(asteroid, trees, t);
    this.syncGrass(asteroid, trees, t, dt);
    if (this.label.text !== asteroid.name) this.label.text = asteroid.name;

    const feed = maxFeed(trees);
    let launch = 0;
    for (const tree of trees) {
      const live = rootFeedActive(tree.maturity, tree.coreFeed);
      if (live < 0.02) continue;
      const u = sapRiseU(t, tree.seed);
      if (u < 0.16) launch = Math.max(launch, (1 - u / 0.16) * live);
    }
    const pulse =
      0.88 +
      Math.sin(t * 1.35 + this.pulsePhase) * 0.12 +
      feed * (0.06 + Math.sin(t * 2.1 + this.pulsePhase) * 0.08);
    this.core.alpha = Math.min(1.28, pulse + launch * 0.28);
    this.core.scale.set(1 + launch * 0.056);
    this.halo.alpha = 0.85 + Math.sin(t * 0.7 + this.pulsePhase) * 0.15 + launch * 0.11;
    this.halo.scale.set(1 + Math.sin(t * 0.55 + this.pulsePhase) * 0.018 + launch * 0.022);

    // Animate shield with transform — do not rebuild the stroke every frame.
    if (asteroid.maxShield > 0 && asteroid.shield > 0) {
      const shimmer = 0.5 + 0.5 * Math.sin(t * 3.2 + this.pulsePhase);
      const hit = now < this.hitPulseUntil;
      this.selectionRing.alpha = 0.85 + shimmer * 0.15 + (hit ? 0.2 : 0);
      this.selectionRing.scale.set(1 + shimmer * 0.012 + (hit ? 0.03 : 0));
    } else {
      this.selectionRing.alpha = 1;
      this.selectionRing.scale.set(1);
    }

    if (t - this.pocketPaintedAt >= POCKET_ANIM_DT) {
      this.pocketPaintedAt = t;
      this.rebuildPocketCache(asteroid);
      this.paintPockets(asteroid, t);
    }
  }

  private paintPockets(asteroid: Asteroid, time: number): void {
    const g = this.pocketsGfx;
    g.clear();
    g.alpha = 1;
    const pockets = asteroid.pockets;
    if (pockets.length === 0) return;

    for (const pocket of pockets) {
      const px = Math.cos(pocket.angle) * pocket.radiusT * asteroid.radius;
      const py = Math.sin(pocket.angle) * pocket.radiusT * asteroid.radius;
      const depthA = 0.55 + (1 - pocket.depthT) * 0.35;
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.9 + pocket.phase);
      const kColor = resourceKindHex(pocket.kind, this.pal);
      // Ring sizes track the rock so a pocket reads as a subsurface orb,
      // not a speck. Full pockets swell slightly with the amount left.
      const fill =
        pocket.maxAmount > 0 ? pocket.amount / pocket.maxAmount : 1;
      const size = asteroid.radius * 0.1 * (0.72 + 0.28 * fill);

      // Feeding flash: brighten briefly when the pocket is actively drained.
      const last = this.pocketLastAmount.get(pocket.id);
      if (last !== undefined && last - pocket.amount > 0.001) {
        this.pocketFlashUntil.set(pocket.id, time + 0.6);
      }
      this.pocketLastAmount.set(pocket.id, pocket.amount);
      const flashUntil = this.pocketFlashUntil.get(pocket.id) ?? 0;
      const flash = Math.max(0, Math.min(1, (flashUntil - time) / 0.6));
      if (flashUntil < time) this.pocketFlashUntil.delete(pocket.id);

      paintSoftRing(
        g,
        px,
        py,
        size,
        -1,
        mixHex(this.pal.rootGlow, kColor, 0.35),
        (0.16 + 0.1 * pulse) * depthA,
        5,
      );
      paintSoftRing(
        g,
        px,
        py,
        size * 0.64,
        -1,
        mixHex(this.pal.rootGlow, kColor, 0.6),
        (0.28 + 0.12 * pulse) * depthA,
        4,
      );
      paintSoftRing(
        g,
        px,
        py,
        size * 0.26,
        -1,
        kColor,
        (0.5 + 0.16 * pulse + flash * 0.45) * depthA,
        3,
      );

      if (flash > 0.001) {
        paintSoftRing(
          g,
          px,
          py,
          size * 0.85,
          -1,
          kColor,
          0.3 * flash * depthA,
          3,
        );
      }

      // Subtle kind glyph so water / mineral / energy are distinguishable
      // without dominating the soft orb. Sized under 40% of the pocket so
      // it never overwhelms the resource cost it sits inside.
      paintPocketGlyph(g, px, py, size * 0.36, pocket.kind, kColor, depthA, pulse);
    }
  }

  /**
   * Tiny shape inside the pocket that hints at the resource family without
   * breaking the soft pastel palette. Three glyphs:
   *   - mineral: angled diamond (think crystal lattice)
   *   - water:   flat ellipse + crescent (meniscus)
   *   - energy:  four short spikes (spark)
   * All rendered at low alpha so the layer reads as a hint, not an icon.
   */
  private pickPocketCache: {
    id: number;
    x: number;
    y: number;
    r: number;
    kind: 'mineral' | 'water' | 'energy';
  }[] = [];

  pickPocket(worldX: number, worldY: number): { pocketId: number; asteroidId: number } | null {
    for (const p of this.pickPocketCache) {
      const dx = p.x - worldX;
      const dy = p.y - worldY;
      if (dx * dx + dy * dy <= p.r * p.r) {
        return { pocketId: p.id, asteroidId: this.asteroidId };
      }
    }
    return null;
  }

  private rebuildPocketCache(asteroid: Asteroid): void {
    this.pickPocketCache.length = 0;
    for (const pocket of asteroid.pockets) {
      this.pickPocketCache.push({
        id: pocket.id,
        x: Math.cos(pocket.angle) * pocket.radiusT * asteroid.radius,
        y: Math.sin(pocket.angle) * pocket.radiusT * asteroid.radius,
        r: asteroid.radius * 0.13,
        kind: pocket.kind,
      });
    }
  }

  retheme(
    asteroid: Asteroid,
    scene: ScenePalette,
    selected: boolean,
    plantableSlots: Set<number>,
    trees: Tree[] = NO_TREES,
  ): void {
    // 1° hue bucket: ~360 repaints per full cycle. Visually smooth, cheap.
    const bucket = bucketHue(scene.hue);
    const themeChanged = scene.theme !== undefined && scene.theme !== this.lastTheme;
    // The label fill used to be written on this early-out path too. `inkSoft`
    // drifts with the hue, so that assignment landed a new value most frames
    // and re-rasterized the name texture — for every rock, every frame. It
    // now moves with the rest of the palette, below.
    if (bucket === this.lastHueBucket && !themeChanged) return;
    this.lastHueBucket = bucket;
    this.lastTheme = scene.theme;
    this.pal = floraPalette(asteroid.stats, asteroid.seed, scene);
    paintRock(this.rock, asteroid, this.pal);
    this.redrawCore(asteroid, selected, trees);
    this.redrawHalo(asteroid, selected);
    this.redrawSlots(asteroid, plantableSlots, selected);
    this.lastLifeKey = '';
    this.lifeDirty = true;
    this.substrateDirty = true;
    this.syncGrass(asteroid, trees, performance.now() / 1000, LIFE_ANIM_DT);
    this.label.style.fill = scene.inkSoft;
  }

  private syncGrass(
    asteroid: Asteroid,
    trees: Tree[],
    time: number,
    dt: number,
  ): void {
    this.ensureField(asteroid);
    let growing = false;
    let key = `${trees.length}`;
    for (const tree of trees) {
      key += `|${tree.slotIndex}:${tree.id}:${maturityBucket(tree.maturity)}`;
      if (tree.maturity < 0.999) growing = true;
    }
    const feed = maxFeed(trees);
    const keyChanged = key !== this.lastLifeKey;
    if (keyChanged) this.lastLifeKey = key;

    const needsAnim = growing || feed > 0.02;
    if (keyChanged || this.lifeDirty) {
      this.lifeDirty = false;
      this.grassAcc = 0;
      paintLife(
        this.grass,
        this.grassSap,
        asteroid,
        this.pal,
        this.bits,
        trees,
        time,
        this.substrate,
      );
    } else if (!needsAnim) {
      return;
    }
    if (needsAnim) {
      this.grassAcc += dt;
      if (this.grassAcc < LIFE_ANIM_DT && !keyChanged) return;
      this.grassAcc = 0;
      paintGroveSap(this.grassSap, asteroid, this.pal, trees, time);
    }
  }

  private ensureField(asteroid: Asteroid): void {
    const key = `${asteroid.seed}:${asteroid.radius}:${asteroid.treeSlots}`;
    if (key === this.fieldKey) return;
    this.fieldKey = key;
    this.bits = buildGrassField(asteroid);
  }

  private bloomsFor(asteroid: Asteroid, tree: Tree): TreeFlower[] {
    const key = `${tree.seed}:${maturityBucket(tree.maturity)}:${tree.kind}`;
    const hit = this.bloomCache.get(tree.id);
    if (hit && hit.key === key) return hit.blooms;
    const scale = treeVisualScale(asteroid.radius, asteroid.seed);
    const polar = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
    const blooms = treeFlowersWorld(
      tree.seed,
      tree.maturity,
      scale,
      0,
      0,
      0,
      polar.dist,
      polar.surfaceY,
      tree.kind,
      FLOWER_POLLEN_OPEN,
    );
    this.bloomCache.set(tree.id, { key, blooms });
    return blooms;
  }

  private tickPollen(asteroid: Asteroid, trees: Tree[], time: number): void {
    const g = this.pollenGfx;
    const showMotes = this.pollenRoot.parent != null;
    if (showMotes) g.clear();
    const dt = Math.min(0.05, Math.max(0, time - this.pollenTime));
    this.pollenTime = time;
    const rng = this.pollenRng;

    // A rock holds a handful of trees, so a linear scan is cheaper than the
    // Set + two spread copies this used to allocate every frame per rock.
    // Deleting the current entry mid-iteration is well defined for Map/Set.
    for (const id of this.seededTrees) {
      if (!hasTreeId(trees, id)) this.seededTrees.delete(id);
    }
    for (const id of this.bloomCache.keys()) {
      if (!hasTreeId(trees, id)) this.bloomCache.delete(id);
    }
    if (trees.length === 0) {
      this.pollen.length = 0;
      this.pollenAcc = 0;
      let remaining = false;
      for (let i = 0; i < SUBSTRATE_BINS; i++) {
        if (this.substrate[i]! <= 0.001) continue;
        this.substrate[i] *= Math.max(0, 1 - dt * 1.8);
        remaining = true;
      }
      if (remaining) this.substrateDirty = true;
      this.paintSubstrate(asteroid, time);
      return;
    }

    for (const tree of trees) {
      if (this.seededTrees.has(tree.id) || tree.maturity < 0.06) continue;
      const polar = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
      this.stainArc(polar.angle, 0.07, 0.36);
      this.seededTrees.add(tree.id);
    }

    // Active substrate creep: even before blooms open, the sward keeps
    // expanding along the rim so grass follows lifeSpread without waiting
    // for the first pollen grains to fall. A full arc touches a few hundred
    // bins, so the creep runs on the film cadence with the elapsed time
    // banked up — same total staining, a twelfth of the work.
    this.stainAcc += dt;
    if (this.stainAcc >= FILM_ANIM_DT) {
      const stainDt = this.stainAcc;
      this.stainAcc = 0;
      for (const tree of trees) {
        if (tree.maturity < 0.18) continue;
        const polar = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
        const reach = Math.min(1.2, Math.max(0, (tree.maturity - 0.18) / 0.82));
        const span = 0.05 + 1.1 * reach;
        this.stainArc(polar.angle, span, stainDt * (0.18 + 0.45 * reach));
      }
    }

    if (!showMotes) {
      this.paintSubstrate(asteroid, time);
      return;
    }

    const breeze =
      Math.sin(time * 0.29 + this.pulsePhase) * 0.7 +
      Math.sin(time * 0.61 + this.pulsePhase * 1.5) * 0.28;
    const gust =
      Math.max(0, Math.sin(time * 0.17 + this.pulsePhase * 0.7) - 0.62) * 2.4;

    for (const tree of trees) {
      const blooms = this.bloomsFor(asteroid, tree);
      if (blooms.length === 0) continue;
      this.pollenAcc += dt * blooms.length * 0.16;
    }
    while (this.pollenAcc >= 1 && this.pollen.length < POLLEN_CAP) {
      this.pollenAcc -= 1;
      const blooming = trees.filter((t) => this.bloomsFor(asteroid, t).length > 0);
      if (blooming.length === 0) break;
      const tree = blooming[Math.floor(rng() * blooming.length)]!;
      const blooms = this.bloomsFor(asteroid, tree);
      const flower = blooms[Math.floor(rng() * blooms.length)]!;
      const puff = rng() < 0.34 ? 2 + Math.floor(rng() * 4) : 1;
      for (let k = 0; k < puff && this.pollen.length < POLLEN_CAP; k++) {
        this.pollen.push(
          spawnPollenFromFlower(asteroid, tree, flower, rng, breeze, time),
        );
      }
    }
    this.pollenAcc = Math.min(this.pollenAcc, 3);

    const next: PollenGrain[] = [];
    const rimScale = asteroid.radius;
    for (const grain of this.pollen) {
      grain.age += dt;
      if (grain.settled) {
        grain.settle += dt;
        if (grain.settle > 0.7) continue;
        if (showMotes) {
          const p = crustPoint(asteroid, grain.theta, -0.4);
          g.circle(p.x, p.y, grain.size * (0.55 + grain.settle * 0.4));
          g.fill({
            color: mixHex(this.pal.flower, this.pal.film, 0.35),
            alpha: 0.16 * (1 - grain.settle / 0.7),
          });
        }
        next.push(grain);
        continue;
      }
      if (grain.age > grain.life) {
        grain.settled = true;
        grain.settle = 0;
        this.stain(grain.theta, 0.028);
        next.push(grain);
        continue;
      }

      const flutter = Math.sin(time * 6.4 + grain.wobble) * 11;
      const wander = Math.sin(time * 2.15 + grain.wobble * 1.7) * 7;
      const theta = Math.atan2(grain.y, grain.x);
      const dist = Math.hypot(grain.x, grain.y) || 1;
      const rim = rockRadiusAt(asteroid, theta);
      const tx = -Math.sin(theta);
      const ty = Math.cos(theta);
      const nx = Math.cos(theta);
      const ny = Math.sin(theta);
      const hover = dist - rim;

      grain.vx +=
        (tx * (breeze * 16 + wander) + nx * (gust * 12 - 5.5 + flutter)) * dt;
      grain.vy +=
        (ty * (breeze * 16 + wander) + ny * (gust * 12 - 5.5 + flutter)) * dt;
      grain.vx *= 0.965;
      grain.vy *= 0.965;
      grain.x += grain.vx * dt;
      grain.y += grain.vy * dt;

      const nextTheta = Math.atan2(grain.y, grain.x);
      const nextDist = Math.hypot(grain.x, grain.y) || 1;
      const nextRim = rockRadiusAt(asteroid, nextTheta);
      const da = shortestAngle(grain.originTheta, nextTheta);
      if (Math.abs(da) > grain.capReach) {
        const clamped = grain.originTheta + Math.sign(da) * grain.capReach;
        const keep = Math.max(nextRim + 1.2, nextDist);
        grain.x = Math.cos(clamped) * keep;
        grain.y = Math.sin(clamped) * keep;
        grain.vx *= -0.28;
        grain.vy *= -0.28;
      }
      if (nextDist > nextRim + rimScale * 0.42) {
        grain.vx -= nx * 22 * dt;
        grain.vy -= ny * 22 * dt;
      }
      if (nextDist < nextRim + 1.05) {
        grain.x = nx * (nextRim + 1.05);
        grain.y = ny * (nextRim + 1.05);
        if (grain.age > 1.6 && hover < 2.2) {
          grain.settled = true;
          grain.settle = 0;
          grain.theta = nextTheta;
          this.stain(nextTheta, 0.032);
        } else {
          grain.vx += nx * 6;
          grain.vy += ny * 6;
        }
      } else {
        grain.theta = nextTheta;
      }

      if (showMotes) drawPollenMote(g, grain, this.pal, time);
      next.push(grain);
    }
    this.pollen = next;
    this.paintSubstrate(asteroid, time);
  }

  private stain(theta: number, amount: number): void {
    if (amount <= 0) return;
    this.substrateDirty = true;
    const n = SUBSTRATE_BINS;
    const u = ((theta / (Math.PI * 2)) % 1 + 1) % 1;
    const mid = u * n;
    const i0 = Math.floor(mid);
    for (let k = -2; k <= 2; k++) {
      const i = ((i0 + k) % n + n) % n;
      const dist = Math.abs(mid - i0 - k);
      const w = k === 0 ? 1 : Math.max(0, 1 - dist * 0.55);
      this.substrate[i] = Math.min(1, this.substrate[i]! + amount * w);
    }
  }

  private stainArc(center: number, span: number, amount: number): void {
    const steps = Math.max(3, Math.ceil(span * SUBSTRATE_BINS));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps - 0.5;
      this.stain(center + t * span * 2, amount * (1 - Math.abs(t) * 0.65));
    }
  }

  private paintSubstrate(asteroid: Asteroid, time: number): void {
    if (!this.substrateDirty) return;
    // The substrate is stained a little every frame while a tree grows, so
    // the dirty flag alone would mean a full re-tessellation at 60 Hz. Hold
    // the flag until the next slot instead — the moss creeps at the speed of
    // tree growth, nowhere near frame rate.
    if (time - this.filmPaintedAt < FILM_ANIM_DT) return;
    this.filmPaintedAt = time;
    this.substrateDirty = false;
    const g = this.film;
    g.clear();
    const n = SUBSTRATE_BINS;
    // Soft run-edge floor: bins below EDGE_FLOOR are skipped entirely so the
    // moss doesn't bleed into bare rock. Bins above it are included, but the
    // per-vertex alpha taper (below) keeps their contribution feathered
    // instead of as a hard cliff.
    const EDGE_FLOOR = 0.18;
    const runs: { start: number; len: number }[] = [];
    let i = 0;
    while (i < n) {
      const c = this.substrate[i]!;
      if (c < EDGE_FLOOR) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < n && this.substrate[i]! >= EDGE_FLOOR) i += 1;
      runs.push({ start, len: i - start });
    }
    if (
      runs.length >= 2 &&
      runs[0]!.start === 0 &&
      runs[runs.length - 1]!.start + runs[runs.length - 1]!.len === n
    ) {
      const last = runs.pop()!;
      runs[0] = { start: last.start, len: last.len + runs[0]!.len };
    }
    // Extend each run by 1 bin on each side so the falloff has room to
    // feather. The poly loop below clamps the fringe with `fringe`.
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]!;
      runs[r] = {
        start: (run.start - 1 + n) % n,
        len: run.len + 2,
      };
    }
    if (
      runs.length >= 2 &&
      runs[0]!.start === 0 &&
      runs[runs.length - 1]!.start + runs[runs.length - 1]!.len === n
    ) {
      const last = runs.pop()!;
      runs[0] = { start: last.start, len: last.len + runs[0]!.len };
    }

    for (const run of runs) {
      const rimPts: Pt[] = [];
      const grassPts: Pt[] = [];
      for (let k = 0; k <= run.len; k++) {
        const idx = (run.start + k) % n;
        const c = this.substrate[idx]!;
        const jitter = this.filmJitter[idx]!;
        const theta = (idx / n) * Math.PI * 2;
        // Follow the lumpy rim, not a perfect circle. The crust bumps in
        // and out per bearing; the moss sits ~1 unit above that curve and
        // hugs it from below, so the green wraps the rock instead of
        // cutting a straight arc across it. A per-theta ripple keeps the
        // outer edge from reading as a smooth ring at close zoom.
        const rim = rockRadiusAt(asteroid, theta);
        const ripple = Math.sin(theta * 7.0 + jitter * 6.28) * 0.4;
        const outerR = rim + 1.0 + jitter * 0.6 + ripple + c * 0.6;
        const innerR = rim - 0.2;
        rimPts.push({ x: Math.cos(theta) * innerR, y: Math.sin(theta) * innerR });
        grassPts.push({ x: Math.cos(theta) * outerR, y: Math.sin(theta) * outerR });
      }
      const soil = grassPts.concat(rimPts.reverse());
      if (soil.length < 6) continue;
      const mid = this.substrate[run.start]!;
      const tone = this.filmJitter[run.start]!;
      // First pass: earthy base mix — more rock-like where moss is thin,
      // more leaf-like where it's mature.
      g.poly(soil);
      g.fill({
        color: mixHex(this.pal.film, this.pal.rock, 0.32 - 0.18 * mid),
        alpha: 0.12 + mid * 0.16,
      });
      // Second pass: chlorophyll tint biased by distance-from-tree proxy
      // (we use the local filmJitter as a chaotic pseudo-coverage marker).
      const leafBias = tone > 0.5 ? this.pal.leaf : this.pal.flower;
      g.poly(soil);
      g.fill({
        color: mixHex(this.pal.film, leafBias, 0.18 + 0.18 * mid),
        alpha: 0.14 + mid * 0.14,
      });
    }

    // Speckles — grit on the moss surface, never bowls.
    for (let i = 0; i < n; i++) {
      const c = this.substrate[i]!;
      if (c < 0.12) continue;
      const jitter = this.filmJitter[i]!;
      if (jitter < 0.38) continue;
      const theta = ((i + 0.5) / n) * Math.PI * 2;
      // Sits on the lumpy rim, just above it.
      const rim = rockRadiusAt(asteroid, theta);
      const r0 = rim + 0.8 + jitter * 0.6;
      g.circle(Math.cos(theta) * r0, Math.sin(theta) * r0, 0.7 + jitter * 1.4);
      g.fill({
        color: mixHex(this.pal.film, this.pal.grass, jitter),
        alpha: 0.18 * c,
      });
    }
  }

  private redrawHalo(asteroid: Asteroid, selected: boolean): void {
    const g = this.halo;
    g.clear();
    const r = asteroid.radius;
    const owned = asteroid.owner === 'player' || asteroid.owner === 'enemy';
    g.circle(0, 0, r * 1.12);
    g.fill({
      color: this.pal.core,
      alpha: owned ? 0.06 : selected ? 0.04 : 0.02,
    });
    g.circle(0, 0, r * 1.04);
    g.fill({ color: this.pal.rockLit, alpha: 0.08 });
  }

  private redrawCore(
    asteroid: Asteroid,
    selected: boolean,
    trees: Tree[] = this.localTrees,
  ): void {
    const g = this.core;
    g.clear();
    const hue = factionCoreHue(asteroid.owner, 48);
    const owned = asteroid.owner === 'player';
    const enemy = asteroid.owner === 'enemy';
    const grey = asteroid.owner === 'grey';
    const feed = maxFeed(trees);
    const glow = owned
      ? this.pal.core
      : enemy
        ? hslToHex(hue, 0.48, 0.58)
        : grey
          ? this.pal.rockShadow
          : this.pal.rockLit;
    const hot = owned
      ? this.pal.coreHot
      : enemy
        ? hslToHex(hue, 0.5, 0.42)
        : this.pal.rockShadow;
    g.circle(0, 0, asteroid.radius * (0.34 + feed * 0.06));
    g.fill({ color: glow, alpha: (selected ? 0.1 : 0.05) + feed * 0.12 });
    g.circle(0, 0, asteroid.radius * (0.24 + feed * 0.04));
    g.fill({ color: glow, alpha: (selected ? 0.16 : 0.08) + feed * 0.08 });
    g.circle(0, 0, asteroid.radius * 0.16);
    g.fill({ color: hot, alpha: (selected ? 0.28 : 0.16) + feed * 0.1 });
    g.circle(0, 0, asteroid.radius * 0.08);
    g.fill({ color: glow, alpha: (selected ? 0.82 : 0.62) + feed * 0.12 });
    g.circle(0, 0, asteroid.radius * 0.03);
    g.fill({ color: this.pal.coreWhite, alpha: 0.95 });

    this.selectionRing.clear();
    if (asteroid.maxShield > 0 && asteroid.shield > 0) {
      const t = asteroid.shield / asteroid.maxShield;
      this.selectionRing.circle(0, 0, asteroid.radius + 6);
      this.selectionRing.stroke({
        width: 2.2,
        color: this.pal.core,
        alpha: 0.18 + t * 0.4,
      });
    }
    if (selected) {
      this.selectionRing.circle(0, 0, asteroid.radius + 10);
      this.selectionRing.stroke({
        width: 1.4,
        color: this.pal.ring,
        alpha: 0.32,
      });
    }
  }

  private redrawSlots(
    _asteroid: Asteroid,
    _plantableSlots: Set<number>,
    _selected: boolean,
  ): void {
    this.slotsGfx.clear();
  }
}

export const EMPTY_PLANTABLE = new Set<number>();

export function plantableEmptySlots(
  world: World,
  asteroidId: number,
  localOrbitCount: number,
  kind: TreeKind = 'dyson',
  faction: FactionId = 'player',
): Set<number> {
  if (localOrbitCount < 10) return EMPTY_PLANTABLE;
  const asteroid = world.asteroids.get(asteroidId);
  if (!asteroid) return EMPTY_PLANTABLE;
  if (!canPlantKind(asteroid.stats.energy, kind)) return EMPTY_PLANTABLE;
  if (hasHostileOrbiters(world, asteroidId, faction)) return EMPTY_PLANTABLE;
  if (hasHostileTrees(world, asteroidId, faction)) return EMPTY_PLANTABLE;
  const occupied = getOccupiedSlots(world, asteroidId);
  const empty = new Set<number>();
  for (let i = 0; i < asteroid.treeSlots; i++) {
    if (!occupied.has(i)) empty.add(i);
  }
  return empty.size === 0 ? EMPTY_PLANTABLE : empty;
}

function paintPocketGlyph(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  kind: 'mineral' | 'water' | 'energy',
  color: number,
  depthA: number,
  pulse: number,
): void {
  const base = 0.4 + 0.18 * pulse;
  const alpha = base * depthA;
  if (kind === 'mineral') {
    // Diamond: rotated square at small angle. Reads as a crystal face.
    const r = size * 0.92;
    g.moveTo(x, y - r);
    g.lineTo(x + r * 0.78, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r * 0.78, y);
    g.closePath();
    g.fill({ color, alpha: alpha * 0.55 });
    g.stroke({ color, width: 0.6, alpha: alpha * 0.7 });
    // Inner facet for a hint of depth.
    g.moveTo(x, y - r * 0.55);
    g.lineTo(x + r * 0.42, y);
    g.lineTo(x, y + r * 0.55);
    g.lineTo(x - r * 0.42, y);
    g.closePath();
    g.fill({ color, alpha: alpha * 0.22 });
    return;
  }
  if (kind === 'water') {
    // Meniscus: flat ellipse on top, a thin crescent underneath.
    const rx = size * 0.86;
    const ry = size * 0.32;
    g.ellipse(x, y - size * 0.18, rx, ry);
    g.fill({ color, alpha: alpha * 0.5 });
    g.ellipse(x, y + size * 0.12, rx * 0.92, ry * 0.92);
    g.fill({ color, alpha: alpha * 0.35 });
    // Surface tension line.
    g.moveTo(x - rx * 0.85, y - size * 0.18);
    g.lineTo(x + rx * 0.85, y - size * 0.18);
    g.stroke({ color, width: 0.55, alpha: alpha * 0.7 });
    return;
  }
  // Energy: four-pulse spark. Two crossed lines clipped into the inner ring.
  const len = size * 0.94;
  const short = size * 0.55;
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const dx = Math.cos(a) * len;
    const dy = Math.sin(a) * len;
    const sx = Math.cos(a) * short;
    const sy = Math.sin(a) * short;
    g.moveTo(x - sx, y - sy);
    g.lineTo(x + dx, y + dy);
    g.stroke({ color, width: 0.7, alpha: alpha * 0.85 });
  }
  g.circle(x, y, size * 0.28);
  g.fill({ color, alpha: alpha * 0.55 });
}

function paintRock(g: Graphics, asteroid: Asteroid, pal: FloraPalette): void {
  g.clear();
  const rng = mulberry32(asteroid.seed);
  const r = asteroid.radius;
  const owned = asteroid.owner === 'player' || asteroid.owner === 'enemy';
  const wild = asteroid.owner === 'grey';
  const outline = rockOutline(asteroid, 96);

  g.poly(outline);
  g.fill({ color: pal.rock, alpha: 0.8 });

  const stains = 16 + Math.floor(rng() * 8);
  for (let i = 0; i < stains; i++) {
    const a = rng() * Math.PI * 2;
    const rim = rockRadiusAt(asteroid, a);
    const d = rng() * rim * 0.7;
    const sr = range(rng, r * 0.06, r * 0.28);
    if (d + sr > rim * 0.9) continue;
    const pick = rng();
    const color = pick > 0.7 ? pal.stain : pick > 0.4 ? pal.rockLit : pal.rockShadow;
    g.circle(Math.cos(a) * d, Math.sin(a) * d, sr);
    g.fill({ color, alpha: 0.09 + rng() * 0.1 });
  }

  g.poly(outline.map((p) => ({ x: p.x * 0.64, y: p.y * 0.64 })));
  g.fill({ color: pal.rockShadow, alpha: 0.1 });
  const litA = rng() * Math.PI * 2;
  g.circle(Math.cos(litA) * r * 0.22, Math.sin(litA) * r * 0.26, r * 0.46);
  g.fill({ color: pal.rockLit, alpha: 0.16 });
  g.circle(
    Math.cos(litA + Math.PI) * r * 0.2,
    Math.sin(litA + Math.PI) * r * 0.24,
    r * 0.36,
  );
  g.fill({ color: pal.rockShadow, alpha: 0.08 });

  if (owned || wild) {
    g.poly(outline.map((p) => ({ x: p.x * 0.52, y: p.y * 0.52 })));
    g.fill({ color: pal.stain, alpha: owned ? 0.1 : 0.05 });
    paintLichen(g, asteroid, pal, rng);
  }

    g.poly(outline);
    g.stroke({ width: 3.4, color: pal.outline, alpha: 0.1 });
    g.poly(outline.map((p) => ({ x: p.x * 0.985, y: p.y * 0.985 })));
    g.stroke({ width: 1.15, color: pal.rockShadow, alpha: 0.22 });
    // Inner highlight ring one notch inside the rim outline. At high zoom
    // the rim shadow alone reads as a flat band; the highlight keeps the
    // edge legible against the lichen wash.
    g.poly(outline.map((p) => ({ x: p.x * 0.96, y: p.y * 0.96 })));
    g.stroke({ width: 0.55, color: pal.rockLit, alpha: 0.08 });
}

/** Soft pigment on the disc — no blades sticking into space. */
function paintLichen(
  g: Graphics,
  asteroid: Asteroid,
  pal: FloraPalette,
  rng: () => number,
): void {
  const owned = asteroid.owner === 'player' || asteroid.owner === 'enemy';
  const r = asteroid.radius;
  const life = owned ? pal.leaf : pal.stain;
  const mul = owned ? 1 : 0.55;

  const islands = owned ? 4 + Math.floor(rng() * 3) : 2;
  for (let i = 0; i < islands; i++) {
    const a = rng() * Math.PI * 2;
    const rim = rockRadiusAt(asteroid, a);
    const d = rim * range(rng, 0.38, 0.74);
    const cx = Math.cos(a) * d;
    const cy = Math.sin(a) * d;
    const n = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const ox = cx + range(rng, -r * 0.12, r * 0.12);
      const oy = cy + range(rng, -r * 0.12, r * 0.12);
      const sr = range(rng, r * 0.06, r * 0.18);
      const dist = Math.hypot(ox, oy);
      const localRim = rockRadiusAt(asteroid, Math.atan2(oy, ox));
      if (dist + sr > localRim * 0.92) continue;
      const color = rng() > 0.45 ? life : pal.grass;
      g.circle(ox, oy, sr);
      g.fill({ color, alpha: (0.08 + rng() * 0.07) * mul });
    }
  }
}

type Pt = { x: number; y: number };

type GrassBit = {
  theta: number;
  x: number;
  y: number;
  lean: number;
  length: number;
  width: number;
  radius: number;
  jitter: number;
  kind: 'moss' | 'blade' | 'tuft';
  /** Tip droop as a fraction of length (AMD / Jahrmann bezier lean). */
  droop: number;
  /** 0..1 mix toward leaf / tuft color. */
  shade: number;
  /** In-plane offset (radial) of this blade relative to the rim curvature. */
  z: number;
  /** Number of companion sub-blades drawn alongside this master bit. */
  clump: number;
  slot?: number;
};

type PollenGrain = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  theta: number;
  originTheta: number;
  capReach: number;
  treeId: number;
  age: number;
  life: number;
  size: number;
  wobble: number;
  settled: boolean;
  settle: number;
};

/** Match TreeView canopy breeze so grains leave the moving blooms. */
function canopyPose(tree: Tree, time: number): { rot: number; scale: number } {
  const phase = (tree.seed % 1000) * 0.017;
  const young = 1 - tree.maturity;
  const breeze =
    (Math.sin(time * 0.55 + phase) * 0.055 +
      Math.sin(time * 1.08 + phase * 1.37) * 0.022 +
      Math.sin(time * 1.84 + phase * 0.71) * 0.01) *
    (1 + young * 1.35);
  return {
    rot: breeze,
    scale: 1 + Math.sin(time * 0.85 + phase) * 0.014,
  };
}

function flowerOnAsteroid(
  asteroid: Asteroid,
  tree: Tree,
  flower: TreeFlower,
  time: number,
): { x: number; y: number; angle: number; size: number } {
  const slot = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
  const pose = canopyPose(tree, time);
  const rot = slot.angle + Math.PI / 2 + pose.rot;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return {
    x: slot.x - asteroid.x + (flower.x * c - flower.y * s) * pose.scale,
    y: slot.y - asteroid.y + (flower.x * s + flower.y * c) * pose.scale,
    angle: flower.angle + rot,
    size: flower.size,
  };
}

function spawnPollenFromFlower(
  asteroid: Asteroid,
  tree: Tree,
  flower: TreeFlower,
  rng: () => number,
  breeze: number,
  time: number,
): PollenGrain {
  const bloom = flowerOnAsteroid(asteroid, tree, flower, time);
  const polar = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
  const facing = bloom.angle + range(rng, -0.45, 0.45);
  const burst = range(rng, 6, 18);
  const lift = range(rng, 2, 9);
  const ny = Math.sin(Math.atan2(bloom.y, bloom.x));
  const ox = Math.cos(facing) * bloom.size * range(rng, 0.15, 0.55);
  const oy = Math.sin(facing) * bloom.size * range(rng, 0.15, 0.55);
  return {
    x: bloom.x + ox,
    y: bloom.y + oy,
    vx: Math.cos(facing) * burst + breeze * 8 + range(rng, -5, 5),
    vy: Math.sin(facing) * burst + range(rng, -5, 5) + ny * lift,
    theta: Math.atan2(bloom.y, bloom.x),
    originTheta: polar.angle,
    capReach: 0.14 + lifeReach(tree.maturity) * 1.15,
    treeId: tree.id,
    age: 0,
    life: range(rng, 4.8, 9.5),
    size: range(rng, 0.28, 0.62),
    wobble: rng() * Math.PI * 2,
    settled: false,
    settle: 0,
  };
}

function drawPollenMote(
  g: Graphics,
  grain: PollenGrain,
  pal: FloraPalette,
  time: number,
): void {
  const fade = 0.28 + 0.42 * (1 - grain.age / grain.life);
  const color = mixHex(pal.flower, pal.film, 0.12 + grain.size * 0.3);
  const spd = Math.hypot(grain.vx, grain.vy);
  const ang =
    spd > 6 ? Math.atan2(grain.vy, grain.vx) : grain.wobble + time * 0.4;
  const stretch = Math.min(0.55, spd * 0.012);
  const ox = Math.cos(ang) * grain.size * (0.35 + stretch);
  const oy = Math.sin(ang) * grain.size * (0.35 + stretch);
  g.circle(grain.x, grain.y, grain.size * 1.7);
  g.fill({ color, alpha: fade * 0.16 });
  g.circle(grain.x + ox, grain.y + oy, grain.size * 0.78);
  g.fill({ color, alpha: fade * 0.82 });
  g.circle(grain.x - ox * 0.55, grain.y - oy * 0.55, grain.size * 0.44);
  g.fill({
    color: mixHex(color, pal.film, 0.28),
    alpha: fade * 0.55,
  });
}

function maturityBucket(maturity: number): number {
  return Math.floor(Math.min(1, Math.max(0, maturity)) * 80);
}

function maxFeed(trees: Tree[]): number {
  let best = 0;
  for (const tree of trees) {
    best = Math.max(best, rootFeedActive(tree.maturity, tree.coreFeed));
  }
  return best;
}

function hasTreeId(trees: Tree[], id: number): boolean {
  for (let i = 0; i < trees.length; i++) {
    if (trees[i]!.id === id) return true;
  }
  return false;
}

function feedKeyFor(trees: Tree[]): string {
  let key = `${trees.length}`;
  for (const tree of trees) {
    key += `|${tree.id}:${Math.round(rootFeedActive(tree.maturity, tree.coreFeed) * 20)}`;
  }
  return key;
}

function crustPoint(
  asteroid: Asteroid,
  theta: number,
  inset = 0,
): { x: number; y: number; rim: number } {
  const rim = rockRadiusAt(asteroid, theta);
  const d = Math.max(0, rim - inset);
  return { x: Math.cos(theta) * d, y: Math.sin(theta) * d, rim };
}

function pushClump(
  bits: GrassBit[],
  asteroid: Asteroid,
  rng: () => number,
  theta: number,
  count: number,
  density: 'grove' | 'meadow',
  slot?: number,
): void {
  const r = asteroid.radius;
  const inset = range(rng, r * 0.002, r * 0.016);
  const origin = crustPoint(asteroid, theta, inset);
  const tx = -Math.sin(theta);
  const ty = Math.cos(theta);
  const grove = density === 'grove';
  // Shared clump pose — blades mostly agree, then fan a little (Tsushima-style).
  const clumpLean = theta + range(rng, -0.2, 0.2);
  const clumpHeight = grove ? range(rng, 7.5, 14.5) : range(rng, 4.2, 8.6);
  const clumpDroop = range(rng, 0.28, 0.52);
  const clumpShade = rng();
  const sameDir = grove ? range(rng, 0.38, 0.62) : range(rng, 0.62, 0.86);
  const fanAmp = grove ? range(rng, 0.28, 0.55) : range(rng, 0.1, 0.24);
  const spread = grove ? range(rng, 2.2, 4.4) : range(rng, 1.4, 2.8);

  const mossN = grove ? 2 + Math.floor(rng() * 3) : rng() > 0.55 ? 1 : 0;
  for (let m = 0; m < mossN; m++) {
    const along = range(rng, -spread * 0.7, spread * 0.7);
    bits.push({
      theta,
      x: origin.x + tx * along,
      y: origin.y + ty * along,
      lean: theta + range(rng, -0.4, 0.4),
      length: 0,
      width: 0,
      radius: range(rng, r * 0.012, r * 0.03),
      jitter: rng(),
      kind: 'moss',
      droop: 0,
      shade: clumpShade * 0.5 + rng() * 0.5,
      z: grove ? range(rng, -0.2, 0.2) : range(rng, -0.4, 0.4),
      clump: 1,
      slot,
    });
  }

  for (let i = 0; i < count; i++) {
    const along = range(rng, -spread, spread);
    const x = origin.x + tx * along;
    const y = origin.y + ty * along;
    const tuft = rng() > (grove ? 0.42 : 0.62);
    const fan = (along / Math.max(spread, 0.001)) * fanAmp;
    const outward = theta + fan;
    let lean =
      clumpLean * sameDir + outward * (1 - sameDir) + range(rng, -0.07, 0.07);
    const tall = Math.pow(rng(), grove ? 0.55 : 0.95);
    let length = clumpHeight * (0.42 + tall * 0.7);
    let droop = clumpDroop * range(rng, 0.7, 1.35);
    // A few weeds arch over instead of standing.
    if (rng() < 0.12) {
      lean = theta + (rng() > 0.5 ? 1 : -1) * range(rng, 0.7, 1.25);
      droop = range(rng, 0.7, 1.15);
      length *= 0.78;
    }
    // Grove gets dense multi-blade clumps; meadow mostly single blades with
    // an occasional companion. Capped so the per-bit draw cost stays low.
    const clumpN =
      grove ? (rng() < 0.7 ? 2 + Math.floor(rng() * 2) : 1) : rng() < 0.25 ? 2 : 1;
    bits.push({
      theta,
      x,
      y,
      lean,
      length,
      width: tuft
        ? range(rng, 0.55, 1.15)
        : range(rng, 0.22, 0.58),
      radius: 0,
      jitter: rng(),
      kind: tuft ? 'tuft' : 'blade',
      droop,
      shade: clumpShade * 0.62 + rng() * 0.38,
      z: grove ? range(rng, -0.2, 0.2) : range(rng, -0.4, 0.4),
      clump: clumpN,
      slot,
    });
  }
}

function slotNear(asteroid: Asteroid, theta: number): number | undefined {
  let best = -1;
  let bestDa = 0.32;
  for (let slot = 0; slot < asteroid.treeSlots; slot++) {
    const polar = slotPolar(asteroid, slot);
    const da = Math.abs(shortestAngle(theta, polar.angle));
    if (da < bestDa) {
      bestDa = da;
      best = slot;
    }
  }
  return best >= 0 ? best : undefined;
}

function buildGrassField(asteroid: Asteroid): GrassBit[] {
  const rng = mulberry32((asteroid.seed ^ 0x6a55c0de) >>> 0);
  const bits: GrassBit[] = [];

  // Continuous jittered sward around the whole rim.
  let theta = rng() * Math.PI * 2;
  const turns = Math.PI * 2;
  let walked = 0;
  while (walked < turns) {
    const step = range(rng, 0.042, 0.07);
    const blades = 3 + Math.floor(rng() * 4);
    pushClump(
      bits,
      asteroid,
      rng,
      theta,
      blades,
      'meadow',
      slotNear(asteroid, theta),
    );
    theta += step;
    walked += step;
  }

  // Extra stand at each planting scar — origin of life.
  for (let slot = 0; slot < asteroid.treeSlots; slot++) {
    const polar = slotPolar(asteroid, slot);
    const clumps = 4 + Math.floor(rng() * 3);
    for (let c = 0; c < clumps; c++) {
      const base = polar.angle + range(rng, -0.4, 0.4);
      const blades = 5 + Math.floor(rng() * 5);
      pushClump(bits, asteroid, rng, base, blades, 'grove', slot);
    }
  }

  bits.sort((a, b) => a.length - b.length);
  return bits;
}

function sampleSubstrate(substrate: Float32Array | undefined, theta: number): number {
  if (!substrate || substrate.length === 0) return 1;
  const n = substrate.length;
  const u = ((theta / (Math.PI * 2)) % 1 + 1) % 1;
  const x = u * n;
  const i0 = Math.floor(x) % n;
  const i1 = (i0 + 1) % n;
  const t = x - Math.floor(x);
  return substrate[i0]! * (1 - t) + substrate[i1]! * t;
}

function paintLife(
  g: Graphics,
  sap: Graphics,
  asteroid: Asteroid,
  pal: FloraPalette,
  bits: GrassBit[],
  trees: Tree[],
  _time = 0,
  substrate?: Float32Array,
): void {
  g.clear();
  sap.clear();
  if (trees.length === 0) return;

  const origins = trees.map((tree) => {
    const polar = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
    return {
      tree,
      angle: polar.angle,
    };
  });

  // Thin crust mark under the grove — not a face stain.
  for (const o of origins) {
    const t = groveSpread(o.tree.maturity, 0.08);
    if (t <= 0.02) continue;
    const span = 0.1 + 0.12 * o.tree.maturity;
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps - 0.5;
      const theta = o.angle + u * span * 2;
      const p = crustPoint(asteroid, theta, asteroid.radius * 0.012);
      const sr = asteroid.radius * (0.016 + (1 - Math.abs(u) * 1.6) * 0.014) * t;
      if (sr <= 0.35) continue;
      g.circle(p.x, p.y, sr);
      g.fill({ color: pal.grass, alpha: 0.14 * t * (1 - Math.abs(u)) });
    }
  }

  for (const bit of bits) {
    let grow = 0;
    let prox = 0;
    for (const o of origins) {
      const da = Math.abs(shortestAngle(bit.theta, o.angle));
      grow = Math.max(grow, lifeSpread(o.tree.maturity, da, bit.jitter));
      prox = Math.max(prox, lifeProximity(da));
      if (da < 0.38) {
        const scar = groveSpread(o.tree.maturity, bit.jitter);
        grow = Math.max(grow, scar * (1 - da / 0.42));
      }
    }
    const film = sampleSubstrate(substrate, bit.theta);
    // Substrate is a boost, not a gate: even before the moss film builds,
    // a blade near a mature tree should still draw from proximity alone.
    grow = Math.max(grow, film * 0.55);
    if (grow <= 0.03) continue;
    const density = lifeDensity(prox, grow);
    if (bit.jitter > density * 1.35) continue;
    const lush = lifeLushScale(prox);
    if (bit.kind === 'moss') {
      const rad =
        bit.radius * (0.35 + 0.55 * grow) * (0.7 + 0.4 * prox);
      g.circle(bit.x, bit.y, rad);
      g.fill({
        color: mixHex(pal.grass, pal.leaf, bit.shade * 0.35),
        alpha: (0.12 + bit.jitter * 0.1) * grow,
      });
      g.circle(
        bit.x + Math.cos(bit.lean) * rad * 0.28,
        bit.y + Math.sin(bit.lean) * rad * 0.28,
        rad * 0.55,
      );
      g.fill({
        color: pal.leaf,
        alpha: (0.06 + bit.jitter * 0.05) * grow,
      });
      continue;
    }
    drawGrassBlade(g, bit, grow, lush, pal, _time);
  }
}

function paintGroveSap(
  sap: Graphics,
  asteroid: Asteroid,
  pal: FloraPalette,
  trees: Tree[],
  time: number,
): void {
  sap.clear();
  if (trees.length === 0) return;
  for (const tree of trees) {
    const feed = rootFeedActive(tree.maturity, tree.coreFeed);
    if (feed <= 0.04) continue;
    const t = groveSpread(tree.maturity, 0.08);
    if (t <= 0.02) continue;
    const polar = plantPose(asteroid, tree.slotIndex, tree.plantAngle);
    const grassU = sapRiseU(time, tree.seed);
    const grassStage = sapStage(
      grassU,
      SAP_WINDOW.grass[0],
      SAP_WINDOW.grass[1],
      0.2,
    );
    if (grassStage.glow <= 0.05) continue;
    const span = 0.1 + 0.12 * tree.maturity;
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps - 0.5;
      const theta = polar.angle + u * span * 2;
      const p = crustPoint(asteroid, theta, asteroid.radius * 0.012);
      const sr = asteroid.radius * (0.016 + (1 - Math.abs(u) * 1.6) * 0.014) * t;
      if (sr <= 0.35) continue;
      const k = grassStage.glow * feed * t * (1 - Math.abs(u)) * 0.8;
      sap.circle(p.x, p.y, sr * (2.4 + grassStage.progress * 0.8));
      sap.fill({ color: pal.core, alpha: 0.12 * k });
    }
  }
}

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function quadBezier(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  return lerpPt(lerpPt(p0, p1, t), lerpPt(p1, p2, t), t);
}

function quadBezierDeriv(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  return {
    x: 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
    y: 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
  };
}

/** Tapered ribbon along a quadratic spine — widest near the stem, needle at the tip. */
function bladePoly(
  p0: Pt,
  p1: Pt,
  p2: Pt,
  width: number,
  t0 = 0,
  t1 = 1,
  steps = 5,
): Pt[] {
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const t = t0 + (t1 - t0) * u;
    const p = quadBezier(p0, p1, p2, t);
    const d = quadBezierDeriv(p0, p1, p2, t);
    const l = Math.hypot(d.x, d.y) || 1;
    const nx = -d.y / l;
    const ny = d.x / l;
    const envelope =
      t < 0.14 ? 0.5 + 0.5 * (t / 0.14) : Math.pow(1 - (t - 0.14) / 0.86, 1.08);
    const w = width * 0.5 * envelope;
    left.push({ x: p.x + nx * w, y: p.y + ny * w });
    right.push({ x: p.x - nx * w, y: p.y - ny * w });
  }
  for (let i = right.length - 1; i >= 0; i--) left.push(right[i]!);
  return left;
}

function drawGrassBlade(
  g: Graphics,
  bit: GrassBit,
  t: number,
  lush: number,
  pal: FloraPalette,
  time: number,
): void {
  const len = bit.length * (0.18 + 0.82 * t) * lush;
  if (len < 0.7) return;
  // Gentle breathing — a few percent wobble so the sward doesn't read as
  // a frozen stamp. Phase is per-blade so the field doesn't pulse in sync.
  const breathe = 0.94 + 0.06 * Math.sin(time * 0.6 + bit.theta * 8.0 + bit.jitter * 6.28);
  const tuft = bit.kind === 'tuft';
  // z pushes the blade slightly in/out of the camera plane (radial offset
  // relative to the rim). Applied to every Pt below.
  const zx = Math.cos(bit.theta) * bit.z * 0.6;
  const zy = Math.sin(bit.theta) * bit.z * 0.6;

  const drawOne = (
    lenScale: number,
    widthScale: number,
    leanOffset: number,
    baseAlpha: number,
  ): void => {
    const width =
      bit.width *
      (0.35 + 0.65 * t) *
      (0.55 + 0.5 * lush) *
      widthScale;
    const lenScaled = len * lenScale * breathe;
    if (lenScaled < 0.5) return;
    const lean = bit.lean + leanOffset;
    const nx = Math.cos(bit.theta);
    const ny = Math.sin(bit.theta);
    const lx = Math.cos(lean);
    const ly = Math.sin(lean);
    const p0: Pt = { x: bit.x + zx, y: bit.y + zy };
    let p1: Pt = {
      x: bit.x + nx * lenScaled * 0.58 + zx,
      y: bit.y + ny * lenScaled * 0.58 + zy,
    };
    let p2: Pt = {
      x: bit.x + nx * lenScaled * 0.82 + lx * lenScaled * bit.droop * 0.55 + zx,
      y: bit.y + ny * lenScaled * 0.82 + ly * lenScaled * bit.droop * 0.55 + zy,
    };
    const chord = Math.hypot(p2.x - p0.x, p2.y - p0.y) || 1;
    const keep = lenScaled / chord;
    p1 = {
      x: p0.x + (p1.x - p0.x) * keep,
      y: p0.y + (p1.y - p0.y) * keep,
    };
    p2 = {
      x: p0.x + (p2.x - p0.x) * keep,
      y: p0.y + (p2.y - p0.y) * keep,
    };

    const base = mixHex(pal.tuft, pal.grass, 0.28 + bit.shade * 0.4);
    const tip = mixHex(
      pal.grass,
      pal.leaf,
      tuft ? 0.45 + bit.shade * 0.5 : 0.22 + bit.shade * 0.45,
    );
    const alpha = baseAlpha * (0.4 + 0.6 * t) * (0.78 + bit.jitter * 0.22);

    g.poly(bladePoly(p0, p1, p2, width));
    g.fill({ color: base, alpha });
    g.poly(bladePoly(p0, p1, p2, width * 0.72, 0.32, 1, 4));
    g.fill({ color: tip, alpha: alpha * 0.78 });
  };

  // Companions first (back of the clump), master last (front). Companions
  // are thinner and lean a little to either side; bit.jitter seeds the
  // direction so each blade stays self-similar across frames.
  const clumpN = Math.max(1, bit.clump | 0);
  if (clumpN >= 3 && bit.jitter > 0.35) {
    drawOne(0.62, 0.42, -0.22, tuft ? 0.46 : 0.32);
    drawOne(0.68, 0.46, 0.18, tuft ? 0.48 : 0.34);
    drawOne(1.0, 1.0, 0, tuft ? 0.72 : 0.52);
  } else if (clumpN >= 2) {
    const side = bit.jitter > 0.5 ? 1 : -1;
    drawOne(0.7, 0.5, side * 0.18, tuft ? 0.5 : 0.36);
    drawOne(1.0, 1.0, 0, tuft ? 0.72 : 0.52);
  } else {
    drawOne(1.0, 1.0, 0, tuft ? 0.72 : 0.52);
  }
}
