import { Container, FillGradient, Graphics } from 'pixi.js';
import { mulberry32 } from '../sim/rng';
import { getVisualPrefs } from './visualPrefs';
import {
  bucketHue,
  hslToHex,
  mixHex,
  type BackgroundTheme,
  type Hex,
  type ScenePalette,
} from './palette';

/** Breath offset quantum, in normalized gradient coords. */
const DRIFT_STEP = 0.01;

function quantize(v: number, step: number): number {
  return Math.round(v / step) * step;
}

type Cloud = { x: number; y: number; r: number; mist: boolean; alpha: number };
type Star = { x: number; y: number; size: number; alpha: number };

/**
 * Two themed backdrop + nebula layers stacked, with alphas driven by the
 * theme crossfade (`mix`). Layer A is the outgoing theme (alpha = 1 − mix),
 * layer B is the incoming theme (alpha = mix). When `mix` is 0 or 1 the
 * inactive layer is fully transparent so we still pay one Graphics clear per
 * frame, but no fill cost.
 */
export class Starfield {
  /** Screen-space void. Add to the stage, behind the camera. */
  readonly backdrop = new Graphics();
  /** World-space nebulae and stars. */
  readonly root = new Container();
  private nebulaA = new Graphics();
  private nebulaB = new Graphics();
  private starsFar = new Graphics();
  private starsNear = new Graphics();
  private clouds: Cloud[];
  private farStars: Star[];
  private nearStars: Star[];
  private scene: ScenePalette;
  /** Current pair of themes being crossfaded. */
  private themeA: BackgroundTheme = 'void';
  private themeB: BackgroundTheme = 'void';
  /** 0 = full A, 1 = full B. */
  private mix = 0;
  private viewW = 1;
  private viewH = 1;
  private lastHueBucket = -1;
  private lastThemeA: BackgroundTheme | undefined;
  private lastThemeB: BackgroundTheme | undefined;
  private lastMix = -1;
  /**
   * Cached `FillGradient` instances reused across repaints. Per the Pixi
   * docs, mutating an existing gradient is cheaper than allocating a new
   * one per hue-bucket repaint (≈1 Hz) — and keeps the GPU texture stable.
   */
  private readonly gradientCache = new GradientCache();

  constructor(seed: number, scene: ScenePalette) {
    this.scene = scene;
    this.themeA = scene.theme ?? 'void';
    this.themeB = this.themeA;
    this.backdrop.eventMode = 'none';
    this.root.eventMode = 'none';
    this.root.addChild(this.nebulaA, this.nebulaB, this.starsFar, this.starsNear);
    const layout = layoutSky(seed);
    this.clouds = layout.clouds;
    this.farStars = layout.farStars;
    this.nearStars = layout.nearStars;
    this.retheme(scene, this.themeA, this.themeB, 0);
  }

  resize(width: number, height: number): void {
    this.viewW = Math.max(1, width);
    this.viewH = Math.max(1, height);
    paintBackdropForTheme(this.backdrop, this.viewW, this.viewH, this.scene, this.themeB, 1, this.gradientCache);
  }

  /**
   * Re-paint both themed layers and the star tints. The backdrop fill itself
   * is owned by the current theme's painter; we re-paint both layers here so
   * a jump in `scene.hue` shows up immediately on the next frame.
   */
  retheme(
    scene: ScenePalette,
    themeA: BackgroundTheme,
    themeB: BackgroundTheme,
    mix: number,
  ): void {
    const newMix = clamp01(mix);
    const bucket = bucketHue(scene.hue);
    if (
      bucket === this.lastHueBucket &&
      themeA === this.lastThemeA &&
      themeB === this.lastThemeB &&
      newMix === this.lastMix
    ) {
      this.scene = scene;
      return;
    }
    this.lastHueBucket = bucket;
    this.lastThemeA = themeA;
    this.lastThemeB = themeB;
    this.lastMix = newMix;
    this.scene = scene;
    this.themeA = themeA;
    this.themeB = themeB;
    this.mix = newMix;
    paintBackdropForTheme(this.backdrop, this.viewW, this.viewH, scene, themeB, 1, this.gradientCache);
    paintNebulaeForTheme(this.nebulaA, this.clouds, scene, themeA, 1 - this.mix);
    paintNebulaeForTheme(this.nebulaB, this.clouds, scene, themeB, this.mix);
    paintStars(this.starsFar, this.farStars, scene.mist);
    paintStars(this.starsNear, this.nearStars, scene.mist);
  }

