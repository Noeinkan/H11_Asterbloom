import { describe, expect, it } from 'vitest';
import {
  buildAdultTree,
  buildLSystemSegments,
  buildTree,
  coreSeekingStrokes,
  FLOWER_POLLEN_OPEN,
  maturityStep,
  measureRootFeed,
  rootFeedActive,
  spawnReadiness,
  treeFlowersWorld,
} from '../../src/game/sim/lsystem';
import { mulberry32, range } from '../../src/game/sim/rng';
import { rockRadiusAt } from '../../src/game/sim/rock';
import {
  DYSON_GROWTH_SECONDS,
  LOCAL_SEEDLING_CAP,
  orbitBand,
  ROCK_RADIUS_DEFAULT,
  ROCK_RADIUS_MAX,
  ROCK_RADIUS_MIN,
  ROOT_FEED_REGEN,
  ROOT_FEED_SPAWN_BONUS,
  SPAWN_START_MATURITY,
  treeVisualScale,
} from '../../src/game/sim/types';
import {
  createSandboxWorld,
  plantPose,
  tick,
  treeRootRegen,
  treeSpawnInterval,
} from '../../src/game/sim/world';

describe('rng', () => {
  it('is deterministic for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('range stays within bounds', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = range(rng, 10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
    }
  });
});

