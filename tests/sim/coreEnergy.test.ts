import { describe, expect, it } from 'vitest';
import {
  DIET_GROWTH_RATE,
  DYSON_GROWTH_SECONDS,
  POCKET_REGEN_PER_SEC,
  ROOT_FEED_GROWTH_BONUS,
  type ResourcePocket,
  type Tree,
} from '../../src/game/sim/types';
import {
  addAsteroid,
  createEmptyWorld,
  tick,
} from '../../src/game/sim/world';

function mineralPocket(angle: number, radiusT: number, amount = 14): ResourcePocket {
  return {
    id: 0,
    kind: 'mineral',
    amount,
    maxAmount: amount,
    angle,
    radiusT,
    depthT: 0.1,
    regenPerSec: POCKET_REGEN_PER_SEC,
    depletedAt: null,
    phase: 0,
  };
}

function treeFixture(coreEnergy: number, maxCoreEnergy: number) {
  const world = createEmptyWorld(9);
  const rock = addAsteroid(world, {
    x: 0,
    y: 0,
    travelRadius: 200,
    coreEnergy,
    maxCoreEnergy,
    pockets: [mineralPocket(0, 0.5)],
  });
  const tree: Tree = {
    id: 1,
    asteroidId: rock.id,
    slotIndex: 0,
    kind: 'dyson',
    seed: 42,
    maturity: 0,
    faction: 'player',
    spawnAccumulator: 0,
    coreFeed: 0.5,
  };
  world.trees.set(tree.id, tree);
  return { world, rock, tree };
}

describe('coreEnergy reservoir', () => {
  it('clamps coreEnergy to [0, maxCoreEnergy]', () => {
    const { world, rock } = treeFixture(0, 20);
    // Starved with a near pocket: intake pulls it up, drain + clamp keep
    // it inside bounds.
    for (let i = 0; i < 60 * 30; i++) tick(world, 1 / 60);
    expect(rock.coreEnergy).toBeGreaterThanOrEqual(0);
    expect(rock.coreEnergy).toBeLessThanOrEqual(rock.maxCoreEnergy);

    // Overflow guard: a full reservoir never exceeds its max.
    rock.coreEnergy = rock.maxCoreEnergy;
    for (let i = 0; i < 60 * 30; i++) tick(world, 1 / 60);
    expect(rock.coreEnergy).toBeLessThanOrEqual(rock.maxCoreEnergy);
  });

  it('adds a fed maturity boost only while the reservoir is above threshold', () => {
    const fed = treeFixture(100, 100);
    const starved = treeFixture(0, 100);
    // Keep the starved rock's pockets empty so its coreEnergy never climbs.
    starved.rock.pockets = [];
    for (let i = 0; i < 60; i++) {
      tick(fed.world, 1 / 60);
      tick(starved.world, 1 / 60);
    }
    const base = (1 / DYSON_GROWTH_SECONDS) * 1;
    // Starved tree grows at exactly the base rate.
    expect(starved.tree.maturity).toBeCloseTo(base, 5);
    // Fed tree grows faster thanks to the reservoir bonus; the dietary
    // bias loop may add a small extra (magnitude <= DIET_GROWTH_RATE) so
    // we leave headroom instead of asserting the legacy upper bound.
    expect(fed.tree.maturity).toBeGreaterThan(starved.tree.maturity);
    expect(fed.tree.maturity).toBeLessThanOrEqual(
      base + ROOT_FEED_GROWTH_BONUS * 1 + DIET_GROWTH_RATE + 1e-6,
    );
  });

  it('keeps the baked coreFeed while rootIntake is cached each tick', () => {
    const { world, rock, tree } = treeFixture(50, 100);
    const baked = tree.coreFeed;
    for (let i = 0; i < 60; i++) tick(world, 1 / 60);
    expect(tree.coreFeed).toBe(baked);
    expect(tree.rootIntake).toBeDefined();
    expect(rock.coreEnergy).toBeGreaterThanOrEqual(0);
  });
});
