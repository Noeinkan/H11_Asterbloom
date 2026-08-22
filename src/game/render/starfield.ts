import {
  Container,
  FillGradient,
  Graphics,
  RenderTexture,
  Sprite,
  type Renderer,
} from 'pixi.js';
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

/**
 * Resolution the backdrop is baked at, as a fraction of the viewport.
 *
 * The backdrop is five stacked full-screen fills (base, band, two blooms,
 * vignette). Kept as live `Graphics` they were re-shaded *every frame* —
 * roughly six screens of alpha-blended, texture-sampled fragments before a
 * single asteroid was drawn, which is exactly the fill-rate wall `PerfProbe`
 * reports as GPU-bound. They only actually change on the hue-bucket / breath
 * cadence (~1 Hz), so they are rendered once into a texture and blitted as a
 * single opaque quad instead.
 *
 * Half resolution because the backdrop is nothing but smooth gradients: the
 * bilinear upscale is indistinguishable from shading it at full size, and it
 * makes the (rare) re-bake a quarter of the cost.
 */
const BAKE_SCALE = 0.5;

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
 *
 * The screen-space backdrop is not drawn live: it is baked into a texture
 * whenever it changes and blitted as one sprite. See `BAKE_SCALE`.
 */
export class Starfield {
  /** Screen-space void. Add to the stage, behind the camera. */
  readonly backdrop = new Container();
  /** World-space nebulae and stars. */
  readonly root = new Container();
  /**
   * Bake source. Never added to the stage: it is drawn into `bakeTex` on the
   * frames the backdrop actually changes, and `backdropSprite` is what the
   * stage sees. Without a renderer (headless tests) it *is* the backdrop.
   */
  private readonly paint = new Graphics();
  private readonly backdropSprite = new Sprite();
  private readonly renderer: Renderer | null;
  private bakeTex: RenderTexture | null = null;
  private bakeDirty = true;
  /** Size the backdrop is painted at — the bake texture's, not the screen's. */
  private paintW = 1;
  private paintH = 1;
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

  constructor(seed: number, scene: ScenePalette, renderer: Renderer | null = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.themeA = scene.theme ?? 'void';
    this.themeB = this.themeA;
    this.backdrop.eventMode = 'none';
    this.root.eventMode = 'none';
    this.backdropSprite.visible = false;
    this.backdrop.addChild(renderer ? this.backdropSprite : this.paint);
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
    this.resizeBake();
    this.repaintBackdrop();
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
    this.repaintBackdrop();
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
    if (this.gradientCache.setDrift(dx, dy)) this.repaintBackdrop();
    this.flushBake();
  }

  /**
   * (Re)allocate the bake texture for the current viewport and stretch the
   * sprite back over it. Returns early when the size is unchanged so a
   * resize event that only moves the window costs nothing.
   */
  private resizeBake(): void {
    if (!this.renderer) {
      this.paintW = this.viewW;
      this.paintH = this.viewH;
      return;
    }
    const w = Math.max(1, Math.ceil(this.viewW * BAKE_SCALE));
    const h = Math.max(1, Math.ceil(this.viewH * BAKE_SCALE));
    if (!this.bakeTex || this.bakeTex.width !== w || this.bakeTex.height !== h) {
      this.bakeTex?.destroy(true);
      this.bakeTex = RenderTexture.create({
        width: w,
        height: h,
        resolution: 1,
        antialias: false,
      });
      this.backdropSprite.texture = this.bakeTex;
      this.paintW = w;
      this.paintH = h;
    }
    // Always re-stretch: `ceil` means two nearby viewport widths can share a
    // texture size while still needing different sprite scales.
    this.backdropSprite.width = this.viewW;
    this.backdropSprite.height = this.viewH;
  }

