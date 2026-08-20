import { afterEach, describe, expect, it } from 'vitest';
import {
  ambientMotion,
  deathMotesEnabled,
  DEFAULT_VISUAL_PREFS,
  getVisualPrefs,
  HIT_FLASH_MS,
  hitFlashMs,
  POCKET_FLASH_SECONDS,
  pocketFlashSeconds,
  resetVisualPrefs,
  setVisualPrefs,
  type VisualPrefs,
} from '../../src/game/render/visualPrefs';

afterEach(() => {
  resetVisualPrefs();
});

const prefs = (over: Partial<VisualPrefs> = {}): VisualPrefs => ({
  ...DEFAULT_VISUAL_PREFS,
  ...over,
});

describe('visual prefs channel', () => {
  it('ships flash on, motion on, marks off', () => {
    expect(DEFAULT_VISUAL_PREFS.screenFlash).toBe(true);
    expect(DEFAULT_VISUAL_PREFS.reducedMotion).toBe(false);
    expect(DEFAULT_VISUAL_PREFS.factionMarks).toBe(false);
  });

  it('merges partial updates instead of replacing the whole record', () => {
    setVisualPrefs({ factionMarks: true });
    expect(getVisualPrefs().factionMarks).toBe(true);
    expect(getVisualPrefs().screenFlash).toBe(true);

    setVisualPrefs({ screenFlash: false });
    expect(getVisualPrefs().factionMarks).toBe(true);
    expect(getVisualPrefs().screenFlash).toBe(false);
  });

  it('resets back to the shipped defaults', () => {
    setVisualPrefs({ screenFlash: false, reducedMotion: true });
    resetVisualPrefs();
    expect(getVisualPrefs()).toEqual(DEFAULT_VISUAL_PREFS);
  });
});

describe('visual pref resolvers', () => {
  it('zeroes flash durations when screen flash is off', () => {
    expect(hitFlashMs(prefs())).toBe(HIT_FLASH_MS);
    expect(pocketFlashSeconds(prefs())).toBe(POCKET_FLASH_SECONDS);

    const off = prefs({ screenFlash: false });
    expect(hitFlashMs(off)).toBe(0);
    expect(pocketFlashSeconds(off)).toBe(0);
  });

  it('collapses ambient sine amplitude under reduced motion', () => {
    expect(ambientMotion(prefs())).toBe(1);
    expect(ambientMotion(prefs({ reducedMotion: true }))).toBe(0);
  });

  it('drops death motes under reduced motion but not with flash off', () => {
    expect(deathMotesEnabled(prefs())).toBe(true);
    expect(deathMotesEnabled(prefs({ reducedMotion: true }))).toBe(false);
    // Motes are drift, not a brightness spike — screen flash must not gate them.
    expect(deathMotesEnabled(prefs({ screenFlash: false }))).toBe(true);
  });

  it('keeps flash and motion independent', () => {
    const flashOffMotionOn = prefs({ screenFlash: false });
    expect(hitFlashMs(flashOffMotionOn)).toBe(0);
    expect(ambientMotion(flashOffMotionOn)).toBe(1);

    const flashOnMotionOff = prefs({ reducedMotion: true });
    expect(hitFlashMs(flashOnMotionOff)).toBe(HIT_FLASH_MS);
    expect(ambientMotion(flashOnMotionOff)).toBe(0);
  });
});
