/**
 * World snapshots — pure, sim-only, JSON-safe.
 *
 * `World` is four `Map`s of plain data with no RNG streams, timers, or
 * handles: every seeded value is re-derived on demand from `world.seed` plus
 * entity ids. That makes a snapshot a mechanical transform — Maps become
 * arrays of their values (each entity already carries its own `id`), floats
 * get rounded, and the rest is copied field by field.
 *
 * Two things are deliberate and load-bearing:
 *
 * 1. **Insertion order is preserved.** `spawnSeedling` mixes `world.nextId`
 *    into its RNG seed and `spawnOrbiters` mixes in the batch size, so entity
 *    allocation order is part of the simulation's identity, not an accident of
 *    iteration.
 * 2. **`dietaryBias` is persisted, not recomputed.** `tickTrees` only assigns
 *    it while `maturity < 1`, so a mature tree never refreshes it — yet
 *    `pickSeedlingKind` and `seedStatsFromDiet` read it for the rest of the
 *    match. Dropping it would silently change what every mature tree spawns
 *    after a load. Only `rootTips` (rebuilt lazily) and `rootIntake` (rebuilt
 *    unconditionally every tick) are safe to omit.
 */

import type {
  Asteroid,
  Difficulty,
  FactionId,
  PendingPlant,
  ResourcePocket,
  RootIntake,
  Seedling,
  SeedlingKind,
  SeedlingState,
  Stats,
  Tree,
  TreeKind,
  World,
} from './types';

export const WORLD_SCHEMA_VERSION = 1;

/** Positions and animation phases — sub-pixel precision is not meaningful. */
export const SAVE_POS_DP = 3;
/** Gameplay scalars: hp, maturity, energy, timers. */
export const SAVE_VAL_DP = 4;

function round(v: number, dp: number): number {
  if (!Number.isFinite(v)) return 0;
  const k = 10 ** dp;
  // `+0` collapses -0 to 0 so the canonical JSON has one spelling per value.
  return Math.round(v * k) / k + 0;
}

/** Round while preserving "absent" — an optional field must stay optional. */
function roundOpt(v: number | undefined, dp: number): number | undefined {
  return v === undefined ? undefined : round(v, dp);
}

function saveStats(s: Stats): Stats {
  return {
    energy: round(s.energy, SAVE_VAL_DP),
    strength: round(s.strength, SAVE_VAL_DP),
    speed: round(s.speed, SAVE_VAL_DP),
  };
}

function saveIntake(r: RootIntake | undefined): RootIntake | undefined {
  if (!r) return undefined;
  return {
    mineral: round(r.mineral, SAVE_VAL_DP),
    water: round(r.water, SAVE_VAL_DP),
    energy: round(r.energy, SAVE_VAL_DP),
  };
}

export interface WorldSnapshot {
  v: number;
  seed: number;
  time: number;
  nextId: number;
  aiAcc: number;
  aiHomeId: number | null;
  difficulty: Difficulty;
  asteroids: Asteroid[];
  trees: SavedTree[];
  seedlings: Seedling[];
  pendingPlants: PendingPlant[];
}

/** A `Tree` without the caches the sim rebuilds for itself. */
export type SavedTree = Omit<Tree, 'rootTips' | 'rootIntake'>;

function savePocket(p: ResourcePocket): ResourcePocket {
  return {
    id: p.id,
    kind: p.kind,
    amount: round(p.amount, SAVE_VAL_DP),
    maxAmount: round(p.maxAmount, SAVE_VAL_DP),
    angle: round(p.angle, SAVE_POS_DP),
    radiusT: round(p.radiusT, SAVE_POS_DP),
    depthT: round(p.depthT, SAVE_POS_DP),
    regenPerSec: round(p.regenPerSec, SAVE_VAL_DP),
    depletedAt: p.depletedAt === null ? null : round(p.depletedAt, SAVE_VAL_DP),
    phase: round(p.phase, SAVE_POS_DP),
  };
}

function saveAsteroid(a: Asteroid): Asteroid {
  return {
    id: a.id,
    name: a.name,
    x: round(a.x, SAVE_POS_DP),
    y: round(a.y, SAVE_POS_DP),
    radius: round(a.radius, SAVE_POS_DP),
    travelRadius: round(a.travelRadius, SAVE_POS_DP),
    minerals: round(a.minerals, SAVE_VAL_DP),
    treeSlots: a.treeSlots,
    stats: saveStats(a.stats),
    owner: a.owner,
    seed: a.seed,
    pockets: a.pockets.map(savePocket),
    coreEnergy: round(a.coreEnergy, SAVE_VAL_DP),
    maxCoreEnergy: round(a.maxCoreEnergy, SAVE_VAL_DP),
    energyPool: round(a.energyPool, SAVE_VAL_DP),
    maxEnergyPool: round(a.maxEnergyPool, SAVE_VAL_DP),
    shield: round(a.shield, SAVE_VAL_DP),
    maxShield: round(a.maxShield, SAVE_VAL_DP),
    burnTimer: round(a.burnTimer, SAVE_VAL_DP),
  };
}

function saveTree(t: Tree): SavedTree {
  return {
    id: t.id,
    asteroidId: t.asteroidId,
    slotIndex: t.slotIndex,
    plantAngle: roundOpt(t.plantAngle, SAVE_POS_DP),
    kind: t.kind,
    seed: t.seed,
    maturity: round(t.maturity, SAVE_VAL_DP),
    faction: t.faction,
    spawnAccumulator: round(t.spawnAccumulator, SAVE_VAL_DP),
    coreFeed: round(t.coreFeed, SAVE_VAL_DP),
    // Kept on purpose — see the module header.
    dietaryBias: saveIntake(t.dietaryBias),
  };
}