describe('lsystem', () => {
  it('produces segments and steps maturity', () => {
    const segs = buildLSystemSegments(12345, 0.8, 1);
    expect(segs.length).toBeGreaterThan(0);
    expect(maturityStep(0.0)).toBe(0);
    expect(maturityStep(0.049)).toBe(0);
    expect(maturityStep(0.05)).toBe(1);
    expect(maturityStep(1)).toBe(20);
  });

  it('searches the core with branching roots from the collar', () => {
    const surfaceY = -15;
    const coreY = 70;
    const adult = buildAdultTree(99, 1, coreY, surfaceY);
    const inward = coreSeekingStrokes(adult);
    expect(inward.length).toBeGreaterThan(4);
    expect(inward.every((r) => r.kind === 'root')).toBe(true);
    const nearSurface = (pts: { x: number; y: number }[]) =>
      pts.some((p) => Math.abs(p.y - surfaceY) < 14 && Math.abs(p.x) < 22);
    expect(inward.some((r) => nearSurface(r.points))).toBe(true);
    expect(adult.strokes.some((s) => s.kind === 'wood')).toBe(true);
    expect(Math.abs(adult.collar.y - surfaceY)).toBeLessThan(8);

    let above = 0;
    let total = 0;
    for (const r of inward) {
      for (const p of r.points) {
        total++;
        if (p.y < surfaceY - 0.5) above++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(above / total).toBeLessThan(0.22);

    const tipNearCore = inward.some((r) => {
      const tip = r.points[r.points.length - 1];
      return tip != null && Math.hypot(tip.x, tip.y - coreY) < 28;
    });
    expect(tipNearCore).toBe(true);
  });

  it('measureRootFeed is deterministic and rewards near-core tips', () => {
    const coreY = 70;
    const a = buildAdultTree(42, 1, coreY, 0);
    const b = buildAdultTree(42, 1, coreY, 0);
    expect(measureRootFeed(a, coreY)).toBe(measureRootFeed(b, coreY));
    expect(measureRootFeed(a, coreY)).toBeGreaterThan(0.2);
    expect(rootFeedActive(0, 1)).toBe(0);
    expect(rootFeedActive(1, 1)).toBe(1);
    expect(rootFeedActive(0.4, 1)).toBeGreaterThan(0);
    expect(rootFeedActive(0.4, 1)).toBeLessThan(1);
  });

  it('reveals the same plant from the collar in both directions', () => {
    const coreY = 70;
    const surfaceY = 0;
    const early = buildTree(11, 0.22, 1, coreY, surfaceY);
    const mid = buildTree(11, 0.48, 1, coreY, surfaceY);
    const late = buildTree(11, 0.92, 1, coreY, surfaceY);
    expect(coreSeekingStrokes(early).length).toBeGreaterThan(0);
    const woodLen = (g: ReturnType<typeof buildTree>) =>
      g.strokes
        .filter((s) => s.kind === 'wood' || s.kind === 'twig')
        .reduce((n, s) => n + Math.max(0, s.points.length - 1), 0);
    expect(woodLen(early)).toBeLessThan(woodLen(mid));
    expect(woodLen(mid)).toBeLessThanOrEqual(woodLen(late) + 2);
    expect(late.flowers.length).toBeGreaterThan(early.flowers.length);
  });

  it('grows blooms larger than a flying seed hull', () => {
    for (const radius of [ROCK_RADIUS_MIN, ROCK_RADIUS_DEFAULT, ROCK_RADIUS_MAX]) {
      const scale = treeVisualScale(radius, 7);
      const adult = buildAdultTree(7, scale, 70, 0);
      expect(adult.flowers.length).toBeGreaterThan(0);
      const smallest = Math.min(...adult.flowers.map((f) => f.size));
      // seedlingView hull is ~3.6 world units; petals draw at ~size.
      expect(smallest).toBeGreaterThan(4);
    }
  });

  it('renders multiple blooms on an adult tree', () => {
    // Bloom readability contract: every adult tree must expose enough
    // flowers that the canopy reads as a flowering grove, not a few
    // isolated pods. Seed/structure changes that drop flowers below this
    // floor break the visual fix in treeView.drawBloom.
    const adult = buildAdultTree(20240816, 1, 70, -22);
    expect(adult.flowers.length).toBeGreaterThanOrEqual(3);
  });

  it('extends the same adult plant instead of swapping shapes', () => {
    const len = (geom: ReturnType<typeof buildTree>) => {
      let n = 0;
      for (const s of geom.strokes) {
        for (let i = 1; i < s.points.length; i++) {
          const a = s.points[i - 1]!;
          const b = s.points[i]!;
          n += Math.hypot(b.x - a.x, b.y - a.y);
        }
      }
      return n;
    };
    const sprout = buildTree(7, 0.12, 1, 70, 0);
    const young = buildTree(7, 0.35, 1, 70, 0);
    const mid = buildTree(7, 0.7, 1, 70, 0);
    const adult = buildTree(7, 1, 1, 70, 0);
    expect(coreSeekingStrokes(sprout).length).toBeGreaterThan(0);
    expect(len(sprout)).toBeLessThan(len(young));
    expect(len(young)).toBeLessThan(len(mid));
    expect(len(mid)).toBeLessThan(len(adult));
    expect(mid.strokes.some((s) => s.kind === 'grass')).toBe(true);
    expect(adult.strokes.some((s) => s.kind === 'grass')).toBe(true);
    expect(adult.flowers.length).toBeGreaterThan(sprout.flowers.length);
  });

  it('thickens trunk and roots with maturity, not only length', () => {
    const trunkW = (g: ReturnType<typeof buildTree>) =>
      g.strokes.find((s) => s.kind === 'wood')!.widthStart;
    const thickestRoot = (g: ReturnType<typeof buildTree>) =>
      Math.max(...coreSeekingStrokes(g).map((s) => s.widthStart));

    const sprout = buildTree(7, 0.12, 1, 70, 0);
    const mid = buildTree(7, 0.7, 1, 70, 0);
    const adultGeom = buildAdultTree(7, 1, 70, 0);
    const adult = buildTree(7, 1, 1, 70, 0);

    expect(trunkW(sprout)).toBeLessThan(trunkW(mid));
    expect(trunkW(mid)).toBeLessThan(trunkW(adult));
    expect(thickestRoot(sprout)).toBeLessThan(thickestRoot(mid));
    expect(thickestRoot(mid)).toBeLessThan(thickestRoot(adult));

    // Growing tip stays thinner than the established base.
    const partialWood = sprout.strokes.find((s) => s.kind === 'wood')!;
    expect(partialWood.widthEnd).toBeLessThan(partialWood.widthStart);

    // Full maturity matches the baked adult silhouette.
    expect(adult.strokes).toEqual(adultGeom.strokes);
    expect(adult.collar).toEqual(adultGeom.collar);
  });

  it('ramps spawn readiness only after side-branch tips', () => {
    expect(spawnReadiness(0, SPAWN_START_MATURITY)).toBe(0);
    expect(spawnReadiness(SPAWN_START_MATURITY - 0.01, SPAWN_START_MATURITY)).toBe(
      0,
    );
    expect(
      spawnReadiness(SPAWN_START_MATURITY, SPAWN_START_MATURITY),
    ).toBeCloseTo(0, 5);
    const mid = spawnReadiness(0.7, SPAWN_START_MATURITY);
    const adult = spawnReadiness(1, SPAWN_START_MATURITY);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(adult);
    expect(adult).toBeCloseTo(1, 5);
  });

  it('grows wood out of the crust and roots in from the same collar', () => {
    const surfaceY = -8;
    const adult = buildAdultTree(21, 1, 70, surfaceY);
    expect(adult.collar.y).toBe(surfaceY);
    expect(adult.surfaceY).toBe(surfaceY);
    const wood = adult.strokes.filter((s) => s.kind === 'wood' || s.kind === 'twig');
    expect(wood.length).toBeGreaterThan(0);
    for (const s of wood) {
      const tip = s.points[s.points.length - 1];
      expect(tip).toBeTruthy();
      expect(tip!.y).toBeLessThan(surfaceY + 2);
    }
    const roots = coreSeekingStrokes(adult);
    expect(roots.some((r) => Math.abs(r.points[0]!.y - surfaceY) < 3)).toBe(
      true,
    );
    expect(
      roots.every((r) => r.points.every((p) => p.y >= surfaceY - 1)),
    ).toBe(true    );
  });
});

function getSprout(
  world: ReturnType<typeof createSandboxWorld>,
): import('../../src/game/sim/types').Seedling | null {
  for (const s of world.seedlings.values()) {
    if (s.state === 'sprout') return s;
  }
  return null;
}

function findTreeForSeedling(
  world: ReturnType<typeof createSandboxWorld>,
  seedling: import('../../src/game/sim/types').Seedling,
): import('../../src/game/sim/types').Tree | null {
  for (const tree of world.trees.values()) {
    if (tree.asteroidId !== seedling.asteroidId) continue;
    if (tree.faction !== seedling.faction) continue;
    return tree;
  }
  return null;
}

describe('world sandbox', () => {
  it('grows the dyson tree over time', () => {
    const world = createSandboxWorld(99);
    const treeId = [...world.trees.keys()][0]!;
    expect(world.trees.get(treeId)!.maturity).toBe(0);
    for (let i = 0; i < 60; i++) tick(world, 1 / 60);
    expect(world.trees.get(treeId)!.maturity).toBeGreaterThan(0.015);
    for (let i = 0; i < 60 * 55; i++) tick(world, 1 / 60);
    expect(world.trees.get(treeId)!.maturity).toBe(1);
  });

  it('does not drop seedlings until branches emerge', () => {
    const world = createSandboxWorld(201);
    const treeId = [...world.trees.keys()][0]!;
    // Stop short of the spawn gate so the dietary bias loop (which adds
    // ~DIET_GROWTH_RATE per second on top of the base rate) cannot push
    // maturity across SPAWN_START_MATURITY during the pre-gate phase.
    const preGateSec = DYSON_GROWTH_SECONDS * SPAWN_START_MATURITY * 0.8;
    for (let i = 0; i < 60 * preGateSec; i++) tick(world, 1 / 60);
    const maturity = world.trees.get(treeId)!.maturity;
    expect(maturity).toBeLessThan(SPAWN_START_MATURITY);
    expect(world.seedlings.size).toBe(0);
    expect(world.trees.get(treeId)!.spawnAccumulator).toBe(0);

    for (let i = 0; i < 60 * 20 && world.seedlings.size === 0; i++) {
      tick(world, 1 / 60);
    }
    expect(world.trees.get(treeId)!.maturity).toBeGreaterThanOrEqual(
      SPAWN_START_MATURITY,
    );
    expect(world.seedlings.size).toBeGreaterThan(0);
  });

  it('spawns faster when adult than just past the gate', () => {
    const juvenile = spawnReadiness(
      SPAWN_START_MATURITY + 0.05,
      SPAWN_START_MATURITY,
    );
    const adult = spawnReadiness(1, SPAWN_START_MATURITY);
    expect(adult).toBeGreaterThan(juvenile * 2);
  });

  it('shortens spawn interval and raises regen when roots feed', () => {
    const world = createSandboxWorld(99);
    const asteroid = [...world.asteroids.values()][0]!;
    const tree = [...world.trees.values()][0]!;
    tree.maturity = 1;
    tree.coreFeed = 0;
    const hungry = treeSpawnInterval(tree, asteroid);
    const hungryRegen = treeRootRegen(tree);
    tree.coreFeed = 1;
    const fed = treeSpawnInterval(tree, asteroid);
    const fedRegen = treeRootRegen(tree);
    expect(fed).toBeLessThan(hungry);
    expect(fed / hungry).toBeCloseTo(1 / (1 + ROOT_FEED_SPAWN_BONUS), 5);
    expect(hungryRegen).toBe(0);
    expect(fedRegen).toBeCloseTo(ROOT_FEED_REGEN, 5);
  });

  it('spawns seedlings and respects the local seedling cap', () => {
    const world = createSandboxWorld(123);
    for (let i = 0; i < 60 * 90; i++) tick(world, 1 / 60);
    expect(world.seedlings.size).toBe(LOCAL_SEEDLING_CAP);
    const before = world.seedlings.size;
    for (let i = 0; i < 60 * 10; i++) tick(world, 1 / 60);
    expect(world.seedlings.size).toBe(before);
  });

  it('drops seedlings from an open bloom when one is available', () => {
    const world = createSandboxWorld(91);
    let sprout: ReturnType<typeof getSprout> = null;
    let tree: import('../../src/game/sim/types').Tree | null = null;
    for (let i = 0; i < 60 * 60; i++) {
      tick(world, 1 / 60);
      if (!sprout) sprout = getSprout(world);
      if (sprout) tree = findTreeForSeedling(world, sprout);
      if (tree && tree.maturity > 0.7) break;
    }
    expect(sprout).toBeTruthy();
    expect(tree).toBeTruthy();
    const asteroid = world.asteroids.get(tree!.asteroidId)!;
    const pose = plantPose(asteroid, tree!.slotIndex, tree!.plantAngle);
    const scale = treeVisualScale(asteroid.radius, asteroid.seed);
    const flowers = treeFlowersWorld(
      tree!.seed,
      tree!.maturity,
      scale,
      pose.x,
      pose.y,
      pose.angle + Math.PI / 2,
      pose.dist,
      pose.surfaceY,
      tree!.kind,
      FLOWER_POLLEN_OPEN,
    );
    if (flowers.length === 0) return;
    const fromX = sprout!.sproutFromX ?? sprout!.x;
    const fromY = sprout!.sproutFromY ?? sprout!.y;
    let bestDist = Infinity;
    for (const f of flowers) {
      bestDist = Math.min(bestDist, Math.hypot(f.x - fromX, f.y - fromY));
    }
    expect(bestDist).toBeLessThan(2);
  });

  it('lets a sprout glide into orbit instead of staying on the tree', () => {
    const world = createSandboxWorld(77);
    let sprout = [...world.seedlings.values()].find((s) => s.state === 'sprout');
    for (let i = 0; i < 60 * 40 && !sprout; i++) {
      tick(world, 1 / 60);
      sprout = [...world.seedlings.values()].find((s) => s.state === 'sprout');
    }
    expect(sprout).toBeTruthy();
    const id = sprout!.id;
    const fromX = sprout!.sproutFromX ?? sprout!.x;
    const fromY = sprout!.sproutFromY ?? sprout!.y;
    let maxAbsZ = Math.abs(sprout!.z);
    for (let i = 0; i < 60 * 6; i++) {
      tick(world, 1 / 60);
      const live = world.seedlings.get(id);
      if (live) maxAbsZ = Math.max(maxAbsZ, Math.abs(live.z));
    }
    const grown = world.seedlings.get(id);
    expect(grown).toBeTruthy();
    expect(grown!.state).toBe('orbit');
    expect(Math.hypot(grown!.x - fromX, grown!.y - fromY)).toBeGreaterThan(8);
    expect(maxAbsZ).toBeGreaterThan(8);
  });

  it('keeps seedlings near the asteroid orbit band', () => {
    const world = createSandboxWorld(55);
    const asteroid = [...world.asteroids.values()][0]!;
    for (let i = 0; i < 60 * 30; i++) tick(world, 1 / 60);
    expect(world.seedlings.size).toBeGreaterThan(0);
    for (const s of world.seedlings.values()) {
      if (s.state !== 'orbit') continue;
      const dist = Math.hypot(s.x - asteroid.x, s.y - asteroid.y);
      const ang = Math.atan2(s.y - asteroid.y, s.x - asteroid.x);
      const crust = rockRadiusAt(asteroid, ang);
      expect(dist).toBeGreaterThan(crust + 4);
      expect(dist).toBeLessThan(
        asteroid.radius + orbitBand(asteroid.radius) + 55,
      );
    }
  });
});
