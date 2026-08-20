/** Pure simulation types — no Pixi imports. */

export type FactionId = 'player' | 'neutral' | 'enemy' | 'grey';

export type TreeKind = 'dyson' | 'energy' | 'defense';

export type SeedlingKind = 'basic' | 'sentinel';

export type SeedlingState = 'sprout' | 'orbit' | 'travel' | 'plant';

export interface Stats {
  energy: number;
  strength: number;
  speed: number;
}

export type ResourceKind = 'mineral' | 'water' | 'energy';

/** Rock archetype used by layout to roll pocket counts and amounts. */
export type ResourceRole = 'home' | 'enemy' | 'energy' | 'wild' | 'empty';

export interface ResourcePocket {
  id: number;
  kind: ResourceKind;
  /** Current resource amount; drains with extraction, regens toward maxAmount. */
  amount: number;
  /** Cap amount regens toward. */
  maxAmount: number;
  /** Bearing on the disc (radians). */
  angle: number;
  /** Radial position as a fraction of rock radius (0 = core, 1 = crust). */
  radiusT: number;
  /** Subsurface depth as a fraction of radius; drives transparency. */
  depthT: number;
  regenPerSec: number;
  /** World time the pocket last hit 0 (null while it holds reserves). */
  depletedAt: number | null;
  /** Breathing phase offset (radians). */
  phase: number;
}

export interface RootIntake {
  mineral: number;
  water: number;
  energy: number;
}

export interface Asteroid {
  id: number;
  name: string;
  x: number;
  y: number;
  radius: number;
  travelRadius: number;
  /** Fertility: more minerals → more tree slots and faster seedling production. */
  minerals: number;
  treeSlots: number;
  stats: Stats;
  owner: FactionId;
  seed: number;
  /** Subsurface resource pockets feeding root extraction. */
  pockets: ResourcePocket[];
  /**
   * Internal reservoir fed by root extraction from subsurface pockets.
   * Starts full; drains per tree and refills from per-tree rootIntake.
   */
  coreEnergy: number;
  maxCoreEnergy: number;
  /** Regenerating pool used by Sentinels and shields. */
  energyPool: number;
  maxEnergyPool: number;
  shield: number;
  maxShield: number;
  /** Seconds occupying seedlings have been burning undefended trees. */
  burnTimer: number;
}

export interface Tree {
  id: number;
  asteroidId: number;
  slotIndex: number;
  /** Crust bearing when planted from a click; omit to use the slot default. */
  plantAngle?: number;
  kind: TreeKind;
  seed: number;
  /** 0..1 growth progress */
  maturity: number;
  faction: FactionId;
  spawnAccumulator: number;
  /** How well inward wood reached the core well (0..1), baked at plant time. */
  coreFeed: number;
  /** Per-frame extraction from subsurface pockets (cached each tick). */
  rootIntake?: RootIntake;
  /** Normalized (0..1) per-kind diet share derived from rootIntake. */
  dietaryBias?: RootIntake;
  /** Baked world-space root-tip positions (static per tree, computed once). */
  rootTips?: { x: number; y: number }[];
}

export interface Seedling {
  id: number;
  asteroidId: number;
  faction: FactionId;
  kind: SeedlingKind;
  stats: Stats;
  hp: number;
  maxHp: number;
  state: SeedlingState;
  /** Orbit angle radians */
  angle: number;
  orbitRadius: number;
  orbitSpeed: number;
  x: number;
  y: number;
  /** Camera-depth; +z is toward the viewer, 0 is the equatorial plane. */
  z: number;
  /** Orbital-plane tilt for 3D planet-glide (radians). */
  inclination?: number;
  /** Longitude where the orbit crosses the equator (radians). */
  orbitNode?: number;
  /** Render heading, radians. */
  facing: number;
  /** Unique phase for breeze / glide (radians). */
  phase: number;
  /** Per-seed orbit radius offset. */
  orbitBias?: number;
  /** Smoothed travel / dive heading. */
  heading?: number;
  sproutAge?: number;
  sproutDuration?: number;
  sproutFromX?: number;
  sproutFromY?: number;
  sproutTipAngle?: number;
  /** Seconds before travel/plant motion starts (streamed peel-off). */
  wait?: number;
  /** Asteroid id path including destination; next hop is path[pathIndex]. */
  path?: number[];
  pathIndex?: number;
  /** Pending plant this seedling is diving for. */
  plantId?: number;
  plantTargetX?: number;
  plantTargetY?: number;
}

