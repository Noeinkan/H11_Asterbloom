/**
 * Eufloria-like palettes are not one swatch — they are a transform.
 *
 * Rule:
 *   1. Pick a key hue (scene atmosphere).
 *   2. Pastelize living color: keep hue, clamp saturation, lift lightness
 *      (tint with white — never neon, never chalk-grey).
 *   3. Wash large areas of the same hue: either a dark void or light paper.
 *   4. Structure (wood, ink) sits on the complement, muted (dusty, mid value).
 *   5. Energy / Strength / Speed mix as yellow / red / green, then pull
 *      toward the scene hue and pastelize — so every asteroid’s flora differs.
 */
import { mulberry32 } from '../sim/rng';
import type { FactionId, ResourceKind, SeedlingKind, Stats } from '../sim/types';

export type Hex = number;

export interface ScenePalette {
  /** 0–360 */
  hue: number;
  dark: boolean;
  bg: Hex;
  bgA: Hex;
  bgB: Hex;
  bgC: Hex;
  ink: Hex;
  inkSoft: Hex;
  mist: Hex;
  dust: Hex;
  /** Which background mood is active. Set by `sceneAtTime`; default `void`. */
  theme?: BackgroundTheme;
  /**
   * 0 = full dark void (flora uses dark-rock / bright-leaf defaults),
   * 1 = full paper wash (flora uses silhouette tones for contrast).
   * Crossfaded between themes, so the flora contrast moves smoothly
   * across theme transitions rather than snapping.
   */
  contrast: number;
}

/**
 * Backdrop moods that cycle slowly alongside the hue wheel. Each theme sets
 * its own bg / mist / dust recipes so the sky reads as a different place,
 * not just a recolored version of the same place.
 */
export type BackgroundTheme = "void" | "paper" | "aurora" | "nebula";

export const BACKGROUND_THEMES: readonly BackgroundTheme[] = [
  "void",
  "paper",
  "aurora",
  "nebula",
] as const;

/**
 * How much "light theme" the flora should compensate for. 0 = the dark
 * void, where bright leaves and pastel flowers pop on their own. 1 = the
 * paper wash, where leaves/flowers would wash out, so flora must drop
 * into silhouette tones (darker rock, darker wood, deeper outlines).
 */
const THEME_CONTRAST: Record<BackgroundTheme, number> = {
  void: 0,
  paper: 1,
  aurora: 0.2,
  nebula: 0.1,
};

export interface FloraPalette {
  wood: Hex;
  tuft: Hex;
  leaf: Hex;
  grass: Hex;
  flower: Hex;
  root: Hex;
  rootSoft: Hex;
  /** Bloom halo for subsurface filaments. */
  rootGlow: Hex;
  wing: Hex;
  seedBody: Hex;
  core: Hex;
  coreHot: Hex;
  coreWhite: Hex;
  rock: Hex;
  rockShadow: Hex;
  rockLit: Hex;
  stain: Hex;
  outline: Hex;
  ring: Hex;
  /** Living crust film — pollen stain, planet-colored, not generic green. */
  film: Hex;
}

const PASTEL_S = { min: 0.22, max: 0.46 };
const PASTEL_L = { min: 0.6, max: 0.84 };

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function hexToRgb(hex: Hex): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): Hex {
  const R = Math.round(clamp(r, 0, 1) * 255);
  const G = Math.round(clamp(g, 0, 1) * 255);
  const B = Math.round(clamp(b, 0, 1) * 255);
  return (R << 16) | (G << 8) | B;
}

/** Linear blend of two hex colors in RGB (t=0 → a, t=1 → b). */
export function mixHex(a: Hex, b: Hex, t: number): Hex {
  const u = clamp(t, 0, 1);
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * u, ag + (bg - ag) * u, ab + (bb - ab) * u);
}

/**
 * Pocket accent color by resource kind. Mineral reads warm brown, water a
 * cool blue-cyan, energy a warm yellow-green — all pulled from the same
 * flora palette so each rock keeps a coherent tint.
 */
export function resourceKindHex(kind: ResourceKind, pal: FloraPalette): Hex {
  if (kind === 'mineral') return mixHex(pal.stain, pal.rockShadow, 0.3);
  if (kind === 'water') return mixHex(pal.coreWhite, pal.film, 0.4);
  return mixHex(pal.core, pal.coreHot, 0.4);
}

