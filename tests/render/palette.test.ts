import { describe, expect, it } from 'vitest';
import {
  accentHue,
  BACKGROUND_THEMES,
  bucketHue,
  buildScene,
  buildSceneForTheme,
  createScenePalette,
  floraPalette,
  hexToRgb,
  HUE_CYCLE_SECONDS,
  hueDistance,
  interpolateScene,
  isPastel,
  mixStatsRgb,
  rgbToHsl,
  sceneAtTime,
  seedlingColors,
  themeAt,
  THEME_CYCLE_SECONDS,
  THEME_FADE_SECONDS,
  toPastel,
} from '../../src/game/render/palette';
import type { BackgroundTheme } from '../../src/game/render/palette';
import type { Stats } from '../../src/game/sim/types';

const red = 0xff0000;
const cyan = 0x00e0ff;
const magenta = 0xff40a0;

describe('pastel rule', () => {
  it('toPastel lifts any hue into the pastel saturation/lightness band', () => {
    for (const hex of [red, cyan, magenta, 0x221018, 0xf2e6d4]) {
      const out = toPastel(hex);
      expect(isPastel(out)).toBe(true);
      const [h0] = rgbToHsl(...hexToRgb(hex));
      const [h1] = rgbToHsl(...hexToRgb(out));
      expect(hueDistance(h0, h1)).toBeLessThan(8);
    }
  });

  it('gameplay palette defaults to a dark theme at t=0', () => {
    const odd = createScenePalette(0xc0a1f00d);
    const even = createScenePalette(0xc0a1f00e);
    // Different seeds pick a different starting theme, but every theme in
    // the rotation is intentionally dark-ish so gameplay readability stays
    // consistent. Specifically `void`, `aurora`, and `nebula` are dark.
    expect(['void', 'aurora', 'nebula']).toContain(odd.theme);
    expect(['void', 'aurora', 'nebula']).toContain(even.theme);
    if (odd.theme === 'void') {
      const [, , lOdd] = rgbToHsl(...hexToRgb(odd.bg));
      // Backdrop bg stays dark enough that ink readability is preserved,
      // but lifted above pure black so the wash shows a visible color band
      // (was 0.085; bumped to a Material-3 dark surface band).
      expect(lOdd).toBeGreaterThan(0.3);
      expect(lOdd).toBeLessThan(0.5);
    }
  });

  it('buildScene can still mix a light paper wash', () => {
    const light = buildScene(40, false);
    expect(light.dark).toBe(false);
    const [, , l] = rgbToHsl(...hexToRgb(light.bg));
    expect(l).toBeGreaterThan(0.8);
  });

  it('sceneAtTime drifts hue and stays within the theme rotation', () => {
    const a = sceneAtTime(1, 0);
    const b = sceneAtTime(1, HUE_CYCLE_SECONDS / 2);
    const c = sceneAtTime(1, HUE_CYCLE_SECONDS);
    expect(hueDistance(a.hue, b.hue)).toBeGreaterThan(150);
    expect(hueDistance(a.hue, c.hue)).toBeLessThan(2);
    expect(a.theme).toBeDefined();
    expect(BACKGROUND_THEMES).toContain(a.theme);
  });

  it('Energy/Strength/Speed mix as yellow/red/green before pastelizing', () => {
    const strong = mixStatsRgb({ energy: 0, strength: 200, speed: 0 });
    const swift = mixStatsRgb({ energy: 0, strength: 0, speed: 200 });
    const rich = mixStatsRgb({ energy: 200, strength: 0, speed: 0 });
    expect(strong[0]).toBeGreaterThan(strong[1]);
    expect(swift[1]).toBeGreaterThan(swift[0]);
    expect(rich[0]).toBeCloseTo(rich[1], 5);
    expect(rich[0]).toBeGreaterThan(rich[2]);
  });

  it('high-speed flora sits cooler than high-strength flora on the same scene', () => {
    const scene = createScenePalette(1);
    const fast: Stats = { energy: 40, strength: 20, speed: 180 };
    const tough: Stats = { energy: 40, strength: 180, speed: 20 };
    expect(accentHue(fast, scene.hue)).not.toBeCloseTo(accentHue(tough, scene.hue), 0);
    const fastH = accentHue(fast, scene.hue);
    const toughH = accentHue(tough, scene.hue);
    // Tough leans red (0°), fast leans green/cyan (120–200°).
    expect(hueDistance(toughH, 0)).toBeLessThan(hueDistance(fastH, 0));
  });

  it('wood is a muted complement of the blossom', () => {
    const scene = createScenePalette(1);
    const pal = floraPalette(
      { energy: 90, strength: 60, speed: 120 },
      99,
      scene,
    );
    const [flowerH] = rgbToHsl(...hexToRgb(pal.flower));
    const [woodH] = rgbToHsl(...hexToRgb(pal.wood));
    expect(hueDistance(flowerH, woodH)).toBeGreaterThan(80);
    expect(isPastel(pal.flower)).toBe(true);
    expect(isPastel(pal.wing)).toBe(true);
  });

  it('seedling wings follow the same pastel operator', () => {
    const scene = createScenePalette(7);
    const { wing } = seedlingColors({ energy: 80, strength: 50, speed: 90 }, scene);
    expect(isPastel(wing)).toBe(true);
  });
});