  /**
   * Re-shade the backdrop into the bake source and queue a bake.
   *
   * Both themes are stacked here, the same way the nebula layers are: the
   * outgoing theme lays down an opaque ground, the incoming one is composited
   * over it at `mix`. The backdrop used to be painted from `themeB` alone at
   * full alpha, which left the sky's wash a whole theme *ahead* of the
   * nebulae, the stars and `scene.theme` — and cut to the next one instantly
   * at each slot boundary instead of fading. Painting A first also keeps the
   * result opaque at every `mix`, which stacking both at partial alpha would
   * not.
   */
  private repaintBackdrop(): void {
    const w = this.paintW;
    const h = this.paintH;
    this.paint.clear();
    paintBackdropForTheme(this.paint, w, h, this.scene, this.themeA, 1, this.gradientCache);
    if (this.mix > 0.001) {
      paintBackdropForTheme(this.paint, w, h, this.scene, this.themeB, this.mix, this.gradientCache);
    }
    this.bakeDirty = true;
  }

  /**
   * Push the bake source into the texture, at most once per change.
   *
   * Only `tick()` calls this, and only from the ticker, for two reasons:
   * user ticker callbacks run at NORMAL priority and the application's own
   * render at LOW, so the bake always lands before the frame that reads it;
   * and `resize()` can arrive from inside `renderer.resize()` — the adaptive
   * backbuffer calls it mid-tick — where re-entering the renderer would not
   * be safe. Everything else just marks the bake dirty and waits a frame.
   */
  private flushBake(): void {
    const target = this.bakeTex;
    if (!this.bakeDirty || !this.renderer || !target) return;
    this.bakeDirty = false;
    this.renderer.render({ container: this.paint, target, clear: true });
    // A RenderTexture holds undefined contents until something is drawn into
    // it, so the sprite stays hidden until the first bake lands. Before that
    // the stage shows the renderer's background color, not GPU garbage.
    this.backdropSprite.visible = true;
  }

