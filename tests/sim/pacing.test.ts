import { describe, expect, it } from 'vitest';
import { debugSpawnOrbiters } from '../../src/game/sim/commands';
import {
  LOCAL_SEEDLING_CAP,
  TREE_BURN_SECONDS,
} from '../../src/game/sim/types';
import {
  addAsteroid,
  allocId,
  countOrbitingSeedlings,
  createEmptyWorld,
  tick,
} from '../../src/game/sim/world';

function run(world: ReturnType<typeof createEmptyWorld>, seconds: number): void {
  const steps = Math.ceil(seconds * 60);
  for (let i = 0; i < steps; i++) tick(world, 1 / 60);
}

describe('pacing', () => {
  it('takes at least ~20s for one mature Dyson to fill the local cap', () => {
    const world = createEmptyWorld(200);
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      owner: 'player',
      minerals: 72,
      stats: { energy: 90, strength: 50, speed: 55 },
    });
    const treeId = allocId(world);
    world.trees.set(treeId, {
      id: treeId,
      asteroidId: rock.id,
      slotIndex: 0,
      kind: 'dyson',
      seed: 1,
      maturity: 1,
      faction: 'player',
      spawnAccumulator: 0,
      coreFeed: 0,
    });

    run(world, 19);
    expect(countOrbitingSeedlings(world, rock.id)).toBeLessThan(
      LOCAL_SEEDLING_CAP,
    );

    run(world, 90);
    expect(countOrbitingSeedlings(world, rock.id)).toBe(LOCAL_SEEDLING_CAP);
  });

  it('lets a mature Defense shield keep a small basic raid from wiping garrison', () => {
    const world = createEmptyWorld(201);
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      owner: 'player',
      minerals: 60,
      stats: { energy: 80, strength: 50, speed: 50 },
    });
    const treeId = allocId(world);
    world.trees.set(treeId, {
      id: treeId,
      asteroidId: rock.id,
      slotIndex: 0,
      kind: 'defense',
      seed: 2,
      maturity: 1,
      faction: 'player',
      spawnAccumulator: 0,
      coreFeed: 0,
    });
    // Let shields charge from energy pool.
    run(world, 3);
    expect(world.asteroids.get(rock.id)!.maxShield).toBeGreaterThan(0);
    expect(world.asteroids.get(rock.id)!.shield).toBeGreaterThan(0);

    debugSpawnOrbiters(world, rock.id, 'player', 6);
    debugSpawnOrbiters(world, rock.id, 'enemy', 5);
    run(world, 4);
    expect(countOrbitingSeedlings(world, rock.id, 'player')).toBeGreaterThan(0);
  });

  it('empties a burning grove without directly damaging the core reservoir', () => {
    const world = createEmptyWorld(202);
    const rock = addAsteroid(world, {
      x: 0,
      y: 0,
      travelRadius: 200,
      owner: 'enemy',
      coreEnergy: 100,
      maxCoreEnergy: 100,
      pockets: [],
    });
    const treeId = allocId(world);
    world.trees.set(treeId, {
      id: treeId,
      asteroidId: rock.id,
      slotIndex: 0,
      kind: 'dyson',
      seed: 3,
      maturity: 1,
      faction: 'enemy',
      spawnAccumulator: 0,
      coreFeed: 0,
    });
    debugSpawnOrbiters(world, rock.id, 'player', 16);
    const before = rock.coreEnergy;
    run(world, TREE_BURN_SECONDS + 1.5);
    expect(world.trees.size).toBe(0);
    // Siege removes trees; the reservoir is only touched by drain/intake
    // dynamics. With no pockets the only change is the per-tree drain, so
    // it never exceeds its max or drops below zero.
    const after = world.asteroids.get(rock.id)!.coreEnergy;
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThanOrEqual(rock.maxCoreEnergy);
    expect(after).toBeLessThanOrEqual(before);
  });
});