  setParallax(camX: number, camY: number): void {
    const px = -camX * 0.02;
    const py = -camY * 0.02;
    this.nebulaA.position.set(px, py);
    this.nebulaB.position.set(px, py);
    this.starsFar.position.set(-camX * 0.04, -camY * 0.04);
    this.starsNear.position.set(-camX * 0.08, -camY * 0.08);
  }

  /**
   * Ambient breath: nudge the bloom / vignette centers so the wash slowly
   * drifts. A built `FillGradient` texture is immutable in Pixi, so the
   * drift can only reach the screen by rebuilding the gradient and
   * repainting the backdrop. That is far too expensive per frame, so the
   * offset is quantized to `DRIFT_STEP`: a 20 s cycle then costs roughly
   * one rebuild per second, which is all a breath this slow needs.
   */
  tick(t: number): void {
    // Reduced motion holds the backdrop at its rest offset. Returning early
    // would freeze it wherever it happened to be; drifting to (0, 0) instead
    // means the pref always lands on the same picture.
    const still = getVisualPrefs().reducedMotion;
    const slow = t * 0.05; // ≈ 20s per cycle; never distracting
    const dx = still ? 0 : quantize(Math.cos(slow) * 0.06, DRIFT_STEP);
    const dy = still ? 0 : quantize(Math.sin(slow * 0.8) * 0.04, DRIFT_STEP);
    if (!this.gradientCache.setDrift(dx, dy)) return;
    paintBackdropForTheme(
      this.backdrop,
      this.viewW,
      this.viewH,
      this.scene,
      this.themeB,
      1,
      this.gradientCache,
    );
  }

  destroy(): void {
    this.gradientCache.destroy();
  }
}

function layoutSky(seed: number): {
  clouds: Cloud[];
  farStars: Star[];
  nearStars: Star[];
} {
  const rng = mulberry32(seed ^ 0xa5a5a5a5);
  const clouds: Cloud[] = [];
  for (let i = 0; i < 3; i++) {
    clouds.push({
      x: (rng() - 0.5) * 2400,
      y: (rng() - 0.5) * 2400,
      r: 280 + rng() * 220,
      mist: rng() > 0.5,
      alpha: 0.04 + rng() * 0.03,
    });
  }
  return {
    clouds,
    farStars: scatterStars(rng, 55, 0.45, 0.12, 0.28),
    nearStars: scatterStars(rng, 14, 0.8, 0.2, 0.4),
  };
}

function scatterStars(
  rng: () => number,
  count: number,
  size: number,
  a0: number,
  a1: number,
): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: (rng() - 0.5) * 3600,
      y: (rng() - 0.5) * 3600,
      size: size * (0.7 + rng() * 0.6),
      alpha: a0 + rng() * (a1 - a0),
    });
  }
  return stars;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Backdrop per theme. Layered like a depth stack (per `radial-gradient`
 * best practice): base color → ambient band → bloom → soft vignette.
 * Every layer ends on the base color so no layer shows a hard edge.
 *
 * Each gradient layer is wrapped in a try/catch that falls back to a flat
 * tint if Pixi's gradient rasterizer fails on this browser/GPU. Without
 * the fallback, a single failed gradient aborts the whole backdrop and
 * leaves the page black.
 */
function paintBackdropForTheme(
  g: Graphics,
  w: number,
  h: number,
  scene: ScenePalette,
  theme: BackgroundTheme,
  alpha: number,
  cache: GradientCache,
): void {
  g.clear();
  if (alpha <= 0.001) return;
  const base = baseBackdropColor(scene, theme);

  // 1) Base surface — flat fill, the safe ground everything fades into.
  g.rect(0, 0, w, h);
  g.fill({ color: base, alpha });

  // 2) Ambient band: gentle vertical wash from bgA → bgB → bgC.
  safeFill(g, cache, `band:${theme}`, softBandStops(scene), 'linear', w, h, scene.bgB, 0.85 * alpha);

  // 3) Theme-specific bloom(s). Each bloom is a soft radial halo that
  // fades to the base color and extends past the screen edge so its rim
  // never appears inside the viewport.
  switch (theme) {
    case 'void':
      paintVoidWash(g, w, h, scene, alpha, cache);
      break;
    case 'paper':
      paintPaperWash(g, w, h, scene, alpha, cache);
      break;
    case 'aurora':
      paintAuroraWashes(g, w, h, scene, alpha, cache);
      break;
    case 'nebula':
      paintNebulaWash(g, w, h, scene, alpha, cache);
      break;
  }

  // 4) Vignette: darkened corners. The center stop is the base color the
  // layers above already settled on, so the fill is a no-op in the middle
  // and only bites toward the rim.
  safeFill(
    g,
    cache,
    `vignette:${theme}`,
    [
      { offset: 0, color: base },
      { offset: 0.55, color: base },
      { offset: 1, color: mixHex(base, 0x000000, 0.72) },
    ],
    'radial',
    w,
    h,
    base,
    0.55 * alpha,
  );
}

