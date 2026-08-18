import { Container, Sprite, Texture, type Graphics } from 'pixi.js';

/**
 * Shared radial-glow ramp. Every soft glow in the game used to be N stacked
 * filled circles of decreasing alpha — one shape and one full-area fill per
 * ring, so a single 5-ring glow shaded the same fragments five times over.
 * Since the stack only ever approximated a radial falloff, we bake that exact
 * falloff into one small texture and draw it once: as a textured fill inside a
 * `Graphics` (`paintGlowEllipse`) where draw order matters, or as a pooled,
 * tinted `Sprite` (`GlowPool`) on the per-frame paths.
 *
 * The ramp is deliberately the *step* function the old loop produced, not a
 * smooth curve, so the picture is unchanged. If the steps ever band visibly at
 * large radii, interpolating between ring boundaries in `glowRamp` is the fix.
 */

const GLOW_TEX_SIZE = 128;
/** Radius, in texture pixels, of the baked disc. Sprite scale divides by it. */
export const GLOW_TEX_RADIUS = GLOW_TEX_SIZE / 2;
/** Highest ring count worth baking; callers pass 1..5 today. */
const MAX_RINGS = 8;

/**
 * Per-ring alpha weights of the old stacked-ring loop: ring `i` covered
 * radius `r * u` at alpha `alpha * u²`, with `u = 1 - i/n`. Descending, and
 * `[0]` is always 1 — the outermost ring drew at the caller's full alpha.
 */
export function glowRingAlphas(rings: number): number[] {
  const n = ringCount(rings);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const u = 1 - i / n;
    out[i] = u * u;
  }
  return out;
}

/**
 * Normalized alpha of the baked ramp at radius `rho` (0 = centre, 1 = rim).
 * A pixel gets every ring whose radius reaches it, so this is the partial sum
 * of `glowRingAlphas` over those rings, scaled so the centre lands on 1.
 */
export function glowRamp(rho: number, rings: number): number {
  if (rho > 1) return 0;
  const n = ringCount(rings);
  let covering = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const u = 1 - i / n;
    const e = u * u;
    total += e;
    if (u >= rho) covering += e;
  }
  return total > 0 ? covering / total : 0;
}

/**
 * Alpha to draw the baked ramp at so its centre matches what the old stack
 * reached. The rings composited `over` each other, which is not linear in the
 * caller's alpha, so this is the exact `1 - Π(1 - alpha·e_i)` rather than a
 * sum. Only the centre is exact; the falloff shape is off by ~1% at the
 * alphas in use (0.1–0.5), far below what a glow can show.
 */
export function glowPeakAlpha(alpha: number, rings: number): number {
  const n = ringCount(rings);
  let clear = 1;
  for (let i = 0; i < n; i++) {
    const u = 1 - i / n;
    clear *= 1 - alpha * u * u;
  }
  return 1 - clear;
}

function ringCount(rings: number): number {
  return Math.max(2, Math.min(MAX_RINGS, rings | 0));
}

const textures = new Map<number, Texture>();

/**
 * White ramp texture for a ring count, built once and shared. Written through
 * `ImageData` (which is straight, un-premultiplied alpha) so the values land
 * exactly as computed — compositing discs onto a canvas instead would fold the
 * ramp through canvas blending and lose the shape.
 */
export function softGlowTexture(rings: number): Texture {
  const n = ringCount(rings);
  const cached = textures.get(n);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = GLOW_TEX_SIZE;
  canvas.height = GLOW_TEX_SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(GLOW_TEX_SIZE, GLOW_TEX_SIZE);
  const data = img.data;
  for (let y = 0; y < GLOW_TEX_SIZE; y++) {
    const dy = (y + 0.5 - GLOW_TEX_RADIUS) / GLOW_TEX_RADIUS;
    for (let x = 0; x < GLOW_TEX_SIZE; x++) {
      const dx = (x + 0.5 - GLOW_TEX_RADIUS) / GLOW_TEX_RADIUS;
      const a = glowRamp(Math.sqrt(dx * dx + dy * dy), n);
      const o = (y * GLOW_TEX_SIZE + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = Texture.from(canvas);
  textures.set(n, tex);
  return tex;
}

/**
 * One textured ellipse in place of `rings` stacked fills. Use this where the
 * glow has to stay inside an existing `Graphics` — either because the layer is
 * repainted rarely and already cached, or because something is drawn over it
 * and the order matters. Pass `ry < 0` for a circle of radius `rx`.
 */
export function paintGlowEllipse(
  g: Graphics,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: number,
  alpha: number,
  rings: number,
): void {
  const yr = ry < 0 ? rx : ry;
  if (alpha <= 0.002 || rx <= 0.05 || yr <= 0.05) return;
  g.ellipse(x, y, rx, yr);
  g.fill({
    texture: softGlowTexture(rings),
    textureSpace: 'local',
    color,
    alpha: glowPeakAlpha(alpha, rings),
  });
}

/**
 * Recycled additive glow sprites for paths that repaint every frame. A pooled
 * sprite only takes transform writes per frame, where a `Graphics` would
 * rebuild and re-upload its geometry. Safe to lift glows out of an additive
 * `Graphics` layer into one of these: additive blending is commutative, so
 * moving them out of draw order changes nothing.
 *
 * Usage per frame: `begin()`, then one `add()` per glow, then `end()`.
 */
export class GlowPool extends Container {
  private readonly sprites: Sprite[] = [];
  private used = 0;

  constructor() {
    super();
    this.eventMode = 'none';
  }

  /** Rewind to the first sprite. No allocation, no teardown. */
  begin(): void {
    this.used = 0;
  }

  add(
    x: number,
    y: number,
    rx: number,
    ry: number,
    color: number,
    alpha: number,
    rings: number,
  ): void {
    const yr = ry < 0 ? rx : ry;
    if (alpha <= 0.002 || rx <= 0.05 || yr <= 0.05) return;
    let s = this.sprites[this.used];
    if (!s) {
      s = new Sprite();
      s.anchor.set(0.5);
      s.blendMode = 'add';
      s.eventMode = 'none';
      this.sprites.push(s);
      this.addChild(s);
    }
    this.used += 1;
    s.texture = softGlowTexture(rings);
    s.visible = true;
    s.position.set(x, y);
    s.scale.set(rx / GLOW_TEX_RADIUS, yr / GLOW_TEX_RADIUS);
    s.tint = color;
    s.alpha = glowPeakAlpha(alpha, rings);
  }

  /** Hide whatever the frame did not claim. */
  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) {
      this.sprites[i]!.visible = false;
    }
  }
}
