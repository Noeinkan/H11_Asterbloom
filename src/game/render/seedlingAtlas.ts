import { Graphics, Texture, type Renderer } from 'pixi.js';
import type { FactionId, Seedling, SeedlingKind, Stats } from '../sim/types';
import type { ScenePalette } from './palette';
import { paintSeedHull } from './seedlingPaint';

/**
 * Shared hull textures for the seedling layer.
 *
 * Every unit used to own a `Graphics` with `cacheAsTexture(true)`, i.e. one
 * render texture per unit: nothing batched, and GPU memory grew linearly with
 * the population. But units are not that distinct — the hull is a function of
 * faction, kind, three stats and a per-id jitter. Quantize the stats, bucket
 * the jitter, and a field of fifty seedlings collapses onto a handful of
 * textures that batch into a couple of draw calls.
 *
 * Colors also depend on the scene, so a palette step invalidates the lot. That
 * is handled by a generation counter rather than a repaint: entries go stale,
 * sprites keep drawing the old texture, and `SeedlingLayer` refreshes a couple
 * per frame — the same budgeted-repaint shape rocks and trees already use.
 */

/** Baked at 4x so hulls stay crisp well into the zoom range. */
const ATLAS_RESOLUTION = 4;
/** Soft cap on live hull textures; only idle entries are ever evicted. */
const MAX_ENTRIES = 96;
/** Stat quantization step. 200 is the nominal stat ceiling. */
const STAT_STEP = 16;
/** Distinct jitter buckets per shape. */
export const VARIANTS = 8;

/** `speed >= this` grows the second pair of fins (see `paintSeedHull`). */
const EXTRA_WINGS_AT = 170;
/** `strength >= this` grows the second barb. */
const TWIN_BARB_AT = 210;

/** Everything the hull painter needs, with the per-unit detail quantized out. */
export interface SeedlingShape {
  faction: FactionId;
  kind: SeedlingKind;
  stats: Stats;
  /** Stands in for the unit id, so jitter is shared across the bucket. */
  variant: number;
}

/**
 * Quantize a stat, but never across a threshold that changes the silhouette:
 * a unit sitting on the boundary would otherwise flip between two textures as
 * the stat drifts by a fraction.
 */
function quantize(v: number, threshold: number): number {
  const q = Math.round(v / STAT_STEP) * STAT_STEP;
  if (threshold <= 0) return q;
  if (v >= threshold && q < threshold) return threshold;
  if (v < threshold && q >= threshold) return threshold - STAT_STEP;
  return q;
}

/** Which jitter bucket a unit falls in. Hashed, so ids never clump by faction. */
export function seedlingVariant(id: number): number {
  return (Math.imul(id, 0x9e3779b9) >>> 29) % VARIANTS;
}

export function seedlingShape(s: Seedling): SeedlingShape {
  return {
    faction: s.faction,
    kind: s.kind,
    stats: {
      energy: quantize(s.stats.energy, 0),
      strength: quantize(s.stats.strength, TWIN_BARB_AT),
      speed: quantize(s.stats.speed, EXTRA_WINGS_AT),
    },
    variant: seedlingVariant(s.id),
  };
}

export function seedlingShapeKey(shape: SeedlingShape): string {
  const st = shape.stats;
  return `${shape.faction}|${shape.kind}|${st.energy}|${st.strength}|${st.speed}|${shape.variant}`;
}

export interface AtlasEntry {
  texture: Texture;
  /** Sprite anchor that puts the texture origin back on the hull origin. */
  anchorX: number;
  anchorY: number;
  /** Scene generation this texture was painted at. */
  generation: number;
  /** Last sync generation that asked for this entry; drives eviction. */
  lastUsed: number;
  shape: SeedlingShape;
}