/** h in 0–360, s/l in 0–1 */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, hue + 1 / 3), hue2rgb(p, q, hue), hue2rgb(p, q, hue - 1 / 3)];
}

function hue2rgb(p: number, q: number, t: number): number {
  let u = t;
  if (u < 0) u += 1;
  if (u > 1) u -= 1;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 1 / 2) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
}

export function hslToHex(h: number, s: number, l: number): Hex {
  const [r, g, b] = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

export function cssHex(hex: Hex): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function lerpHue(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

export function hueDistance(a: number, b: number): number {
  return Math.abs(((((b - a) % 360) + 540) % 360) - 180);
}

/**
 * The pastel operator: same hue, chroma in a soft band, value lifted
 * toward white. Works on any input color (title magenta, in-game cyan, …).
 */
export function toPastel(hex: Hex): Hex {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const s2 = clamp(s * 0.55 + 0.18, PASTEL_S.min, PASTEL_S.max);
  const l2 = clamp(l * 0.35 + 0.58, PASTEL_L.min, PASTEL_L.max);
  return hslToHex(h, s2, l2);
}

/** Dusty mid-value cousin — trunks, ink, tufts. */
export function toMuted(hex: Hex, darkWash: boolean): Hex {
  const [h, s] = rgbToHsl(...hexToRgb(hex));
  const s2 = clamp(s * 0.5 + 0.28, 0.28, 0.5);
  const l2 = darkWash ? 0.5 : 0.36;
  return hslToHex(h, s2, l2);
}

export function isPastel(hex: Hex): boolean {
  const [, s, l] = rgbToHsl(...hexToRgb(hex));
  return s >= PASTEL_S.min - 0.02 && s <= PASTEL_S.max + 0.02 && l >= PASTEL_L.min - 0.02 && l <= PASTEL_L.max + 0.02;
}

/** Strength → red, Speed → green (+ a little blue), Energy → yellow. */
export function mixStatsRgb(stats: Stats): [number, number, number] {
  const e = clamp(stats.energy / 200, 0, 1);
  const k = clamp(stats.strength / 200, 0, 1);
  const v = clamp(stats.speed / 200, 0, 1);
  let r = k + e;
  let g = v + e;
  let b = v * 0.45;
  const m = Math.max(r, g, b, 1e-6);
  return [r / m, g / m, b / m];
}

export function accentHue(stats: Stats, sceneHue: number): number {
  const [h] = rgbToHsl(...mixStatsRgb(stats));
  return lerpHue(h, sceneHue, 0.35);
}

/** Seconds for one full hue wheel. Gameplay stays in the dark void. */
export const HUE_CYCLE_SECONDS = 180;

/** Seconds for one full rotation through the four background themes. */
export const THEME_CYCLE_SECONDS = 360;

/** Crossfade window inside the theme cycle. Smooths the snap between moods. */
export const THEME_FADE_SECONDS = 8;

/**
 * Quantize a hue to a 1° bucket so views can short-circuit full repaints
 * when the scene drift stays inside one bucket. 360 paints per full cycle
 * is visually indistinguishable from per-frame redraw.
 */
export function bucketHue(hue: number): number {
  const v = Math.round(((hue % 360) + 360) % 360);
  return v === 360 ? 0 : v;
}

/** Seconds for one sap rise: core → roots → trunk → branches → crust. */
export const SAP_RISE_SECONDS = 5.55;

/**
 * Normalized windows along `sapRiseU`. Windows overlap so two stages are
 * always alive at once — the rise is continuous and the eye never catches a
 * hard edge between core → roots → trunk → twigs → crust.
 */
export const SAP_WINDOW = {
  core: [0, 0.18],
  roots: [0.04, 0.46],
  trunk: [0.3, 0.62],
  twig: [0.5, 0.82],
  grass: [0.66, 0.96],
} as const;

/** 0..1 position in the sap-rise cycle for this plant. */
export function sapRiseU(time: number, seed: number): number {
  const phase = (seed % 997) * 0.0017;
  const x = (time + phase) / SAP_RISE_SECONDS;
  return x - Math.floor(x);
}

/**
 * How far a pulse has traveled through a stage, plus leftover vein glow
 * after the head has passed. The rising ramp uses smoothstep so the head
 * fades in instead of popping, and the afterglow tails off as
 * `smoothstep(0, 1, fadeT)^2` so the glow blends into the next stage.
 */
export function sapStage(
  u: number,
  start: number,
  end: number,
  fade = 0.32,
): { progress: number; glow: number; rising: boolean } {
  if (u < start) return { progress: 0, glow: 0, rising: false };
  const span = Math.max(1e-4, end - start);
  if (u <= end) {
    const p = (u - start) / span;
    const s = p * p * (3 - 2 * p);
    return { progress: p, glow: 0.38 + 0.62 * s, rising: true };
  }
  const fadeT = Math.max(0, 1 - (u - end) / fade);
  const s = fadeT * fadeT * (3 - 2 * fadeT);
  return { progress: 1, glow: 0.3 * s * s, rising: false };
}

export function buildScene(hue: number, dark: boolean): ScenePalette {
  return buildSceneForTheme(hue, dark ? "void" : "paper");
}

/**
 * Build a scene tinted for a specific background theme. The `dark` flag is
 * kept for the original void/paper split; new themes pick their own dark
 * vs light variant from the theme name.
 */
export function buildSceneForTheme(
  hue: number,
  theme: BackgroundTheme,
): ScenePalette {
  const h = ((hue % 360) + 360) % 360;
  let bgA: Hex;
  let bgB: Hex;
  let bgC: Hex;
  let ink: Hex;
  let inkSoft: Hex;
  let mist: Hex;
  let dust: Hex;
  let dark: boolean;
  switch (theme) {
    case "void":
      // Dark space void with visible color bands. The gradient backs onto
      // bgA/bgC at the page edges (luminance ≈ 5%) so the screen reads as
      // space, and rises to bgB plateau (luminance ≈ 40%) so the wash
      // shows a colored band rather than collapsing to monochrome black.
      bgA = hslToHex(h, 0.26, 0.05);
      bgB = hslToHex(h + 32, 0.4, 0.4);
      bgC = hslToHex(h - 48, 0.24, 0.06);
      ink = hslToHex(h, 0.16, 0.82);
      inkSoft = hslToHex(h, 0.12, 0.7);
      mist = toPastel(hslToHex(h, 0.4, 0.7));
      dust = toPastel(hslToHex(h + 50, 0.45, 0.72));
      dark = true;
      break;
    case "paper":
      // Light wash — a dawn paper. Same hue drift, but lifted lightness so
      // HUD ink stays readable while planets sit on a warm pastel ground.
      bgA = hslToHex(h, 0.12, 0.88);
      bgB = hslToHex(h + 18, 0.1, 0.92);
      bgC = hslToHex(h - 16, 0.14, 0.86);
      ink = hslToHex(h + 160, 0.42, 0.28);
      inkSoft = hslToHex(h + 160, 0.28, 0.38);
      mist = toPastel(hslToHex(h + 90, 0.4, 0.7));
      dust = toPastel(hslToHex(h + 140, 0.45, 0.72));
      dark = false;
      break;
    case "aurora":
      // Mid-light wash with a green→violet axis. Mist reads as the aurora's
      // highlight band; dust trails behind it in dusty pink.
      bgA = hslToHex(h, 0.18, 0.18);
      bgB = hslToHex(h + 32, 0.4, 0.4);
      bgC = hslToHex(h - 24, 0.16, 0.12);
      ink = hslToHex(h + 110, 0.24, 0.78);
      inkSoft = hslToHex(h + 110, 0.18, 0.62);
      mist = toPastel(hslToHex(h + 110, 0.46, 0.72));
      dust = toPastel(hslToHex(h + 160, 0.42, 0.7));
      dark = true;
      break;
    case "nebula":
      // Deep magenta dust with cyan stars. Hue drifts more than the other
      // themes so the nebula center swings warm/cool as the cycle turns.
      bgA = hslToHex(h, 0.32, 0.06);
      bgB = hslToHex(h + 40, 0.4, 0.4);
      bgC = hslToHex(h - 60, 0.26, 0.05);
      ink = hslToHex(h + 200, 0.22, 0.82);
      inkSoft = hslToHex(h + 200, 0.16, 0.66);
      mist = toPastel(hslToHex(h + 200, 0.5, 0.72));
      dust = toPastel(hslToHex(h + 30, 0.5, 0.7));
      dark = true;
      break;
  }
  return {
    hue: h,
    dark,
    bg: bgB,
    bgA,
    bgB,
    bgC,
    ink,
    inkSoft,
    mist,
    dust,
    theme,
    contrast: THEME_CONTRAST[theme],
  };
}

export function createScenePalette(seed: number): ScenePalette {
  return sceneAtTime(seed, 0);
}

/**
 * Which theme is active at this time, plus how far we are into the current
 * slot of the cycle (0..1). Two themes are live at the edge of each slot —
 * `themeA` fading out, `themeB` fading in — so the rotation is smooth.
 */
export function themeAt(
  seed: number,
  time: number,
): {
  themeA: BackgroundTheme;
  themeB: BackgroundTheme;
  /** 0 = full A, 1 = full B. Smooth ramp over THEME_FADE_SECONDS. */
  mix: number;
  /** 0..1 progress through the whole THEME_CYCLE_SECONDS rotation. */
  progress: number;
} {
  const rng = mulberry32((seed ^ 0xa5a5a5a5) >>> 0);
  const start = Math.floor(rng() * BACKGROUND_THEMES.length);
  const t = Math.max(0, time);
  const slotSeconds = THEME_CYCLE_SECONDS / BACKGROUND_THEMES.length;
  const laps = t / slotSeconds;
  const slotPos = laps - Math.floor(laps);
  const idxA = (start + Math.floor(laps)) % BACKGROUND_THEMES.length;
  const idxB = (start + Math.floor(laps) + 1) % BACKGROUND_THEMES.length;
  const themeA = BACKGROUND_THEMES[idxA]!;
  const themeB = BACKGROUND_THEMES[idxB]!;
  // Spend the middle ~78% of each slot in a single theme; crossfade in the
  // last slice. `mix` climbs from 0 to 1 over THEME_FADE_SECONDS.
  const fadeStart = 1 - THEME_FADE_SECONDS / slotSeconds;
  const mix =
    slotPos <= fadeStart
      ? 0
      : Math.min(1, (slotPos - fadeStart) / (1 - fadeStart));
  return { themeA, themeB, mix, progress: (t / THEME_CYCLE_SECONDS) % 1 };
}

/**
 * Slow ambient cycle: hue drifts through every pastel family.
 * The active background theme crossfades between themes on a longer cycle
 * (THEME_CYCLE_SECONDS). The returned palette is the **fully-blended**
 * version of the two live themes, so consumers that only need colors can
 * keep using the palette unchanged.
 */
export function sceneAtTime(seed: number, time: number): ScenePalette {
  const rng = mulberry32(seed >>> 0);
  const baseHue = rng() * 360;
  const t = Math.max(0, time);
  const laps = t / HUE_CYCLE_SECONDS;
  const hue = (baseHue + laps * 360) % 360;
  const themes = themeAt(seed, t);
  const a = buildSceneForTheme(hue, themes.themeA);
  const b = buildSceneForTheme(hue, themes.themeB);
  const blended = interpolateScene(a, b, themes.mix);
  // The "current" theme is whichever one is fading in (or themeA before the
  // fade window). Used by views that want to short-circuit when nothing
  // changed.
  blended.theme = themes.mix >= 0.5 ? themes.themeB : themes.themeA;
  return blended;
}

/**
 * Field-by-field blend of two palettes in HSL. Hue is lerped via the
 * shortest arc (so 0° and 360° don't take the long way around); lightness
 * and saturation are mixed linearly.
 */
export function interpolateScene(a: ScenePalette, b: ScenePalette, t: number): ScenePalette {
  const u = clamp(t, 0, 1);
  const fields: (keyof ScenePalette)[] = [
    "bgA",
    "bgB",
    "bgC",
    "bg",
    "ink",
    "inkSoft",
    "mist",
    "dust",
  ];
  const out: ScenePalette = {
    hue: lerpHue(a.hue, b.hue, u),
    dark: u < 0.5 ? a.dark : b.dark,
    bgA: a.bgA,
    bgB: a.bgB,
    bgC: a.bgC,
    bg: a.bg,
    ink: a.ink,
    inkSoft: a.inkSoft,
    mist: a.mist,
    dust: a.dust,
    contrast: a.contrast + (b.contrast - a.contrast) * u,
  };
  for (const f of fields) {
    const ha = rgbToHsl(...hexToRgb(a[f] as Hex));
    const hb = rgbToHsl(...hexToRgb(b[f] as Hex));
    const h = lerpHue(ha[0], hb[0], u);
    const s = ha[1] + (hb[1] - ha[1]) * u;
    const l = ha[2] + (hb[2] - ha[2]) * u;
    (out as unknown as Record<string, unknown>)[f] = hslToHex(h, s, l);
  }
  return out;
}

export function writeScene(dst: ScenePalette, src: ScenePalette): void {
  dst.hue = src.hue;
  dst.dark = src.dark;
  dst.bg = src.bg;
  dst.bgA = src.bgA;
  dst.bgB = src.bgB;
  dst.bgC = src.bgC;
  dst.ink = src.ink;
  dst.inkSoft = src.inkSoft;
  dst.mist = src.mist;
  dst.dust = src.dust;
  dst.theme = src.theme;
  dst.contrast = src.contrast;
}

export function floraEquals(a: FloraPalette, b: FloraPalette): boolean {
  return (
    a.wood === b.wood &&
    a.tuft === b.tuft &&
    a.leaf === b.leaf &&
    a.grass === b.grass &&
    a.flower === b.flower &&
    a.root === b.root &&
    a.rootSoft === b.rootSoft &&
    a.rootGlow === b.rootGlow &&
    a.wing === b.wing &&
    a.seedBody === b.seedBody &&
    a.core === b.core &&
    a.coreHot === b.coreHot &&
    a.coreWhite === b.coreWhite &&
    a.rock === b.rock &&
    a.rockShadow === b.rockShadow &&
    a.rockLit === b.rockLit &&
    a.stain === b.stain &&
    a.outline === b.outline &&
    a.ring === b.ring &&
    a.film === b.film
  );
}

export function floraPalette(
  stats: Stats,
  seed: number,
  scene: ScenePalette,
): FloraPalette {
  const rng = mulberry32(seed >>> 0);
  const h = accentHue(stats, scene.hue);
  const woodH = (h + 150 + rng() * 36 - 18 + 360) % 360;

  // `contrast` smoothly blends the dark-void flora (bright leaves on a dark
  // rock) toward the paper-wash flora (deeper rock + darker outline so the
  // planet reads as a silhouette instead of dissolving into the bg).
  const c = clamp(scene.contrast, 0, 1);

  // Linear blends between the dark and light branch lightnesses.
  const flower = hslToHex(h, 0.34, lerp(0.78, 0.7, c));
  const wing = hslToHex(h, 0.3, 0.74);
  const seedBody = hslToHex(h, 0.42, 0.4);
  const wood = hslToHex(woodH, 0.38, lerp(0.52, 0.34, c));
  const tuft = hslToHex(woodH, 0.4, lerp(0.58, 0.4, c));
  const leafH = lerpHue(woodH, 118, 0.42);
  // On light bg the leaf darkens enough to sit on top of the wash without
  // going matte black.
  const leaf = hslToHex(leafH, 0.48, lerp(0.62, 0.4, c));
  const grassH = lerpHue(h, leafH, 0.62);
  const grass = hslToHex(grassH, 0.4, lerp(0.52, 0.45, c));
  const filmH = lerpHue(grassH, h, 0.45);
  const film = hslToHex(filmH, 0.46, lerp(0.5, 0.42, c));
  const core = hslToHex(h, 0.42, 0.72);
  const coreHot = hslToHex(h, 0.5, 0.62);
  const coreWhite = hslToHex(h, 0.12, 0.94);
  // Roots bridge wood at the collar toward the living core accent.
  const rootH = lerpHue(woodH, h, 0.58);
  const root = hslToHex(rootH, 0.48, lerp(0.48, 0.34, c));
  const rootSoft = hslToHex(lerpHue(rootH, h, 0.35), 0.36, lerp(0.62, 0.46, c));
  const rootGlow = hslToHex(lerpHue(rootH, h, 0.72), 0.28, lerp(0.78, 0.62, c));
  const rockH = lerpHue(scene.hue, h, 0.42);
  // Rock: dark void uses ~0.22-0.30, paper sits at ~0.36-0.42 so the planet
  // reads as a mid-dark silhouette against the wash. Pitch black would
  // look like a hole in the sky; pure white would wash out.
  const rockL = lerp(0.24, 0.38, c) + rng() * 0.06;
  const rockS = lerp(0.22, 0.2, c) + rng() * 0.08;
  const rock = hslToHex(rockH, rockS, rockL);
  const rockShadow = hslToHex(rockH, rockS + 0.04, rockL - lerp(0.08, 0.14, c));
  const rockLit = hslToHex(rockH, rockS * 0.7, Math.min(0.9, rockL + 0.12));
  // Stain darkens on light themes so the lichen reads against the wash.
  const stain = hslToHex(h, 0.28, lerp(0.42, 0.28, c));
  // Outline darkens on light themes so the planet edge reads against the wash.
  const outline = hslToHex(woodH, 0.18, lerp(0.22, 0.32, c));
  const ring = tuft;

  return {
    wood,
    tuft,
    leaf,
    grass,
    flower,
    root,
    rootSoft,
    rootGlow,
    wing,
    seedBody,
    core,
    coreHot,
    coreWhite,
    rock,
    rockShadow,
    rockLit,
    stain,
    outline,
    ring,
    film,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function seedlingColors(
  stats: Stats,
  scene: ScenePalette,
  extras?: { faction?: FactionId; kind?: SeedlingKind },
): { wing: Hex; body: Hex } {
  let h = accentHue(stats, scene.hue);
  let s = extras?.kind === 'sentinel' ? 0.4 : 0.3;
  let l = extras?.kind === 'sentinel' ? 0.7 : 0.74;
  // On a light wash the pastel wings disappear — pull lightness down so the
  // silhouette reads against the bg. Body stays dark; only the wing changes.
  const c = clamp(scene.contrast, 0, 1);
  l = lerp(l, l - 0.28, c);
  if (extras?.faction === 'grey') {
    s *= 0.35;
    l = lerp(0.62, 0.4, c);
  } else if (extras?.faction === 'enemy') {
    h = lerpHue(h, 12, 0.55);
    s = Math.min(0.48, s + 0.08);
  }
  return {
    wing: hslToHex(h, s, l),
    body: hslToHex(
      h,
      Math.min(0.52, s + 0.12),
      extras?.kind === 'sentinel' ? 0.34 : 0.4,
    ),
  };
}

export function factionCoreHue(faction: FactionId, floraHue: number): number {
  if (faction === 'enemy') return lerpHue(floraHue, 8, 0.7);
  if (faction === 'grey') return lerpHue(floraHue, 40, 0.25);
  return floraHue;
}

export function applySceneToDocument(scene: ScenePalette): void {
  const root = document.documentElement.style;
  root.setProperty('--ab-bg', cssHex(scene.bg));
  root.setProperty('--ab-ink', cssHex(scene.ink));
  root.setProperty('--ab-ink-soft', cssHex(scene.inkSoft));
  // The HUD card sits on top of the bg, so its fill must contrast against
  // it. On dark themes the card uses a translucent dark wash (current
  // behaviour); on light themes it switches to a dark wash with light ink
  // so the bottom bar stays legible. We crossfade between the two so
  // theme transitions don't snap.
  const c = clamp(scene.contrast, 0, 1);
  // Dark card: dark wash with dark ink; light card: dark wash with light ink.
  const cardBg = mixHex(0x101218, 0x12141a, c);
  const cardInk = mixHex(0x7a3040, 0xf2e6d4, c);
  const cardInkSoft = mixHex(0x4a2830, 0xc6b89e, c);
  root.setProperty('--ab-bg-card', cssHex(cardBg));
  root.setProperty('--ab-ink-card', cssHex(cardInk));
  root.setProperty('--ab-ink-card-soft', cssHex(cardInkSoft));
  // Numeric contrast so CSS can pick its own falloff if needed.
  root.setProperty('--ab-contrast', c.toFixed(3));
}
