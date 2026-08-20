import { afterEach, describe, expect, it } from 'vitest';
import {
  clampHudScale,
  FACTION_MARKS_STORAGE_KEY,
  GAME_VERSION,
  HUD_SCALE_STEPS,
  HUD_SCALE_STORAGE_KEY,
  MINIMAP_STORAGE_KEY,
  MUTE_STORAGE_KEY,
  nextHudScale,
  readFactionMarks,
  readHudScale,
  readMinimap,
  readMuted,
  readReducedMotion,
  readScreenFlash,
  REDUCED_MOTION_STORAGE_KEY,
  SCREEN_FLASH_STORAGE_KEY,
  writeFactionMarks,
  writeHudScale,
  writeMinimap,
  writeMuted,
  writeReducedMotion,
  writeScreenFlash,
} from '../../src/game/hud/prefs';
import { withFakeStorage } from '../helpers/fakeStorage';

const memory = new Map<string, string>();

afterEach(() => {
  memory.clear();
});

describe('prefs', () => {
  it('ships version 0.1.0', () => {
    expect(GAME_VERSION).toBe('0.1.0');
  });

  it('round-trips mute and reduced motion when localStorage is available', () => {
    const store: Storage = {
      get length() {
        return memory.size;
      },
      clear() {
        memory.clear();
      },
      getItem(key: string) {
        return memory.has(key) ? memory.get(key)! : null;
      },
      key(index: number) {
        return [...memory.keys()][index] ?? null;
      },
      removeItem(key: string) {
        memory.delete(key);
      },
      setItem(key: string, value: string) {
        memory.set(key, String(value));
      },
    };

    const prev = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: store,
    });

    try {
      expect(readMuted()).toBe(false);
      writeMuted(true);
      expect(readMuted()).toBe(true);
      expect(memory.get(MUTE_STORAGE_KEY)).toBe('1');
      writeMuted(false);
      expect(readMuted()).toBe(false);

      expect(readReducedMotion()).toBe(false);
      writeReducedMotion(true);
      expect(readReducedMotion()).toBe(true);
      expect(memory.get(REDUCED_MOTION_STORAGE_KEY)).toBe('1');
      writeReducedMotion(false);
      expect(readReducedMotion()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: prev,
      });
    }
  });
});

describe('hud scale ladder', () => {
  it('never drops below 1x, so coarse-pointer minimums still hold', () => {
    expect(Math.min(...HUD_SCALE_STEPS)).toBe(1);
  });

  it('snaps arbitrary values onto the nearest step', () => {
    expect(clampHudScale(1)).toBe(1);
    expect(clampHudScale(1.16)).toBe(1.15);
    expect(clampHudScale(1.29)).toBe(1.3);
    // Out of range in both directions, and outright garbage.
    expect(clampHudScale(0.2)).toBe(1);
    expect(clampHudScale(99)).toBe(1.5);
    expect(clampHudScale(Number.NaN)).toBe(1);
  });

  it('cycles the ladder and wraps back to 1x', () => {
    let scale = HUD_SCALE_STEPS[0]!;
    const seen: number[] = [scale];
    for (let i = 0; i < HUD_SCALE_STEPS.length - 1; i++) {
      scale = nextHudScale(scale);
      seen.push(scale);
    }
    expect(seen).toEqual([...HUD_SCALE_STEPS]);
    expect(nextHudScale(scale)).toBe(HUD_SCALE_STEPS[0]);
  });
});

describe('accessibility prefs', () => {
  it('defaults screen flash and minimap on, faction marks off', () => {
    withFakeStorage(() => {
      // Nothing written yet — these are the shipped defaults, and screen flash
      // proves the fallback path works for a pref that is not off-by-default.
      expect(readScreenFlash()).toBe(true);
      expect(readMinimap()).toBe(true);
      expect(readFactionMarks()).toBe(false);
      expect(readHudScale()).toBe(1);
    });
  });

  it('round-trips every accessibility pref', () => {
    withFakeStorage(({ memory }) => {
      writeScreenFlash(false);
      expect(readScreenFlash()).toBe(false);
      expect(memory.get(SCREEN_FLASH_STORAGE_KEY)).toBe('0');
      writeScreenFlash(true);
      expect(readScreenFlash()).toBe(true);

      writeFactionMarks(true);
      expect(readFactionMarks()).toBe(true);
      expect(memory.get(FACTION_MARKS_STORAGE_KEY)).toBe('1');

      writeMinimap(false);
      expect(readMinimap()).toBe(false);
      expect(memory.get(MINIMAP_STORAGE_KEY)).toBe('0');

      writeHudScale(1.3);
      expect(readHudScale()).toBe(1.3);
      expect(memory.get(HUD_SCALE_STORAGE_KEY)).toBe('1.3');
    });
  });

  it('snaps an off-ladder stored scale instead of trusting it', () => {
    withFakeStorage(({ memory }) => {
      memory.set(HUD_SCALE_STORAGE_KEY, '7');
      expect(readHudScale()).toBe(1.5);
      memory.set(HUD_SCALE_STORAGE_KEY, 'wide');
      expect(readHudScale()).toBe(1);
    });
  });

  it('leaves the shipped keys untouched', () => {
    // Phase 7 must not disturb existing persistence.
    expect(MUTE_STORAGE_KEY).toBe('asterbloom.mute.v1');
    expect(REDUCED_MOTION_STORAGE_KEY).toBe('asterbloom.reducedMotion.v1');
  });
});
