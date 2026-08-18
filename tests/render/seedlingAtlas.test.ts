import { describe, expect, it } from 'vitest';
import {
  seedlingShape,
  seedlingShapeKey,
  seedlingVariant,
  VARIANTS,
} from '../../src/game/render/seedlingAtlas';
import type { FactionId, Seedling, SeedlingKind } from '../../src/game/sim/types';

/**
 * The atlas trades per-unit hull textures for shared ones, so its key is the
 * whole contract: units that collapse onto one key must be safe to draw with
 * one texture, and anything that changes the silhouette must change the key.
 *
 * The sharp edge is `paintSeedHull`'s two thresholds — `speed >= 170` adds a
 * second pair of fins, `strength >= 210` a second barb. Quantizing naively
 * would let a unit sitting on one of those flip textures every time the stat
 * jitters, so the key has to keep quantized stats on the original side.
 */

function unit(
  over: Partial<Pick<Seedling, 'id' | 'faction' | 'kind'>> & {
    energy?: number;
    strength?: number;
    speed?: number;
  } = {},
): Seedling {
  return {
    id: over.id ?? 1,
    faction: (over.faction ?? 'player') as FactionId,
    kind: (over.kind ?? 'basic') as SeedlingKind,
    stats: {
      energy: over.energy ?? 100,
      strength: over.strength ?? 100,
      speed: over.speed ?? 100,
    },
  } as Seedling;
}

const keyOf = (s: Seedling) => seedlingShapeKey(seedlingShape(s));

describe('seedlingShapeKey', () => {
  it('collapses stats inside one quantization bucket onto one key', () => {
    expect(keyOf(unit({ energy: 96 }))).toBe(keyOf(unit({ energy: 100 })));
  });

  it('separates stats far enough apart to change the hull', () => {
    expect(keyOf(unit({ energy: 40 }))).not.toBe(keyOf(unit({ energy: 180 })));
  });

  it('separates factions, which are tinted differently', () => {
    expect(keyOf(unit({ faction: 'player' }))).not.toBe(
      keyOf(unit({ faction: 'enemy' })),
    );
  });

  it('separates kinds, since sentinels are drawn larger', () => {
    expect(keyOf(unit({ kind: 'basic' }))).not.toBe(
      keyOf(unit({ kind: 'sentinel' })),
    );
  });

  it('separates jitter variants', () => {
    const a = unit({ id: 1 });
    const b = unit({ id: 2 });
    // Only meaningful if the two ids actually land in different buckets.
    expect(seedlingVariant(1)).not.toBe(seedlingVariant(2));
    expect(keyOf(a)).not.toBe(keyOf(b));
  });

  it('is stable for the same unit across calls', () => {
    expect(keyOf(unit({ id: 77, energy: 133 }))).toBe(
      keyOf(unit({ id: 77, energy: 133 })),
    );
  });
});

describe('silhouette thresholds', () => {
  it('keeps quantized speed on the same side of the extra-wings threshold', () => {
    for (let speed = 120; speed <= 220; speed++) {
      const q = seedlingShape(unit({ speed })).stats.speed;
      expect(q >= 170).toBe(speed >= 170);
    }
  });

  it('keeps quantized strength on the same side of the twin-barb threshold', () => {
    for (let strength = 160; strength <= 260; strength++) {
      const q = seedlingShape(unit({ strength })).stats.strength;
      expect(q >= 210).toBe(strength >= 210);
    }
  });

  it('splits the key across the extra-wings threshold', () => {
    expect(keyOf(unit({ speed: 169 }))).not.toBe(keyOf(unit({ speed: 171 })));
  });

  it('splits the key across the twin-barb threshold', () => {
    expect(keyOf(unit({ strength: 209 }))).not.toBe(
      keyOf(unit({ strength: 211 })),
    );
  });

  it('does not oscillate: one stat maps to exactly one quantized value', () => {
    for (let speed = 150; speed <= 200; speed++) {
      const a = seedlingShape(unit({ speed })).stats.speed;
      const b = seedlingShape(unit({ speed })).stats.speed;
      expect(a).toBe(b);
    }
  });
});

describe('seedlingVariant', () => {
  it('stays inside the bucket range for any id', () => {
    for (let id = 0; id < 500; id++) {
      const v = seedlingVariant(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(VARIANTS);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('collapses a whole field onto at most VARIANTS shapes', () => {
    const seen = new Set<number>();
    for (let id = 0; id < 500; id++) seen.add(seedlingVariant(id));
    expect(seen.size).toBeLessThanOrEqual(VARIANTS);
  });

  it('actually uses the whole range, so hulls do not all look alike', () => {
    const seen = new Set<number>();
    for (let id = 0; id < 500; id++) seen.add(seedlingVariant(id));
    expect(seen.size).toBe(VARIANTS);
  });
});