export class SeedlingAtlas {
  private readonly entries = new Map<string, AtlasEntry>();
  private readonly scratch = new Graphics();
  private readonly renderer: Renderer;
  private scene: ScenePalette;
  /** Bumped when the palette moves; entries below it are stale. */
  private generation = 0;
  /**
   * Textures replaced by a refresh. Held for one sweep so nothing is destroyed
   * while a sprite might still point at it.
   */
  private retiring: Texture[] = [];
  private retired: Texture[] = [];
  private dot: Texture | null = null;
  /** Radius the dot texture was drawn at; mote scale divides by it. */
  readonly dotRadius = 8;

  constructor(renderer: Renderer, scene: ScenePalette) {
    this.renderer = renderer;
    this.scene = scene;
  }

  /** Mark every entry stale without touching a pixel. Refresh is budgeted. */
  invalidate(scene: ScenePalette): void {
    this.scene = scene;
    this.generation += 1;
  }

  /** True when the entry was painted in an older palette than the current one. */
  isStale(entry: AtlasEntry): boolean {
    return entry.generation !== this.generation;
  }

  /** Fetch, painting on first use, the entry for a shape. */
  acquire(key: string, shape: SeedlingShape, syncGeneration: number): AtlasEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      const painted = this.paint(shape);
      entry = {
        texture: painted.texture,
        anchorX: painted.anchorX,
        anchorY: painted.anchorY,
        generation: this.generation,
        lastUsed: syncGeneration,
        shape,
      };
      this.entries.set(key, entry);
      this.evict(syncGeneration);
    }
    entry.lastUsed = syncGeneration;
    return entry;
  }

  /** Repaint one stale entry in the current palette. False when already fresh. */
  refresh(entry: AtlasEntry): boolean {
    if (!this.isStale(entry)) return false;
    const painted = this.paint(entry.shape);
    this.retiring.push(entry.texture);
    entry.texture = painted.texture;
    entry.anchorX = painted.anchorX;
    entry.anchorY = painted.anchorY;
    entry.generation = this.generation;
    return true;
  }

  /** Small white disc for death motes, so they batch like the hulls do. */
  dotTexture(): Texture {
    if (this.dot) return this.dot;
    const g = new Graphics();
    g.circle(0, 0, this.dotRadius);
    g.fill({ color: 0xffffff, alpha: 1 });
    this.dot = this.renderer.generateTexture({
      target: g,
      resolution: ATLAS_RESOLUTION,
      antialias: true,
    });
    g.destroy();
    return this.dot;
  }

  /** Call once per sync, after every sprite has re-read its texture. */
  sweep(): void {
    for (const t of this.retired) t.destroy(true);
    this.retired = this.retiring;
    this.retiring = [];
  }

  destroy(): void {
    for (const t of this.retired) t.destroy(true);
    for (const t of this.retiring) t.destroy(true);
    for (const e of this.entries.values()) e.texture.destroy(true);
    this.entries.clear();
    this.retired = [];
    this.retiring = [];
    this.dot?.destroy(true);
    this.dot = null;
    this.scratch.destroy();
  }

  private paint(shape: SeedlingShape): {
    texture: Texture;
    anchorX: number;
    anchorY: number;
  } {
    const g = this.scratch;
    g.clear();
    paintSeedHull(g, {
      stats: shape.stats,
      scene: this.scene,
      faction: shape.faction,
      kind: shape.kind,
      id: shape.variant,
      open: 1,
    });
    const b = g.getLocalBounds();
    const texture = this.renderer.generateTexture({
      target: g,
      resolution: ATLAS_RESOLUTION,
      antialias: true,
    });
    // The hull is not centred on its origin — the nose reaches further than
    // the rump. Offsetting the anchor by the bounds keeps `sprite.rotation`
    // turning about the same point the Graphics did.
    return {
      texture,
      anchorX: b.width > 0 ? -b.x / b.width : 0.5,
      anchorY: b.height > 0 ? -b.y / b.height : 0.5,
    };
  }

  /** Drop the least recently used entries that nothing drew this frame. */
  private evict(syncGeneration: number): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) return;
      if (entry.lastUsed === syncGeneration) continue;
      entry.texture.destroy(true);
      this.entries.delete(key);
    }
  }
}