/**
 * Draw a rect with a gradient fill, falling back to a flat tint if the
 * rasterizer throws. Returns silently on failure — the user still sees
 * the base layer underneath, which is always present.
 */
function safeFill(
  g: Graphics,
  cache: GradientCache,
  key: string,
  stops: ColorStop[],
  kind: 'linear' | 'radial',
  w: number,
  h: number,
  fallbackTint: Hex,
  alpha: number,
  driftable = false,
): void {
  try {
    const fill =
      kind === 'linear'
        ? cache.linear(key, stops)
        : cache.radial(key, stops, driftable);
    g.rect(0, 0, w, h);
    g.fill({ fill, alpha });
  } catch (err) {
    // Gradient rasterizer blew up on this browser/GPU. Drop the rect and
    // paint a flat tint in its place so the user still sees color.
    console.warn('[starfield] gradient fill failed, using flat tint', err);
    g.rect(0, 0, w, h);
    g.fill({ color: fallbackTint, alpha });
  }
}

function paintNebulaeForTheme(
  g: Graphics,
  clouds: Cloud[],
  scene: ScenePalette,
  theme: BackgroundTheme,
  alpha: number,
): void {
  g.clear();
  if (alpha <= 0.001) return;
  for (const cloud of clouds) {
    const tint = cloudTint(scene, theme, cloud);
    g.circle(cloud.x, cloud.y, cloud.r);
    g.fill({ color: tint, alpha: cloud.alpha * 0.45 * alpha });
    g.circle(cloud.x, cloud.y, cloud.r * 0.55);
    g.fill({ color: tint, alpha: cloud.alpha * alpha });
  }
}

function paintStars(g: Graphics, stars: Star[], tint: Hex): void {
  g.clear();
  for (const s of stars) {
    g.circle(s.x, s.y, s.size);
    g.fill({ color: s.alpha > 0.32 ? 0xf0ebe3 : tint, alpha: s.alpha });
  }
}

function baseBackdropColor(scene: ScenePalette, theme: BackgroundTheme): Hex {
  // Each theme picks a base from the scene palette it built. Void + nebula
  // use the darkest field; paper uses the lightest; aurora uses the mid
  // field so the stripes read against something darker than the wash.
  switch (theme) {
    case 'void':
      return hslToHex(scene.hue, 0.26, 0.035);
    case 'paper':
      return scene.bgA;
    case 'aurora':
      return scene.bgC;
    case 'nebula':
      return hslToHex(scene.hue, 0.32, 0.045);
  }
}

/**
 * Color stops for the linear backdrop band. Both ends match the base color,
 * with `bgB` (the brightest field) held over a wide middle plateau so the
 * eye never catches a single color boundary — only a soft peak. Six stops
 * is enough to read as a smooth wash at any reasonable screen size.
 */
function softBandStops(scene: ScenePalette): ColorStop[] {
  return [
    { offset: 0, color: scene.bgA },
    { offset: 0.25, color: scene.bgB },
    { offset: 0.5, color: scene.bgB },
    { offset: 0.75, color: scene.bgC },
    { offset: 1, color: scene.bgC },
  ];
}

function cloudTint(scene: ScenePalette, theme: BackgroundTheme, cloud: Cloud): Hex {
  switch (theme) {
    case 'void':
      return cloud.mist ? scene.mist : scene.dust;
    case 'paper':
      // Paper sky uses warm dust clouds; mist reads as a cooler wash.
      return cloud.mist ? scene.inkSoft : scene.dust;
    case 'aurora':
      // Aurora's highlights are the mist field; dust trails below them.
      return cloud.mist ? scene.mist : scene.dust;
    case 'nebula':
      return cloud.mist ? scene.mist : scene.dust;
  }
}

