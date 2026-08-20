import { beforeAll, describe, expect, it } from 'vitest';
import { tickAi } from '../../src/game/sim/ai';
import { createSkirmishWorld } from '../../src/game/sim/layout';
import {
  deserializeWorld,
  serializeWorld,
  worldDigest,
  WORLD_SCHEMA_VERSION,
  type WorldSnapshot,
} from '../../src/game/sim/serialize';
import { SIM_DT, type World } from '../../src/game/sim/types';
import { tick } from '../../src/game/sim/world';

/**
 * Resume has to land the player back in the match they left. The snapshot is
 * the whole contract: anything `World` carries that the format drops is state
 * that silently resets on load, and the sim is not going to complain about it.
 *
 * The sharpest edge is `Tree.dietaryBias`. `tickTrees` assigns it only while
 * `maturity < 1`, but `pickSeedlingKind` and `seedStatsFromDiet` read it for
 * the whole match — so a mature tree's bias is write-once state, not a cache,
 * and dropping it would change what every established grove spawns.
 */

const SEED = 0xc0a1f00d;

function step(world: World, steps: number): void {
  for (let i = 0; i < steps; i++) {
    tick(world, SIM_DT);
    tickAi(world, SIM_DT);
  }
}

/** A world far enough in to have trees, travellers, combat and pending plants. */
function matureWorld(steps = 600): World {
  const world = createSkirmishWorld(SEED);
  step(world, steps);
  return world;
}

describe('world snapshots', () => {
  let world: World;
  let snap: WorldSnapshot;

  beforeAll(() => {
    world = matureWorld();
    snap = serializeWorld(world);
  });

  it('reaches a state worth saving', () => {
    // Guards the fixture itself: a snapshot of an empty world proves nothing.
    expect(world.asteroids.size).toBeGreaterThan(10);
    expect(world.trees.size).toBeGreaterThan(0);
    expect(world.seedlings.size).toBeGreaterThan(0);
  });

  it('round-trips to byte-identical JSON', () => {
    // Exact string equality: any dropped, renamed, or reordered field shows up
    // here, without the spec having to enumerate the schema by hand.
    const again = serializeWorld(deserializeWorld(snap));
    expect(JSON.stringify(again)).toBe(JSON.stringify(snap));
  });

  it('survives a real JSON trip, so nothing exotic leaked into the format', () => {
    const parsed = JSON.parse(JSON.stringify(snap)) as WorldSnapshot;
    const restored = deserializeWorld(parsed);
    expect(worldDigest(restored)).toBe(worldDigest(world));
  });

  it('preserves every entity and its identity', () => {
    const restored = deserializeWorld(snap);
    expect(restored.asteroids.size).toBe(world.asteroids.size);
    expect(restored.trees.size).toBe(world.trees.size);
    expect(restored.seedlings.size).toBe(world.seedlings.size);
    expect(restored.pendingPlants.size).toBe(world.pendingPlants.size);
    expect([...restored.seedlings.keys()]).toEqual([...world.seedlings.keys()]);
    expect([...restored.asteroids.keys()]).toEqual([
      ...world.asteroids.keys(),
    ]);
  });

  it('preserves allocation order, which the spawn RNG depends on', () => {
    // spawnSeedling mixes world.nextId into its seed, so the order entities
    // were created in is part of the simulation's identity.
    const restored = deserializeWorld(snap);
    expect(restored.nextId).toBe(world.nextId);
    expect([...restored.trees.keys()]).toEqual([...world.trees.keys()]);
  });

  it('preserves world-level bookkeeping', () => {
    const restored = deserializeWorld(snap);
    expect(restored.seed).toBe(world.seed);
    expect(restored.difficulty).toBe(world.difficulty);
    expect(restored.aiHomeId).toBe(world.aiHomeId);
    expect(restored.time).toBeCloseTo(world.time, 3);
    // aiAcc decides when the AI next thinks; losing it would hand the player
    // or the AI a free think on load.
    expect(restored.aiAcc).toBeCloseTo(world.aiAcc, 3);
  });

  it('preserves rock ownership and reservoirs', () => {
    const restored = deserializeWorld(snap);
    for (const [id, a] of world.asteroids) {
      const b = restored.asteroids.get(id)!;
      expect(b.owner).toBe(a.owner);
      expect(b.coreEnergy).toBeCloseTo(a.coreEnergy, 3);
      expect(b.energyPool).toBeCloseTo(a.energyPool, 3);
      expect(b.shield).toBeCloseTo(a.shield, 3);
      expect(b.burnTimer).toBeCloseTo(a.burnTimer, 3);
      expect(b.pockets.length).toBe(a.pockets.length);
    }
  });

  it('preserves in-flight seedling routing', () => {
    const restored = deserializeWorld(snap);
    for (const [id, s] of world.seedlings) {
      const t = restored.seedlings.get(id)!;
      expect(t.state).toBe(s.state);
      expect(t.faction).toBe(s.faction);
      expect(t.kind).toBe(s.kind);
      expect(t.path).toEqual(s.path);
      expect(t.pathIndex).toBe(s.pathIndex);
      expect(t.plantId).toBe(s.plantId);
    }
  });

  it('does not alias the live world', () => {
    const restored = deserializeWorld(snap);
    const [id, original] = [...world.seedlings.entries()][0]!;
    const copy = restored.seedlings.get(id)!;
    expect(copy).not.toBe(original);
    if (original.path) expect(copy.path).not.toBe(original.path);
  });
});