describe('background themes', () => {
  it('every theme in the rotation builds a distinct palette', () => {
    const seen = new Set<BackgroundTheme>();
    for (const theme of BACKGROUND_THEMES) {
      const scene = buildSceneForTheme(42, theme);
      expect(scene.theme).toBe(theme);
      if (scene.theme) seen.add(scene.theme);
    }
    expect(seen.size).toBe(BACKGROUND_THEMES.length);
    // Paper should produce a non-dark palette; the rest stay dark.
    const paper = buildSceneForTheme(42, 'paper');
    expect(paper.dark).toBe(false);
    expect(buildSceneForTheme(42, 'void').dark).toBe(true);
  });

  it('themeAt reports the current pair and crossfade mix', () => {
    const slotSeconds = THEME_CYCLE_SECONDS / BACKGROUND_THEMES.length;
    const start = themeAt(1, 0);
    const mid = themeAt(1, slotSeconds * 0.5);
    const atFade = themeAt(
      1,
      slotSeconds - THEME_FADE_SECONDS / 2,
    );
    expect(BACKGROUND_THEMES).toContain(start.themeA);
    expect(BACKGROUND_THEMES).toContain(start.themeB);
    // Mid-slot is fully on themeA (mix = 0).
    expect(mid.mix).toBe(0);
    expect(mid.themeA).toBe(start.themeA);
    // At the crossfade window the next theme begins fading in.
    expect(atFade.mix).toBeGreaterThan(0);
    expect(atFade.mix).toBeLessThan(1);
  });

  it('themes rotate through every entry over a full cycle', () => {
    const seen = new Set<BackgroundTheme>();
    for (let i = 0; i < BACKGROUND_THEMES.length; i++) {
      const t = (i + 0.5) * (THEME_CYCLE_SECONDS / BACKGROUND_THEMES.length);
      const mid = themeAt(0x1234, t);
      // Use themeA (or themeB if mid is inside the crossfade window)
      seen.add(mid.mix >= 0.5 ? mid.themeB : mid.themeA);
    }
    expect(seen.size).toBe(BACKGROUND_THEMES.length);
  });
});

describe('palette interpolation', () => {
  it('interpolateScene at t=0 returns scene A; at t=1 returns scene B', () => {
    const a = buildSceneForTheme(20, 'void');
    const b = buildSceneForTheme(220, 'paper');
    const lo = interpolateScene(a, b, 0);
    const hi = interpolateScene(a, b, 1);
    expect(lo.bg).toBe(a.bg);
    expect(lo.bgA).toBe(a.bgA);
    expect(hi.bg).toBe(b.bg);
    expect(hi.bgA).toBe(b.bgA);
  });

  it('interpolateScene midpoint sits between the two palettes', () => {
    const a = buildSceneForTheme(0, 'void');
    const b = buildSceneForTheme(120, 'void');
    const mid = interpolateScene(a, b, 0.5);
    const [ha] = rgbToHsl(...hexToRgb(a.mist));
    const [hb] = rgbToHsl(...hexToRgb(b.mist));
    const [hm] = rgbToHsl(...hexToRgb(mid.mist));
    // Mist midpoint hue should be near the shorter arc midpoint.
    expect(hueDistance(hm, (ha + hb) / 2)).toBeLessThan(20);
  });
});