function saveSeedling(s: Seedling): Seedling {
  return {
    id: s.id,
    asteroidId: s.asteroidId,
    faction: s.faction,
    kind: s.kind,
    stats: saveStats(s.stats),
    hp: round(s.hp, SAVE_VAL_DP),
    maxHp: round(s.maxHp, SAVE_VAL_DP),
    state: s.state,
    angle: round(s.angle, SAVE_POS_DP),
    orbitRadius: round(s.orbitRadius, SAVE_POS_DP),
    orbitSpeed: round(s.orbitSpeed, SAVE_POS_DP),
    x: round(s.x, SAVE_POS_DP),
    y: round(s.y, SAVE_POS_DP),
    z: round(s.z, SAVE_POS_DP),
    inclination: roundOpt(s.inclination, SAVE_POS_DP),
    orbitNode: roundOpt(s.orbitNode, SAVE_POS_DP),
    facing: round(s.facing, SAVE_POS_DP),
    phase: round(s.phase, SAVE_POS_DP),
    orbitBias: roundOpt(s.orbitBias, SAVE_POS_DP),
    heading: roundOpt(s.heading, SAVE_POS_DP),
    sproutAge: roundOpt(s.sproutAge, SAVE_VAL_DP),
    sproutDuration: roundOpt(s.sproutDuration, SAVE_VAL_DP),
    sproutFromX: roundOpt(s.sproutFromX, SAVE_POS_DP),
    sproutFromY: roundOpt(s.sproutFromY, SAVE_POS_DP),
    sproutTipAngle: roundOpt(s.sproutTipAngle, SAVE_POS_DP),
    wait: roundOpt(s.wait, SAVE_VAL_DP),
    // Copied, never shared: a snapshot must not alias the live world.
    path: s.path ? [...s.path] : undefined,
    pathIndex: s.pathIndex,
    plantId: s.plantId,
    plantTargetX: roundOpt(s.plantTargetX, SAVE_POS_DP),
    plantTargetY: roundOpt(s.plantTargetY, SAVE_POS_DP),
  };
}

function savePending(p: PendingPlant): PendingPlant {
  return {
    id: p.id,
    asteroidId: p.asteroidId,
    slotIndex: p.slotIndex,
    plantAngle: roundOpt(p.plantAngle, SAVE_POS_DP),
    faction: p.faction,
    kind: p.kind,
    seedlingIds: [...p.seedlingIds],
    arrived: p.arrived,
  };
}

export function serializeWorld(world: World): WorldSnapshot {
  return {
    v: WORLD_SCHEMA_VERSION,
    seed: world.seed,
    time: round(world.time, SAVE_VAL_DP),
    nextId: world.nextId,
    aiAcc: round(world.aiAcc, SAVE_VAL_DP),
    aiHomeId: world.aiHomeId,
    difficulty: world.difficulty,
    asteroids: [...world.asteroids.values()].map(saveAsteroid),
    trees: [...world.trees.values()].map(saveTree),
    seedlings: [...world.seedlings.values()].map(saveSeedling),
    pendingPlants: [...world.pendingPlants.values()].map(savePending),
  };
}

function byId<T extends { id: number }>(list: readonly T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const item of list) map.set(item.id, item);
  return map;
}

export function deserializeWorld(snap: WorldSnapshot): World {
  if (!snap || typeof snap !== 'object') {
    throw new Error('world snapshot missing');
  }
  if (snap.v !== WORLD_SCHEMA_VERSION) {
    throw new Error(`world schema ${String(snap.v)} unsupported`);
  }
  if (
    !Array.isArray(snap.asteroids) ||
    !Array.isArray(snap.trees) ||
    !Array.isArray(snap.seedlings) ||
    !Array.isArray(snap.pendingPlants)
  ) {
    throw new Error('world snapshot malformed');
  }

  // Rebuilt through the save functions so a hand-edited or older payload
  // cannot smuggle extra fields into the live world.
  return {
    asteroids: byId(snap.asteroids.map(saveAsteroid)),
    trees: byId(snap.trees.map((t) => saveTree(t as Tree) as Tree)),
    seedlings: byId(snap.seedlings.map(saveSeedling)),
    pendingPlants: byId(snap.pendingPlants.map(savePending)),
    nextId: snap.nextId,
    seed: snap.seed,
    time: snap.time,
    aiAcc: snap.aiAcc,
    aiHomeId: snap.aiHomeId ?? null,
    difficulty: snap.difficulty,
  };
}

/**
 * Stable fingerprint of a world's saved state.
 *
 * Hashes the canonical snapshot JSON rather than the live object, so it is
 * quantized exactly as a save is: two worlds with the same digest round-trip
 * to the same bytes. That makes it usable both as a save round-trip check and
 * as the equality test for replay determinism, with no rounding-boundary
 * hazard between the two.
 */
export function worldDigest(world: World): string {
  return digestOf(serializeWorld(world));
}

export function digestOf(snap: WorldSnapshot): string {
  const json = JSON.stringify(snap);
  // FNV-1a, 32-bit. Cheap, no dependency, and plenty for spotting a diverged
  // simulation — this is a test oracle, not a security primitive.
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Re-exported so callers can name the union without importing `types`. */
export type {
  FactionId,
  SeedlingKind,
  SeedlingState,
  TreeKind,
};