/**
 * Each wash now paints a soft radial bloom (one `circle` filled with a
 * radial gradient that fades to the base color) instead of two stacked
 * filled discs. That removes the visible disc edges that read as "rings".
 *
 * Every bloom is sized so its outer edge falls outside the screen, and
 * every gradient uses a multi-stop falloff that ends on `bgB` (the
 * brightest palette field) instead of the near-black `bgA`. That gives
 * the bloom a real highlight peak — fading to black would just disappear.
 * Blooms are flagged `driftable` so the ambient breath in `tick()` can
 * nudge their centers without re-rasterizing the texture.
 */
function paintVoidWash(
  g: Graphics,
  w: number,
  h: number,
  scene: ScenePalette,
  alpha: number,
  cache: GradientCache,
): void {
  // Primary bloom: the scene's main hue, faded into bgA.
  const primary = cache.radial(
    `void-primary`,
    [
      { offset: 0, color: scene.bgB },
      { offset: 0.55, color: scene.bgB },
      { offset: 1, color: scene.bgA },
    ],
    true,
  );
  g.circle(w * 0.5, h * 0.46, Math.max(w, h) * 0.85);
  g.fill({ fill: primary, alpha: 0.7 * alpha });

  // Secondary bloom: a complementary pastel hue, smaller and offset, so
  // the wash shows two distinct color bands instead of one monochrome
  // gradient. This is what makes the void feel like deep space rather
  // than a single flat color.
  const accent = cache.radial(
    `void-accent`,
    [
      { offset: 0, color: scene.mist },
      { offset: 0.55, color: scene.mist },
      { offset: 1, color: scene.bgA },
    ],
    true,
  );
  g.ellipse(w * 0.75, h * 0.32, w * 0.5, h * 0.35);
  g.fill({ fill: accent, alpha: 0.5 * alpha });
}

function paintPaperWash(
  g: Graphics,
  w: number,
  h: number,
  scene: ScenePalette,
  alpha: number,
  cache: GradientCache,
): void {
  // Soft inner highlight toward the upper third where the "sun" would be.
  const highlight = cache.radial(
    `paper-high`,
    [
      { offset: 0, color: scene.bgB },
      { offset: 0.5, color: scene.bgB },
      { offset: 1, color: scene.bgA },
    ],
    true,
  );
  g.circle(w * 0.55, h * 0.3, Math.max(w, h) * 0.9);
  g.fill({ fill: highlight, alpha: 0.32 * alpha });

  // Cooler counter-glow toward the lower-left for depth.
  const shadow = cache.radial(
    `paper-shadow`,
    [
      { offset: 0, color: scene.bgC },
      { offset: 0.5, color: scene.bgB },
      { offset: 1, color: scene.bgA },
    ],
    true,
  );
  g.circle(w * 0.4, h * 0.72, Math.max(w, h) * 0.75);
  g.fill({ fill: shadow, alpha: 0.24 * alpha });
}

function paintAuroraWashes(
  g: Graphics,
  w: number,
  h: number,
  scene: ScenePalette,
  alpha: number,
  cache: GradientCache,
): void {
  // Two diagonal bands. Each is filled with a horizontal gradient that
  // fades to bgA at the long edges so the band feathers into the wash
  // without a visible boundary. Centered on bgB so it reads as a
  // highlight band, not a darkening.
  const mist = cache.linear(`aurora-mist`, [
    { offset: 0, color: scene.bgA },
    { offset: 0.35, color: scene.bgB },
    { offset: 0.65, color: scene.bgB },
    { offset: 1, color: scene.bgA },
  ]);
  g.ellipse(w * 0.4, h * 0.32, w * 0.7, h * 0.18);
  g.fill({ fill: mist, alpha: 0.4 * alpha });

  const dust = cache.linear(`aurora-dust`, [
    { offset: 0, color: scene.bgA },
    { offset: 0.35, color: scene.bgC },
    { offset: 0.65, color: scene.bgC },
    { offset: 1, color: scene.bgA },
  ]);
  g.ellipse(w * 0.6, h * 0.6, w * 0.75, h * 0.2);
  g.fill({ fill: dust, alpha: 0.32 * alpha });
}