describe('tree caches', () => {
  it('omits only what the sim rebuilds for itself', () => {
    const world = matureWorld();
    const restored = deserializeWorld(serializeWorld(world));
    for (const tree of restored.trees.values()) {
      expect(tree.rootTips).toBeUndefined();
      expect(tree.rootIntake).toBeUndefined();
    }
    // One tick is enough for tickCoreEnergy to rebuild both.
    tick(restored, SIM_DT);
    for (const tree of restored.trees.values()) {
      expect(tree.rootTips).toBeDefined();
      expect(tree.rootIntake).toBeDefined();
    }
  });

  it('persists dietaryBias on mature trees, which no tick would restore', () => {
    // Growth runs 32-38 s of sim time, so maturity needs ~2000 steps.
    const world = matureWorld(2000);
    const mature = [...world.trees.values()].filter((t) => t.maturity >= 1);
    // If this fixture stops producing mature trees the guard below is vacuous.
    expect(mature.length).toBeGreaterThan(0);
    const withBias = mature.filter((t) => t.dietaryBias !== undefined);
    expect(withBias.length).toBeGreaterThan(0);

    const restored = deserializeWorld(serializeWorld(world));
    for (const t of withBias) {
      const b = restored.trees.get(t.id)!;
      expect(b.dietaryBias).toBeDefined();
      expect(b.dietaryBias!.mineral).toBeCloseTo(t.dietaryBias!.mineral, 3);
      expect(b.dietaryBias!.water).toBeCloseTo(t.dietaryBias!.water, 3);
      expect(b.dietaryBias!.energy).toBeCloseTo(t.dietaryBias!.energy, 3);
    }

    // And it stays put: a mature tree never re-enters the assigning branch.
    tick(restored, SIM_DT);
    for (const t of withBias) {
      const b = restored.trees.get(t.id)!;
      expect(b.dietaryBias!.mineral).toBeCloseTo(t.dietaryBias!.mineral, 3);
    }
  });
});

describe('resumed worlds simulate deterministically', () => {
  it('two loads of one snapshot stay identical for 300 steps', () => {
    // The property resume actually needs: the restored world is a complete
    // simulation input, with no hidden state left behind in the original.
    const snap = serializeWorld(matureWorld());
    const a = deserializeWorld(snap);
    const b = deserializeWorld(snap);
    expect(worldDigest(a)).toBe(worldDigest(b));
    step(a, 300);
    step(b, 300);
    expect(worldDigest(a)).toBe(worldDigest(b));
  });

  it('keeps playing the same match the player left', () => {
    // Saving rounds floats, so a resumed match is not bit-identical to one
    // that never stopped. What must hold is that it is still the same match:
    // same rocks, same owners, comparable populations.
    const world = matureWorld();
    const restored = deserializeWorld(serializeWorld(world));
    step(world, 300);
    step(restored, 300);

    expect(restored.asteroids.size).toBe(world.asteroids.size);
    for (const [id, a] of world.asteroids) {
      expect(restored.asteroids.get(id)!.owner).toBe(a.owner);
    }
    expect(restored.trees.size).toBe(world.trees.size);
    const drift = Math.abs(restored.seedlings.size - world.seedlings.size);
    expect(drift).toBeLessThanOrEqual(world.seedlings.size * 0.1);
  });
});

describe('schema guards', () => {
  it('stamps the current version', () => {
    expect(serializeWorld(createSkirmishWorld(SEED)).v).toBe(
      WORLD_SCHEMA_VERSION,
    );
  });

  it('refuses a snapshot from another schema', () => {
    const snap = serializeWorld(createSkirmishWorld(SEED));
    expect(() =>
      deserializeWorld({ ...snap, v: WORLD_SCHEMA_VERSION + 1 }),
    ).toThrow();
  });

  it('refuses a malformed payload rather than building half a world', () => {
    expect(() => deserializeWorld(null as unknown as WorldSnapshot)).toThrow();
    const snap = serializeWorld(createSkirmishWorld(SEED));
    expect(() =>
      deserializeWorld({
        ...snap,
        seedlings: undefined as unknown as WorldSnapshot['seedlings'],
      }),
    ).toThrow();
  });
});

describe('worldDigest', () => {
  it('is stable for one world and differs after the sim moves', () => {
    const world = matureWorld(120);
    const before = worldDigest(world);
    expect(worldDigest(world)).toBe(before);
    step(world, 60);
    expect(worldDigest(world)).not.toBe(before);
  });

  it('separates worlds grown from different seeds', () => {
    const a = createSkirmishWorld(SEED);
    const b = createSkirmishWorld(0x12345678);
    expect(worldDigest(a)).not.toBe(worldDigest(b));
  });
});
