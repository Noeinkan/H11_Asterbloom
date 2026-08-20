import { describe, expect, it } from 'vitest';
import { GAME_VERSION } from '../../src/game/hud/prefs';
import {
  clearSave,
  decodeSession,
  encodeSession,
  hasSave,
  readSave,
  SAVE_SCHEMA_VERSION,
  SAVE_STORAGE_KEY,
  writeSave,
  type SessionSnapshot,
} from '../../src/game/hud/saveStore';
import { createSkirmishWorld } from '../../src/game/sim/layout';
import { serializeWorld } from '../../src/game/sim/serialize';
import { createFakeStorage, withFakeStorage } from '../helpers/fakeStorage';

/**
 * The save slot is the one place a bad payload can reach the game as if it
 * were real state. Everything here is about refusing that: a save from
 * another build, a truncated string, a hand-edited object. The answer is
 * always the same — return null and let the player start fresh.
 */

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    schema: SAVE_SCHEMA_VERSION,
    version: GAME_VERSION,
    savedAt: 1_700_000_000_000,
    mode: 'skirmish',
    seed: 0xc0a1f00d,
    difficulty: 'normal',
    campaignIndex: 0,
    campaignTitle: '',
    matchConfig: { win: { kind: 'eliminate' } },
    holdAcc: 0,
    world: serializeWorld(createSkirmishWorld(0xc0a1f00d)),
    camera: { x: -120.5, y: 64.25, zoom: 0.85 },
    view: {
      selectedAsteroidId: 3,
      sendCount: 12,
      sendMode: 'precise',
      plantKind: 'energy',
    },
    followSend: true,
    palTime: 42.5,
    ...over,
  };
}

describe('session encode / decode', () => {
  it('round-trips every field', () => {
    const s = snapshot();
    const back = decodeSession(encodeSession(s))!;
    expect(back).not.toBeNull();
    expect(JSON.stringify(back)).toBe(JSON.stringify(s));
  });

  it('keeps the pieces resume actually needs', () => {
    const back = decodeSession(encodeSession(snapshot()))!;
    expect(back.camera.zoom).toBe(0.85);
    expect(back.view.sendMode).toBe('precise');
    expect(back.view.plantKind).toBe('energy');
    expect(back.followSend).toBe(true);
    // Without palTime the sky snaps to a new colour on resume.
    expect(back.palTime).toBe(42.5);
    expect(back.world.asteroids.length).toBeGreaterThan(0);
  });

  it('carries campaign identity for a campaign save', () => {
    const back = decodeSession(
      encodeSession(
        snapshot({ mode: 'campaign', campaignIndex: 4, campaignTitle: 'Grove' }),
      ),
    )!;
    expect(back.mode).toBe('campaign');
    expect(back.campaignIndex).toBe(4);
    expect(back.campaignTitle).toBe('Grove');
  });

  it('carries a non-default win rule and its progress', () => {
    const back = decodeSession(
      encodeSession(
        snapshot({
          matchConfig: { win: { kind: 'hold', rocks: 6, seconds: 45 } },
          holdAcc: 12.5,
        }),
      ),
    )!;
    expect(back.matchConfig.win).toEqual({
      kind: 'hold',
      rocks: 6,
      seconds: 45,
    });
    expect(back.holdAcc).toBe(12.5);
  });
});

describe('decode rejects anything it cannot trust', () => {
  it('rejects garbage', () => {
    expect(decodeSession('')).toBeNull();
    expect(decodeSession('nope')).toBeNull();
    expect(decodeSession('{')).toBeNull();
    expect(decodeSession('null')).toBeNull();
    expect(decodeSession('[]')).toBeNull();
    expect(decodeSession('{}')).toBeNull();
  });

  it('rejects another schema version', () => {
    const raw = encodeSession(snapshot());
    const bumped = JSON.parse(raw);
    bumped.schema = SAVE_SCHEMA_VERSION + 1;
    expect(decodeSession(JSON.stringify(bumped))).toBeNull();
  });

  it('rejects a save from a different build', () => {
    // Balance constants and world fields move between versions, so an old
    // payload is discarded rather than migrated on a guess.
    const raw = JSON.parse(encodeSession(snapshot()));
    raw.version = '0.0.9';
    expect(decodeSession(JSON.stringify(raw))).toBeNull();
  });

  it('rejects a payload with the world or mode missing', () => {
    for (const drop of ['world', 'matchConfig', 'camera', 'view'] as const) {
      const raw = JSON.parse(encodeSession(snapshot()));
      delete raw[drop];
      expect(decodeSession(JSON.stringify(raw))).toBeNull();
    }
    const badMode = JSON.parse(encodeSession(snapshot()));
    badMode.mode = 'sandbox';
    expect(decodeSession(JSON.stringify(badMode))).toBeNull();
  });

  it('fills sane defaults for soft fields rather than failing', () => {
    const raw = JSON.parse(encodeSession(snapshot()));
    delete raw.followSend;
    delete raw.palTime;
    delete raw.campaignTitle;
    raw.view.sendMode = undefined;
    const back = decodeSession(JSON.stringify(raw))!;
    expect(back).not.toBeNull();
    expect(back.followSend).toBe(false);
    expect(back.palTime).toBe(0);
    expect(back.campaignTitle).toBe('');
    expect(back.view.sendMode).toBe('all');
  });
});

describe('storage slot', () => {
  it('writes, reads back, and clears', () => {
    withFakeStorage(({ memory }) => {
      expect(readSave()).toBeNull();
      expect(hasSave()).toBe(false);

      expect(writeSave(snapshot())).toBe(true);
      expect(memory.has(SAVE_STORAGE_KEY)).toBe(true);
      expect(hasSave()).toBe(true);
      expect(readSave()!.seed).toBe(0xc0a1f00d);

      clearSave();
      expect(readSave()).toBeNull();
      expect(hasSave()).toBe(false);
    });
  });

  it('treats a corrupted slot as no save at all', () => {
    withFakeStorage(({ memory }) => {
      memory.set(SAVE_STORAGE_KEY, '{"schema":1,'); // truncated write
      expect(readSave()).toBeNull();
      expect(hasSave()).toBe(false);
    });
  });

  it('reports a failed write instead of throwing into the game loop', () => {
    const { storage } = createFakeStorage();
    const full: Storage = {
      ...storage,
      setItem() {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    const prev = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: full,
    });
    try {
      expect(writeSave(snapshot())).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: prev,
      });
    }
  });

  it('is a no-op without localStorage at all', () => {
    expect(readSave()).toBeNull();
    expect(writeSave(snapshot())).toBe(false);
    expect(() => clearSave()).not.toThrow();
  });

  it('does not collide with the existing pref keys', () => {
    expect(SAVE_STORAGE_KEY).toBe('asterbloom.save.v1');
  });
});