function paintNebulaWash(
  g: Graphics,
  w: number,
  h: number,
  scene: ScenePalette,
  alpha: number,
  cache: GradientCache,
): void {
  // Magenta core. The outer stop fades to bgA so the bloom edges sink
  // into the wash, but the bright plateau is bgB so it actually shows.
  const core = cache.radial(
    `nebula-core`,
    [
      { offset: 0, color: scene.bgB },
      { offset: 0.55, color: scene.bgB },
      { offset: 1, color: scene.bgA },
    ],
    true,
  );
  g.circle(w * 0.5, h * 0.55, Math.max(w, h) * 0.85);
  g.fill({ fill: core, alpha: 0.45 * alpha });

  // Cyan halo on top, smaller and softer. Same trick.
  const halo = cache.radial(
    `nebula-halo`,
    [
      { offset: 0, color: scene.dust },
      { offset: 0.6, color: scene.bgB },
      { offset: 1, color: scene.bgA },
    ],
    true,
  );
  g.circle(w * 0.5, h * 0.5, Math.max(w, h) * 0.55);
  g.fill({ fill: halo, alpha: 0.22 * alpha });
}

export type ColorStop = { offset: number; color: Hex };

interface CachedGradient {
  grad: FillGradient;
  /**
   * Signature of everything baked into the gradient's texture: the color
   * stops plus, for radials, the drifted center. Pixi's `FillGradient`
   * rasterizes once and then `buildGradient()` short-circuits on
   * `if (this.texture) return`, so mutating `colorStops` / `center` on a
   * built instance is silently ignored. The only way to change a gradient
   * is to throw the old one away and build a new one — which is what this
   * signature triggers.
   */
  sig: string;
}

/**
 * Reusable `FillGradient` factory. Each `linear(key, ...)` / `radial(key, ...)`
 * returns the cached instance for that key as long as its colors (and drift)
 * are unchanged; when they move, the cached gradient is destroyed and rebuilt.
 *
 * Rebuilding rasterizes a 256px canvas ramp, so callers must keep the churn
 * slow: the backdrop repaints on the hue-bucket / breath cadence (≈1 Hz), not
 * per frame.
 */
export class GradientCache {
  private readonly entries = new Map<string, CachedGradient>();
  /** Ambient breath offset applied to driftable radial centers. */
  private driftX = 0;
  private driftY = 0;

  linear(key: string, stops: ColorStop[]): FillGradient {
    const sig = stopsSig(stops);
    return this.resolve(key, sig, () => {
      const grad = new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        textureSpace: 'local',
      });
      writeStops(grad, stops);
      return grad;
    });
  }

  radial(key: string, stops: ColorStop[], driftable = false): FillGradient {
    const cx = driftable ? 0.5 + this.driftX : 0.5;
    const cy = driftable ? 0.5 + this.driftY : 0.5;
    const sig = `${stopsSig(stops)}|${cx.toFixed(3)},${cy.toFixed(3)}`;
    return this.resolve(key, sig, () => {
      const grad = new FillGradient({
        type: 'radial',
        center: { x: cx, y: cy },
        innerRadius: 0,
        outerCenter: { x: cx, y: cy },
        outerRadius: 0.5,
        textureSpace: 'local',
      });
      writeStops(grad, stops);
      return grad;
    });
  }

  /**
   * Set the ambient breath offset (normalized [0..1] coords) used by the
   * next `radial(..., driftable)` build. Returns true when the offset moved
   * far enough to be worth a repaint — the caller quantizes, so a 20 s
   * breath cycle costs a handful of rebuilds, not 1200.
   */
  setDrift(dx: number, dy: number): boolean {
    if (dx === this.driftX && dy === this.driftY) return false;
    this.driftX = dx;
    this.driftY = dy;
    return true;
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.grad.destroy();
    this.entries.clear();
  }

  private resolve(
    key: string,
    sig: string,
    factory: () => FillGradient,
  ): FillGradient {
    const entry = this.entries.get(key);
    if (entry) {
      if (entry.sig === sig) return entry.grad;
      entry.grad.destroy();
    }
    const grad = factory();
    this.entries.set(key, { grad, sig });
    return grad;
  }
}

export function stopsSig(stops: ColorStop[]): string {
  let sig = '';
  for (const s of stops) sig += `${s.offset.toFixed(3)}:${s.color.toString(16)};`;
  return sig;
}

function writeStops(grad: FillGradient, stops: ColorStop[]): void {
  grad.colorStops.length = 0;
  for (const s of stops) {
    grad.colorStops.push({ offset: s.offset, color: cssColor(s.color) });
  }
}

/**
 * `FillGradient.colorStops` expects a CSS-style color string. Our palette
 * stores packed-hex integers (e.g. `0xff40a0`), so convert via the same
 * helper `applySceneToDocument` uses.
 */
function cssColor(hex: Hex): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}