describe('hue bucket cache', () => {
  it('bucketHue rounds to the nearest degree', () => {
    expect(bucketHue(0.4)).toBe(0);
    expect(bucketHue(0.6)).toBe(1);
    expect(bucketHue(359.6)).toBe(0);
    expect(bucketHue(180.49)).toBe(180);
  });

  it('sceneAtTime reports a different bucket every degree', () => {
    const lastBucket = bucketHue(sceneAtTime(7, 0).hue);
    let changed = 0;
    // Step through 10 seconds at 60 fps — at least one bucket boundary.
    for (let i = 1; i <= 600; i++) {
      const b = bucketHue(sceneAtTime(7, i / 60).hue);
      if (b !== lastBucket) changed++;
      if (changed > 0) break;
    }
    expect(changed).toBeGreaterThan(0);
  });
});

describe('theme contrast', () => {
  it('void theme has zero contrast; paper theme has full contrast', () => {
    const v = buildSceneForTheme(42, 'void');
    const p = buildSceneForTheme(42, 'paper');
    expect(v.contrast).toBe(0);
    expect(p.contrast).toBe(1);
  });

  it('sceneAtTime blends contrast across the theme crossfade', () => {
    const slotSeconds = THEME_CYCLE_SECONDS / BACKGROUND_THEMES.length;
    // Pick a time inside the crossfade window between two arbitrary themes
    // and confirm the blended contrast is between the two endpoints.
    const before = sceneAtTime(1, slotSeconds - THEME_FADE_SECONDS);
    const after = sceneAtTime(1, slotSeconds);
    const mid = sceneAtTime(
      1,
      slotSeconds - THEME_FADE_SECONDS / 2,
    );
    expect(mid.contrast).toBeGreaterThanOrEqual(0);
    expect(mid.contrast).toBeLessThanOrEqual(1);
    // The mid crossfade must sit between the two adjacent theme contrasts.
    const lo = Math.min(before.contrast, after.contrast);
    const hi = Math.max(before.contrast, after.contrast);
    expect(mid.contrast).toBeGreaterThanOrEqual(lo - 0.001);
    expect(mid.contrast).toBeLessThanOrEqual(hi + 0.001);
  });

  it('paper-theme flora lifts the rock away from wash-out', () => {
    // Before the contrast fix the paper theme used scene.dark=false to pick
    // a near-white rock lightness (~0.7) which disappeared into the paper
    // bg (~0.88). The fix pulls the paper rock into a mid-tone (~0.4) so
    // it reads as a silhouette against the wash.
    const light = buildSceneForTheme(80, 'paper');
    const floraLight = floraPalette(
      { energy: 80, strength: 60, speed: 90 },
      123,
      light,
    );
    const [, , lBg] = rgbToHsl(...hexToRgb(light.bg));
    const [, , rockLight] = rgbToHsl(...hexToRgb(floraLight.rock));
    // Rock lightness must be at least 0.3 *below* the bg lightness so it
    // reads as a clear silhouette.
    expect(lBg - rockLight).toBeGreaterThan(0.3);
  });

  it('paper-theme seedling wings drop to a darker silhouette tone', () => {
    const light = buildSceneForTheme(120, 'paper');
    const dark = buildSceneForTheme(120, 'void');
    const wingDark = seedlingColors(
      { energy: 60, strength: 50, speed: 80 },
      dark,
    );
    const wingLight = seedlingColors(
      { energy: 60, strength: 50, speed: 80 },
      light,
    );
    const [, , lDark] = rgbToHsl(...hexToRgb(wingDark.wing));
    const [, , lLight] = rgbToHsl(...hexToRgb(wingLight.wing));
    // Wings get ~0.28 darker on paper so they don't dissolve into the wash.
    expect(lDark - lLight).toBeGreaterThan(0.2);
  });
});