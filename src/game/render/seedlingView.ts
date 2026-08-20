import { Container, Sprite, type Renderer } from 'pixi.js';
import { mulberry32 } from '../sim/rng';
import type { Seedling, SeedlingState } from '../sim/types';
import { bucketHue, type ScenePalette } from './palette';
import {
  SeedlingAtlas,
  seedlingShape,
  seedlingShapeKey,
  type AtlasEntry,
} from './seedlingAtlas';
import { inView, type ViewBox } from './viewport';
import {
  deathMotesEnabled,
  getVisualPrefs,
  hitFlashMs,
} from './visualPrefs';

/**
 * How many stale atlas entries a single frame may repaint. Matches the rock /
 * tree budgets in `main.ts`: a palette step dirties every hull at once, and
 * draining a couple per frame finishes well inside the ~30 frames before the
 * next step. Entries are shared, so this is a budget over *shapes*, not units.
 */
const ATLAS_REFRESHES_PER_FRAME = 2;

/**
 * Seedlings are small; a tight pad is enough to have them updated by the time
 * an edge shows. Rocks use the wider default.
 */
const CULL_PAD = 40;

interface TrackedSprite {
  sprite: Sprite;
  /** Atlas key this sprite was last resolved against. */
  key: string;
  entry: AtlasEntry;
  lastHp: number;
  flashUntil: number;
  state: SeedlingState;
  x: number;
  y: number;
  z: number;
  /** `sync` generation that last saw this unit alive. */
  seen: number;
}

interface DeathMote {
  sprite: Sprite;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  radius: number;
}

export class SeedlingLayer {
  readonly back = new Container();
  readonly front = new Container();
  private sprites = new Map<number, TrackedSprite>();
  private motes: DeathMote[] = [];
  private moteLayer = new Container();
  private lastHueBucket = -1;
  private lastTheme: ScenePalette['theme'] | undefined;
  private generation = 0;
  private readonly atlas: SeedlingAtlas;
  /**
   * Seeded RNG for death motes. The rest of the game derives every visual
   * from the world seed so a replayed seed looks identical; `Math.random`
   * here used to be the one place that drifted.
   */
  private readonly moteRng: () => number;

  constructor(renderer: Renderer, scene: ScenePalette) {
    this.atlas = new SeedlingAtlas(renderer, scene);
    this.moteRng = mulberry32(0x5eed1123);
    this.front.addChild(this.moteLayer);
  }

  destroy(): void {
    this.back.destroy({ children: true });
    this.front.destroy({ children: true });
    this.atlas.destroy();
  }

  /**
   * Palette moved. Nothing is repainted here: the atlas marks its entries
   * stale and `sync` refreshes them under budget, so a bucket step never
   * stalls on the whole field the way a synchronous repaint did.
   */
  retheme(scene: ScenePalette): void {
    const bucket = bucketHue(scene.hue);
    const themeChanged = scene.theme !== undefined && scene.theme !== this.lastTheme;
    if (bucket === this.lastHueBucket && !themeChanged) return;
    this.lastHueBucket = bucket;
    this.lastTheme = scene.theme;
    this.atlas.invalidate(scene);
  }

