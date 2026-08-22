import { describe, expect, it } from 'vitest';
import {
  buildAdultTree,
  coreSeekingStrokes,
  growTree,
  POCKET_SEEK_MAX,
  POCKET_SEEK_REACH,
  soilFor,
  type SoilContext,
} from '../../src/game/sim/lsystem';
import {
  POCKET_REGEN_PER_SEC,
  treeVisualScale,
  type ResourcePocket,
} from '../../src/game/sim/types';
import {
  addAsteroid,
  computeRootIntake,
  createEmptyWorld,
  plantPose,
  pocketDrainRates,
  tick,
} from '../../src/game/sim/world';

function pocket(
  id: number,
  kind: ResourcePocket['kind'],
  angle: number,
  radiusT: number,
  amount = 14,
): ResourcePocket {
  return {
    id,
    kind,
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

/** Tree geometry as the renderer and sim both build it, with soil. */
function grown(
  rock: ReturnType<typeof addAsteroid>,
  treeSeed: number,
  maturity = 1,
  soil?: SoilContext,
) {
  const scale = treeVisualScale(rock.radius, rock.seed);
  const pose = plantPose(rock, 0);
  const adult = buildAdultTree(
    treeSeed,
    scale,
    pose.dist,
    pose.surfaceY,
    'dyson',
    soil ?? soilFor(rock, pose),
  );
  return { adult, geom: growTree(adult, maturity), pose, scale };
}

/** Root-stroke tips in tree-local space. */
function tipsOf(geom: ReturnType<typeof grown>['geom']) {
  return coreSeekingStrokes(geom)
    .map((s) => s.points[s.points.length - 1])
    .filter((p): p is { x: number; y: number } => p !== undefined);
}

function rockWith(pockets: ResourcePocket[], seed = 21) {
  const world = createEmptyWorld(seed);
  const rock = addAsteroid(world, {
    x: 0,
    y: 0,
    travelRadius: 400,
    pockets,
  });
  return { world, rock };
}

describe('soilFor', () => {
  it('puts the rock centre at (0, pose.dist) in the tree frame', () => {
    // A pocket at the exact centre must land on the tree-local core well,
    // which is the anchor the whole burrowing geometry is built around.
    const { rock } = rockWith([pocket(0, 'mineral', 0, 0)]);
    const pose = plantPose(rock, 0);
    const soil = soilFor(rock, pose);
    expect(soil.pockets[0]!.x).toBeCloseTo(0, 6);
    expect(soil.pockets[0]!.y).toBeCloseTo(pose.dist, 6);
    expect(soil.rockRadius).toBe(rock.radius);
  });

  it('round-trips a pocket bearing back to its world position', () => {
    const { rock } = rockWith([pocket(0, 'water', 2.1, 0.6)]);
    const pose = plantPose(rock, 0);
    const local = soilFor(rock, pose).pockets[0]!;
    // Rotate back out of the tree frame and re-add the collar offset.
    const rot = pose.angle + Math.PI / 2;
    const wx = pose.x + local.x * Math.cos(rot) - local.y * Math.sin(rot);
    const wy = pose.y + local.x * Math.sin(rot) + local.y * Math.cos(rot);
    expect(wx).toBeCloseTo(Math.cos(2.1) * 0.6 * rock.radius, 4);
    expect(wy).toBeCloseTo(Math.sin(2.1) * 0.6 * rock.radius, 4);
  });
});

describe('burrowing pocket seekers', () => {
  it('grows a root that ends exactly on a reachable pocket', () => {
    // Opposite the default slot bearing (-PI/2) and halfway to the crust:
    // far enough that the plain nervous roots never come near it.
    const p = pocket(0, 'mineral', Math.PI / 2, 0.55);
    const { rock } = rockWith([p]);
    const pose = plantPose(rock, 0);
    const target = soilFor(rock, pose).pockets[0]!;

    const withSoil = tipsOf(grown(rock, 4242).geom);
    const bare = tipsOf(
      grown(rock, 4242, 1, { pockets: [], rockRadius: rock.radius }).geom,
    );

    const nearest = (tips: { x: number; y: number }[]) =>
      Math.min(...tips.map((t) => Math.hypot(t.x - target.x, t.y - target.y)));

    expect(withSoil.length).toBeGreaterThan(bare.length);
    expect(nearest(withSoil)).toBeCloseTo(0, 6);
    expect(nearest(bare)).toBeGreaterThan(1);
  });

  it('stays inside the rock while crossing the disc', () => {
    const { rock } = rockWith([pocket(0, 'energy', Math.PI / 2, 0.7)]);
    const pose = plantPose(rock, 0);
    const { adult } = grown(rock, 77);
    for (const stroke of coreSeekingStrokes(adult)) {
      for (const pt of stroke.points) {
        // Rock centre is (0, pose.dist) in the tree frame.
        const d = Math.hypot(pt.x, pt.y - pose.dist);
        expect(d).toBeLessThanOrEqual(rock.radius * 1.001);
      }
    }
  });

  it('ignores a pocket beyond burrowing reach', () => {
    // Placed past the crust on the far side: inside no rock, so unreachable
    // no matter how the anchor falls.
    const far = pocket(0, 'mineral', Math.PI / 2, 1.4);
    const { rock } = rockWith([far]);
    const withFar = coreSeekingStrokes(grown(rock, 9).adult).length;
    const bare = coreSeekingStrokes(
      grown(rock, 9, 1, { pockets: [], rockRadius: rock.radius }).adult,
    ).length;
    expect(withFar).toBe(bare);
    expect(computeRootIntake(rock, 9, 0, 'dyson')).toEqual({
      mineral: 0,
      water: 0,
      energy: 0,
    });
  });

  it('caps the number of tendrils per tree', () => {
    const many: ResourcePocket[] = [];
    for (let i = 0; i < POCKET_SEEK_MAX + 6; i++) {
      many.push(pocket(i, 'mineral', (i / (POCKET_SEEK_MAX + 6)) * Math.PI * 2, 0.5));
    }
    const { rock } = rockWith(many);
    const withMany = coreSeekingStrokes(grown(rock, 31).adult).length;
    const bare = coreSeekingStrokes(
      grown(rock, 31, 1, { pockets: [], rockRadius: rock.radius }).adult,
    ).length;
    expect(withMany - bare).toBeLessThanOrEqual(POCKET_SEEK_MAX);
    expect(withMany - bare).toBeGreaterThan(0);
  });

  it('reaches the near pocket before the far one as the tree matures', () => {
    // Two pockets on the same bearing, one shallow and one across the core.
    const near = pocket(0, 'mineral', -Math.PI / 2, 0.55);
    const far = pocket(1, 'water', Math.PI / 2, 0.7);
    const { rock } = rockWith([near, far]);
    const pose = plantPose(rock, 0);
    const targets = soilFor(rock, pose).pockets;
    const nearT = targets[0]!;
    const farT = targets[1]!;

    const touches = (maturity: number, t: { x: number; y: number }) =>
      tipsOf(grown(rock, 555, maturity).geom).some(
        (tip) => Math.hypot(tip.x - t.x, tip.y - t.y) < 0.5,
      );

    expect(touches(1, nearT)).toBe(true);
    expect(touches(1, farT)).toBe(true);
    // A sapling has not finished burrowing to the far side yet.
    expect(touches(0.5, farT)).toBe(false);
  });

  it('keeps reach proportional to rock radius', () => {
    // The same bearing/radiusT on a bigger rock is a longer burrow, but the
    // reach budget scales with it, so reachability is radius-invariant.
    const angle = Math.PI / 2;
    for (const radius of [40, 90, 150]) {
      const world = createEmptyWorld(3);
      const rock = addAsteroid(world, {
        x: 0,
        y: 0,
        radius,
        travelRadius: 400,
        pockets: [pocket(0, 'mineral', angle, 0.6)],
      });
      const target = soilFor(rock, plantPose(rock, 0)).pockets[0]!;
      const hit = tipsOf(grown(rock, 8080).geom).some(
        (t) => Math.hypot(t.x - target.x, t.y - target.y) < 0.5,
      );
      expect(hit, `radius ${radius}`).toBe(true);
    }
    expect(POCKET_SEEK_REACH).toBeGreaterThan(1);
  });
});

describe('extraction equilibrium', () => {
  it('leaves a tapped pocket holding reserves instead of pinned at zero', () => {
    // The whole point of the survey panel is that reserves are readable.
    // A connected root draws a share of what is left, so drain falls as the
    // pocket empties and meets regen partway down.
    const { world, rock } = rockWith([pocket(0, 'mineral', Math.PI / 2, 0.55)]);
    world.trees.set(1, {
      id: 1,
      asteroidId: rock.id,
      slotIndex: 0,
      kind: 'dyson',
      seed: 4242,
      maturity: 1,
      faction: 'player',
      spawnAccumulator: 0,
      coreFeed: 1,
    });
    // Two minutes: far past the ~1 s it would take at the unscaled rate.
    for (let i = 0; i < 60 * 120; i++) tick(world, 1 / 60);

    const held = rock.pockets[0]!.amount;
    expect(held).toBeGreaterThan(1);
    expect(held).toBeLessThan(rock.pockets[0]!.maxAmount);
    // Settled, not still sliding.
    const before = held;
    for (let i = 0; i < 60 * 30; i++) tick(world, 1 / 60);
    expect(Math.abs(rock.pockets[0]!.amount - before)).toBeLessThan(0.5);
  });

  it('drives the equilibrium down as more trees tap the same pocket', () => {
    const settle = (treeCount: number): number => {
      const { world, rock } = rockWith([pocket(0, 'mineral', Math.PI / 2, 0.55)]);
      for (let i = 0; i < treeCount; i++) {
        world.trees.set(i + 1, {
          id: i + 1,
          asteroidId: rock.id,
          slotIndex: i,
          kind: 'dyson',
          seed: 4242 + i,
          maturity: 1,
          faction: 'player',
          spawnAccumulator: 0,
          coreFeed: 1,
        });
      }
      for (let j = 0; j < 60 * 120; j++) tick(world, 1 / 60);
      return rock.pockets[0]!.amount;
    };
    expect(settle(3)).toBeLessThan(settle(1));
  });
});

describe('pocketDrainRates', () => {
  it('is empty before any tree has been ticked', () => {
    const { world, rock } = rockWith([pocket(0, 'mineral', Math.PI / 2, 0.55)]);
    world.trees.set(1, {
      id: 1,
      asteroidId: rock.id,
      slotIndex: 0,
      kind: 'dyson',
      seed: 4242,
      maturity: 1,
      faction: 'player',
      spawnAccumulator: 0,
      coreFeed: 1,
    });
    expect(pocketDrainRates(world, rock.id).size).toBe(0);
  });

  it('reports the pocket a burrowed root actually reached', () => {
    const { world, rock } = rockWith([
      pocket(0, 'mineral', Math.PI / 2, 0.55),
      // Outside the rock: no root can burrow to it, so it never drains.
      pocket(1, 'water', Math.PI / 2, 1.4),
    ]);
    world.trees.set(1, {
      id: 1,
      asteroidId: rock.id,
      slotIndex: 0,
      kind: 'dyson',
      seed: 4242,
      maturity: 1,
      faction: 'player',
      spawnAccumulator: 0,
      coreFeed: 1,
    });
    tick(world, 1 / 60);

    const drains = pocketDrainRates(world, rock.id);
    expect(drains.get(0)).toBeGreaterThan(0);
    expect(drains.get(1)).toBeUndefined();
  });

  it('returns an empty map for an unknown rock', () => {
    const { world } = rockWith([]);
    expect(pocketDrainRates(world, 9999).size).toBe(0);
  });
});