export interface PendingPlant {
  id: number;
  asteroidId: number;
  slotIndex: number;
  /** Crust bearing when planted from a click; omit to use the slot default. */
  plantAngle?: number;
  faction: FactionId;
  kind: TreeKind;
  seedlingIds: number[];
  arrived: number;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface World {
  asteroids: Map<number, Asteroid>;
  trees: Map<number, Tree>;
  seedlings: Map<number, Seedling>;
  pendingPlants: Map<number, PendingPlant>;
  nextId: number;
  seed: number;
  time: number;
  aiAcc: number;
  /** Enemy starting rock; AI prioritizes retaking it when lost. */
  aiHomeId: number | null;
  /** Skirmish / campaign AI tempo. */
  difficulty: Difficulty;
}

/** Continuous rock size range. Layout skews toward the small end. */
export const ROCK_RADIUS_MIN = 97;
export const ROCK_RADIUS_MAX = 181;
/** Player home disc vs the same size roll without this scale. */
export const HOME_RADIUS_SCALE = 1.3;
/** Fallback when a fixture omits radius. */
export const ROCK_RADIUS_DEFAULT = 124;
/** Minimum rim gap kept between discs when laying out a map. */
export const ROCK_GAP = 48;
/**
 * Tree collar nestles this fraction of mean radius into the living crust.
 * Keep it inside the film (about 3–10% of r), not hanging in the hollow.
 */
export const ROCK_SURFACE_INSET = 0.026;
/**
 * Adult spine height at scale 1 (`buildAdultTree`). Groves are sized as a
 * fraction of disc radius so the rock stays the larger body.
 */
export const TREE_SPINE_HEIGHT = 148;
/** Mature tree (spine + canopy) as a fraction of mean disc radius. */
export const TREE_TO_ROCK = 0.62;

export function treeVisualScale(radius: number, seed = 0): number {
  const wobble =
    seed === 0
      ? 0
      : (((Math.imul(seed ^ 0x27d4eb2d, 0x9e3779b9) >>> 8) & 255) / 255) *
          0.06 -
        0.03;
  return (TREE_TO_ROCK * radius) / TREE_SPINE_HEIGHT + wobble;
}

/**
 * Fixed simulation step. The app ticker and the offline `replay()` re-sim are
 * the only things that drive the world, and both must step at exactly this
 * rate or a recorded match stops reproducing.
 */
export const SIM_DT = 1 / 60;

/** Phase 4 pacing: opening scout, mid wells/chokes, late fights not mopping. */
export const LOCAL_SEEDLING_CAP = 35;
/** Player home always starts with this many orbiting seedlings. */
export const PLAYER_START_SEEDLINGS = 35;
export const DYSON_GROWTH_SECONDS = 32;
export const ENERGY_GROWTH_SECONDS = 38;
export const DEFENSE_GROWTH_SECONDS = 24;
export const DYSON_SPAWN_INTERVAL = 1.7;
export const ENERGY_SPAWN_INTERVAL = 2.0;
/** Maturity when side-branch tips exist and seedlings may begin to drop. */
export const SPAWN_START_MATURITY = 0.4;
export const PLANT_COST = 10;
export const TRAVEL_BASE_SPEED = 96;
export const PLANT_DIVE_SPEED = 78;
/** Stay this far outside the lumpy rim so orbit never clips the hollow. */
export const SURFACE_CLEARANCE = 8;
/** Angular speed while skimming the crust toward a plant slot. */
export const PLANT_CRUISE_SPEED = 2.15;
/** Start the inward dip once this close to the slot bearing (radians). */
export const PLANT_DIVE_ANGLE = 0.2;
export const ORBIT_BAND = 16;

export function orbitBand(radius: number): number {
  return ORBIT_BAND + radius * 0.14;
}
export const SEND_STAGGER = 0.07;
export const PLANT_STAGGER = 0.05;
export const SPROUT_DURATION = 3.2;

export const ENERGY_TREE_MIN_ENERGY = 70;
export const DEFENSE_TREE_MIN_ENERGY = 50;
export const SENTINEL_UPKEEP = 2.2;
export const SENTINEL_SPAWN_ENERGY = 6;
export const SENTINEL_STARVE_DPS = 4;
export const ENERGY_REGEN_BASE = 2.4;
/** Max spawn-rate boost when inward wood fully feeds from the core. */
export const ROOT_FEED_SPAWN_BONUS = 0.18;
/** Extra energy-pool regen per second from one fully fed mature tree. */
export const ROOT_FEED_REGEN = 0.45;

/** Subsurface resource pockets per rock, by archetype. */
export const POCKETS_PER_ROCK: Record<ResourceRole, number> = {
  home: 5,
  enemy: 4,
  energy: 6,
  wild: 2,
  empty: 1,
};
// Enemy mirrors home amounts: a rival home world is just as rich a target.
export const POCKET_AMOUNT_MINERAL: Record<ResourceRole, number> = {
  home: 14,
  enemy: 14,
  energy: 8,
  wild: 6,
  empty: 4,
};
export const POCKET_AMOUNT_WATER: Record<ResourceRole, number> = {
  home: 12,
  enemy: 12,
  energy: 6,
  wild: 4,
  empty: 6,
};
export const POCKET_AMOUNT_ENERGY: Record<ResourceRole, number> = {
  home: 10,
  enemy: 10,
  energy: 18,
  wild: 3,
  empty: 2,
};
export const POCKET_REGEN_PER_SEC = 0.25;
/** Falloff (in radiusT units) over which a root tip draws from a pocket. */
export const ROOT_INTAKE_FALLOFF = 0.85;
/** Core reservoir drain per tree per second. */
export const CORE_FEED_DRAIN = 0.04;
/** Weight of each resource kind when converted into coreEnergy. */
export const CORE_ENERGY_PER_INTAKE: Record<ResourceKind, number> = {
  mineral: 1.0,
  water: 0.7,
  energy: 1.4,
};
/** Modest maturity boost (per second, at full core) when the reservoir is fed. */
export const ROOT_FEED_GROWTH_BONUS = 0.002;

/**
 * Dietary bias weights: how strongly each pocket kind nudges the tree's
 * per-type growth, seed stats, and visual tint. Eufloria-inspired; the
 * three resources map to ENERGY (gravitropism / height, fast spawning),
 * STRENGTH (root thickness, attack), and SPEED (canopy, scout mobility).
 */
export const DIET_GROWTH_WEIGHT: Record<ResourceKind, number> = {
  mineral: 0.8,
  water: 0.5,
  energy: 1.0,
};
/** Additive maturity boost per second at full bias for that kind. */
export const DIET_GROWTH_RATE = 0.003;
/** Seed stat gain per unit of normalized bias (0..1). Bounded hits. */
export const DIET_STAT_GAIN = 0.45;
/** Spawn-interval shrink per unit of normalized bias (faster spender). */
export const DIET_SPAWN_BOOST = 0.18;
/** Below this total intake the bias is treated as un-fed — no bonuses. */
export const DIET_INTAKE_FLOOR = 0.05;
/**
 * Minimum normalized bias share to graduate a tree from basic to sentinel
 * seedlings. The dominant bias has to exceed this for the kind to switch.
 */
export const DIET_SENTINEL_BIAS = 0.55;

/**
 * Normalize a per-kind root intake into a 0..1 weighted "diet" vector.
 * The returned {mineral, water, energy} sums to 1 (when not all zero), so
 * downstream code can mix tints, average stats, and pick a dominant kind
 * without each caller re-deriving the share.
 */
export function dietaryBias(intake: RootIntake | undefined): RootIntake {
  const m = intake?.mineral ?? 0;
  const w = intake?.water ?? 0;
  const e = intake?.energy ?? 0;
  const d = m * DIET_GROWTH_WEIGHT.mineral + w * DIET_GROWTH_WEIGHT.water + e * DIET_GROWTH_WEIGHT.energy;
  if (d < 1e-6) return { mineral: 0, water: 0, energy: 0 };
  return {
    mineral: (m * DIET_GROWTH_WEIGHT.mineral) / d,
    water: (w * DIET_GROWTH_WEIGHT.water) / d,
    energy: (e * DIET_GROWTH_WEIGHT.energy) / d,
  };
}

/** Return the dominant kind (or null if intake is below the feed floor). */
export function dominantDiet(intake: RootIntake | undefined): ResourceKind | null {
  const bias = dietaryBias(intake);
  const total = (intake?.mineral ?? 0) + (intake?.water ?? 0) + (intake?.energy ?? 0);
  if (total < DIET_INTAKE_FLOOR) return null;
  let best: ResourceKind = 'mineral';
  let bestV = bias.mineral;
  if (bias.water > bestV) { best = 'water'; bestV = bias.water; }
  if (bias.energy > bestV) { best = 'energy'; bestV = bias.energy; }
  return best;
}
export const COMBAT_RANGE = 28;
export const BASIC_HP = 12;
export const SENTINEL_HP = 34;
export const BASIC_DPS = 3.8;
export const SENTINEL_DPS = 11.5;
export const SHIELD_PER_DEFENSE = 72;
export const TREE_BURN_SECONDS = 4.8;
/** AI difficulty: seconds between empire decisions (normal baseline). */
export const AI_THINK_INTERVAL = 7.5;
/** AI difficulty: orbiters kept on a held rock before raiding/planting. */
export const AI_GARRISON = 10;
/** AI difficulty: max seedlings sent per raid. */
export const AI_RAID = 6;
/** Cap Energy trees per rock so Sentinels are not starved by over-planting. */
export const AI_ENERGY_TREES_PER_ROCK = 1;
/** Cap Defense trees per border rock. */
export const AI_DEFENSE_TREES_PER_ROCK = 1;

export function aiKnobs(d: Difficulty): {
  think: number;
  garrison: number;
  raid: number;
} {
  if (d === 'easy') {
    return { think: 10, garrison: 12, raid: 4 };
  }
  if (d === 'hard') {
    return { think: 5, garrison: 8, raid: 8 };
  }
  return {
    think: AI_THINK_INTERVAL,
    garrison: AI_GARRISON,
    raid: AI_RAID,
  };
}

export function mineralsToSlots(minerals: number): number {
  return Math.max(2, Math.min(6, 2 + Math.floor(minerals / 22)));
}

export function energyCapacity(energy: number): number {
  return 20 + energy * 0.45;
}

export function canPlantKind(energy: number, kind: TreeKind): boolean {
  if (kind === 'energy') return energy >= ENERGY_TREE_MIN_ENERGY;
  if (kind === 'defense') return energy >= DEFENSE_TREE_MIN_ENERGY;
  return true;
}