  sync(seedlings: Map<number, Seedling>, dt: number, view: ViewBox): void {
    const gen = ++this.generation;
    const now = performance.now();
    let refreshBudget = ATLAS_REFRESHES_PER_FRAME;
    // Read once per sync, not per unit: the pref cannot change mid-loop.
    const prefs = getVisualPrefs();
    const flashMs = hitFlashMs(prefs);

    for (const s of seedlings.values()) {
      let tracked = this.sprites.get(s.id);
      const shape = seedlingShape(s, prefs.factionMarks);
      const key = seedlingShapeKey(shape);
      if (!tracked) {
        const entry = this.atlas.acquire(key, shape, gen);
        const sprite = new Sprite(entry.texture);
        sprite.anchor.set(entry.anchorX, entry.anchorY);
        tracked = {
          sprite,
          key,
          entry,
          lastHp: s.hp,
          flashUntil: 0,
          state: s.state,
          x: s.x,
          y: s.y,
          z: s.z,
          seen: gen,
        };
        this.sprites.set(s.id, tracked);
        this.front.addChild(sprite);
      } else if (tracked.key !== key) {
        // Stats grew enough to change the silhouette bucket.
        tracked.key = key;
        tracked.entry = this.atlas.acquire(key, shape, gen);
      } else {
        tracked.entry.lastUsed = gen;
      }

      // Bookkeeping runs for every unit, on screen or not: the reaping pass
      // below reads `seen`, and skipping it off screen would destroy live
      // units and spray death motes where nothing died.
      if (s.hp < tracked.lastHp - 0.01) {
        // At 0 ms `now < flashUntil` is never true, so the tint path below
        // simply never lights up — no extra branch at the draw site.
        tracked.flashUntil = now + flashMs;
      }
      tracked.seen = gen;
      tracked.lastHp = s.hp;
      tracked.state = s.state;
      tracked.x = s.x;
      tracked.y = s.y;

      const g = tracked.sprite;
      const entry = tracked.entry;

      // `dz` drives the squash on depth changes, so it has to keep tracking
      // even while culled — otherwise a unit that crossed the field off
      // screen snaps flat on the frame it reappears.
      const z = s.z;
      const dz = z - tracked.z;
      tracked.z = z;

      const on = inView(s.x, s.y, 12, view, CULL_PAD);
      g.visible = on;
      // Only what the player can see is worth spending the repaint budget on;
      // an off-screen hull refreshes on the frame it scrolls back in.
      if (on && refreshBudget > 0 && this.atlas.refresh(entry)) {
        refreshBudget -= 1;
      }
      // Re-read regardless, so a culled sprite is never left pointing at a
      // texture that a refresh retired.
      if (g.texture !== entry.texture) {
        g.texture = entry.texture;
        g.anchor.set(entry.anchorX, entry.anchorY);
      }
      if (!on) continue;

      const t = now / 1000;
      const bucket = z < 0 ? this.back : this.front;
      if (g.parent !== bucket) bucket.addChild(g);
      g.position.set(s.x, s.y);
      g.rotation = visualFacing(s, t);
      const flashing = now < tracked.flashUntil;
      const flashBoost = flashing ? 1.18 : 1;
      const persp = depthScale(z);
      const flatten = 1 - Math.min(0.3, Math.abs(dz) * 2.4);
      const scale = visualScale(s, t) * flashBoost * persp;
      g.scale.set(scale, scale * flatten);
      const hurt = Math.max(0.35, s.hp / Math.max(1, s.maxHp));
      const plantFade = s.state === 'plant' && (s.wait ?? 0) <= 0 ? 0.85 : 1;
      const depthAlpha = 0.7 + 0.3 * clamp01(0.5 + z / 70);
      g.alpha = plantFade * (flashing ? 1 : 0.45 + 0.55 * hurt) * depthAlpha;
      g.tint = flashing ? 0xfff8ef : 0xffffff;
    }

    for (const [id, tracked] of this.sprites) {
      if (tracked.seen === gen) continue;
      if (tracked.state !== 'plant' && deathMotesEnabled(prefs)) {
        spawnDeathMotes(
          this.motes,
          this.moteLayer,
          tracked.x,
          tracked.y,
          this.moteRng,
          this.atlas,
        );
      }
      tracked.sprite.parent?.removeChild(tracked.sprite);
      tracked.sprite.destroy();
      this.sprites.delete(id);
    }

    tickMotes(this.motes, this.moteLayer, dt);
    this.atlas.sweep();
  }
}

function spawnDeathMotes(
  motes: DeathMote[],
  layer: Container,
  x: number,
  y: number,
  rng: () => number,
  atlas: SeedlingAtlas,
): void {
  const n = 4 + Math.floor(rng() * 3);
  const tex = atlas.dotTexture();
  for (let i = 0; i < n; i++) {
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    const r = 1.2 + rng() * 1.8;
    sprite.tint = 0xf4e8d8;
    sprite.alpha = 0.85;
    sprite.position.set(x, y);
    layer.addChild(sprite);
    const angle = rng() * Math.PI * 2;
    const speed = 18 + rng() * 42;
    const life = 0.35 + rng() * 0.25;
    motes.push({
      sprite,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 12,
      life,
      maxLife: life,
      radius: r / atlas.dotRadius,
    });
  }
}

function tickMotes(motes: DeathMote[], layer: Container, dt: number): void {
  for (let i = motes.length - 1; i >= 0; i--) {
    const m = motes[i]!;
    m.life -= dt;
    if (m.life <= 0) {
      layer.removeChild(m.sprite);
      m.sprite.destroy();
      motes.splice(i, 1);
      continue;
    }
    m.sprite.x += m.vx * dt;
    m.sprite.y += m.vy * dt;
    m.vy += 40 * dt;
    const t = m.life / m.maxLife;
    m.sprite.alpha = Math.max(0, t);
    m.sprite.scale.set(m.radius * (0.6 + t * 0.5));
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function depthScale(z: number): number {
  const zc = Math.max(-70, Math.min(70, z));
  return 1 + zc / 280;
}

function visualFacing(s: Seedling, t: number): number {
  const wobble = s.state === 'sprout' ? 0.05 : 0.08;
  return s.facing + Math.sin(t * 1.15 + s.phase) * wobble;
}

function visualScale(s: Seedling, t: number): number {
  const kindScale = s.kind === 'sentinel' ? 1.1 : 1;
  const energyScale = 0.94 + (s.stats.energy / 200) * 0.1;
  const breathe = 1 + Math.sin(t * 1.35 + s.phase * 0.8) * 0.03;
  let unfurl = 1;
  if (s.state === 'sprout') {
    const dur = Math.max(0.01, s.sproutDuration ?? 3.2);
    unfurl = 0.18 + Math.min(1, (s.sproutAge ?? 0) / dur) * 0.82;
  }
  return unfurl * kindScale * energyScale * breathe;
}