  destroy(): void {
    this.gradientCache.destroy();
    this.bakeTex?.destroy(true);
    this.bakeTex = null;
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
 * The band and the vignette cover the whole surface; the blooms are shapes,
 * so they feather their alpha to 0 at the rim rather than ending on a color
 * (see `bloomStops`) — otherwise the shape outlines itself.
 *
 * `w`/`h` are the *bake* size, not the viewport: every position here is a
 * fraction of them, so the picture is identical at any bake scale.
 *
 * The caller owns `g.clear()`, because two themed passes are stacked into
 * one surface during a crossfade.
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
 * Stops for a soft bloom: a bright `peak` plateau, a fade down to `edge`,
 * then a fully transparent tail.
 *
 * The transparent tail is the part that matters. A bloom used to end on an
 * opaque `bgA`, which only hides the shape's outline if `bgA` happens to
 * equal the pixels already underneath — and it never does, because the base
 * fill, the band and any earlier bloom have all painted there first. Drawn at
 * partial alpha, that mismatch composites as a hard step exactly along the
 * circle or ellipse, which is what read as a stray "ellipse" in the sky.
 * Fading the *alpha* to 0 instead makes the rim a no-op against whatever is
 * beneath it, so a bloom can be smaller than the screen without outlining
 * itself.
 *
 * Blooms are still flagged `driftable` so the ambient breath in `tick()` can
 * nudge their centers.
 */
export function bloomStops(peak: Hex, edge: Hex, plateau = 0.55): ColorStop[] {
  return [
    { offset: 0, color: peak },
    { offset: plateau, color: peak },
    { offset: 0.86, color: edge },
    { offset: 1, color: edge, alpha: 0 },
  ];
}

/**
 * Stops for an aurora band: a highlight plateau that feathers to nothing at
 * both ends of the gradient axis, for the same reason as `bloomStops`.
 */
export function bandStops(peak: Hex, edge: Hex): ColorStop[] {
  return [
    { offset: 0, color: edge, alpha: 0 },
    { offset: 0.18, color: edge },
    { offset: 0.4, color: peak },
    { offset: 0.6, color: peak },
    { offset: 0.82, color: edge },
    { offset: 1, color: edge, alpha: 0 },
  ];
}

/**
 * Each wash paints soft radial blooms (one shape filled with a radial
 * gradient) instead of stacked filled discs, so there are no disc edges to
 * read as "rings", and every gradient peaks on `bgB` (the brightest palette
 * field) rather than the near-black `bgA` — fading to black would just
 * disappear.
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
    bloomStops(scene.bgB, scene.bgA),
    true,
  );
  g.circle(w * 0.5, h * 0.46, Math.max(w, h) * 0.85);
  g.fill({ fill: primary, alpha: 0.7 * alpha });

  // Secondary bloom: a complementary pastel hue, smaller and offset, so
  // the wash shows two distinct color bands instead of one monochrome
  // gradient. This is what makes the void feel like deep space rather
  // than a single flat color.
  //
  // Its left and lower rim used to sit well inside the viewport (spanning
  // x 0.25w–1.25w, y −0.03h–0.67h), so the shape outlined itself across the
  // upper half of the sky. It now feathers to transparent (`bloomStops`) and
  // reaches further past three of the four edges, so only the highlight is
  // ever visible.
  const accent = cache.radial(
    `void-accent`,
    bloomStops(scene.mist, scene.bgA, 0.34),
    true,
  );
  g.ellipse(w * 0.78, h * 0.28, w * 0.62, h * 0.62);
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
    bloomStops(scene.bgB, scene.bgA, 0.5),
    true,
  );
  g.circle(w * 0.55, h * 0.3, Math.max(w, h) * 0.9);
  g.fill({ fill: highlight, alpha: 0.32 * alpha });

  // Cooler counter-glow toward the lower-left for depth.
  const shadow = cache.radial(
    `paper-shadow`,
    bloomStops(scene.bgC, scene.bgA, 0.5),
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
  const mist = cache.linear(`aurora-mist`, bandStops(scene.bgB, scene.bgA));
  g.ellipse(w * 0.4, h * 0.32, w * 0.7, h * 0.18);
  g.fill({ fill: mist, alpha: 0.4 * alpha });

  const dust = cache.linear(`aurora-dust`, bandStops(scene.bgC, scene.bgA));
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
    bloomStops(scene.bgB, scene.bgA),
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
      { offset: 0.86, color: scene.bgA },
      { offset: 1, color: scene.bgA, alpha: 0 },
    ],
    true,
  );
  g.circle(w * 0.5, h * 0.5, Math.max(w, h) * 0.55);
  g.fill({ fill: halo, alpha: 0.22 * alpha });
}

/**
 * A gradient stop. `alpha` defaults to 1; an explicit 0 is how a bloom ends
 * without drawing an edge — see `bloomStops`.
 */
export type ColorStop = { offset: number; color: Hex; alpha?: number };

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
  for (const s of stops) {
    sig += `${s.offset.toFixed(3)}:${s.color.toString(16)}@${(s.alpha ?? 1).toFixed(3)};`;
  }
  return sig;
}

function writeStops(grad: FillGradient, stops: ColorStop[]): void {
  grad.colorStops.length = 0;
  for (const s of stops) {
    grad.colorStops.push({ offset: s.offset, color: cssColor(s.color, s.alpha) });
  }
}

/**
 * `FillGradient.colorStops` expects a CSS-style color string. Our palette
 * stores packed-hex integers (e.g. `0xff40a0`), so convert via the same
 * helper `applySceneToDocument` uses.
 *
 * Translucent stops come out as `#rrggbbaa`. Pixi rasterizes the ramp onto a
 * 2D canvas and uploads it with `premultiply-alpha-on-upload`, so an alpha
 * stop is honoured end to end.
 */
function cssColor(hex: Hex, alpha = 1): string {
  const rgb = `#${hex.toString(16).padStart(6, '0')}`;
  if (alpha >= 1) return rgb;
  const a = Math.round(Math.max(0, alpha) * 255);
  return `${rgb}${a.toString(16).padStart(2, '0')}`;
}