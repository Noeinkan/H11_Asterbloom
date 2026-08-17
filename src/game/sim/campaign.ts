/** Authored campaign maps — pure sim, beside layout. Original copy only. */

import { isGraphConnected } from './graph';
import type { MatchConfig, WinRule } from './match';
import { generateAsteroidName } from './names';
import { pickRockRadius } from './rock';
import { mulberry32 } from './rng';
import {
  ENERGY_TREE_MIN_ENERGY,
  PLAYER_START_SEEDLINGS,
  ROCK_GAP,
  type Difficulty,
  type FactionId,
  type Stats,
  type World,
} from './types';
import {
  addAsteroid,
  allocId,
  computeTreeCoreFeed,
  createEmptyWorld,
  spawnOrbiters,
} from './world';
import { createCoreLoopWorld, createSkirmishWorld } from './layout';

export const CAMPAIGN_INDEX_KEY = 'asterbloom.campaignIndex.v1';

export interface CampaignMapDef {
  id: string;
  title: string;
  blurb: string;
  /** Fixed seed so rematches replay the same grove. */
  seed: number;
  difficulty: Difficulty;
  create: (seed: number) => { world: World; win: WinRule };
}

export interface CampaignStart {
  world: World;
  config: MatchConfig;
  mapIndex: number;
  title: string;
  blurb: string;
}

interface RockSpec {
  x: number;
  y: number;
  role: 'home' | 'enemy' | 'energy' | 'wild' | 'empty';
  travelRadius: number;
  minerals?: number;
  stats?: Stats;
  orbiters?: number;
  treeMaturity?: number;
}

function plantStarter(
  world: World,
  asteroidId: number,
  faction: FactionId,
  seed: number,
  maturity: number,
): void {
  const asteroid = world.asteroids.get(asteroidId)!;
  const treeId = allocId(world);
  const treeSeed = (seed ^ treeId ^ 0x85ebca6b) >>> 0;
  world.trees.set(treeId, {
    id: treeId,
    asteroidId,
    slotIndex: 0,
    kind: 'dyson',
    seed: treeSeed,
    maturity,
    faction,
    spawnAccumulator: 0,
    coreFeed: computeTreeCoreFeed(asteroid, treeSeed, 0, 'dyson'),
  });
}

function buildFromSpecs(seed: number, specs: RockSpec[]): {
  world: World;
  energyWellId: number | null;
} {
  const world = createEmptyWorld(seed);
  const rng = mulberry32(seed);
  let energyWellId: number | null = null;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const radius = pickRockRadius(rng, spec.role === 'home' ? 'home' : 'any');
    const role = spec.role;
    const rock = addAsteroid(world, {
      name: generateAsteroidName(rng),
      x: spec.x,
      y: spec.y,
      radius,
      travelRadius: spec.travelRadius,
      minerals:
        spec.minerals ??
        (role === 'home' || role === 'enemy' ? 60 : 42) +
          Math.floor(rng() * 12),
      stats: spec.stats ?? {
        energy:
          role === 'energy'
            ? ENERGY_TREE_MIN_ENERGY + 50 + Math.floor(rng() * 30)
            : role === 'home'
              ? 85 + Math.floor(rng() * 30)
              : 35 + Math.floor(rng() * 70),
        strength: 35 + Math.floor(rng() * 80),
        speed: 35 + Math.floor(rng() * 80),
      },
      owner:
        role === 'home'
          ? 'player'
          : role === 'enemy'
            ? 'enemy'
            : role === 'empty'
              ? 'neutral'
              : 'grey',
      seed: (seed ^ ((i + 1) * 0x27d4eb2d)) >>> 0,
      role,
    });

    if (role === 'home') {
      plantStarter(world, rock.id, 'player', seed, spec.treeMaturity ?? 0.62);
      spawnOrbiters(world, rock.id, 'player', spec.orbiters ?? PLAYER_START_SEEDLINGS);
    } else if (role === 'enemy') {
      if (world.aiHomeId === null) world.aiHomeId = rock.id;
      plantStarter(world, rock.id, 'enemy', seed, spec.treeMaturity ?? 0.7);
      spawnOrbiters(world, rock.id, 'enemy', spec.orbiters ?? 9);
    } else if (role === 'energy') {
      energyWellId = rock.id;
      spawnOrbiters(world, rock.id, 'grey', spec.orbiters ?? 5);
    } else if (role === 'wild') {
      spawnOrbiters(world, rock.id, 'grey', spec.orbiters ?? 7);
    }
  }

  return { world, energyWellId };
}

function chainTravel(spacing: number): number {
  return spacing * 1.15 + ROCK_GAP;
}

/** Linear chain of rocks along +x for reliable connectivity. */
function chainSpecs(
  roles: RockSpec['role'][],
  spacing = 480,
  extras?: Partial<Record<number, Partial<RockSpec>>>,
): RockSpec[] {
  const travel = chainTravel(spacing);
  return roles.map((role, i) => ({
    x: i * spacing,
    y: (i % 2 === 0 ? 0 : 40),
    role,
    travelRadius: travel,
    ...extras?.[i],
  }));
}

function firstGrove(seed: number): { world: World; win: WinRule } {
  // Compact 5-rock eliminate — core-loop shape.
  const world = createCoreLoopWorld(seed);
  world.difficulty = 'easy';
  return { world, win: { kind: 'eliminate' } };
}

function wildEdge(seed: number): { world: World; win: WinRule } {
  const specs = chainSpecs(
    ['home', 'wild', 'wild', 'empty', 'enemy'],
    460,
    {
      1: { orbiters: 8 },
      2: { orbiters: 10 },
      4: { orbiters: 8, treeMaturity: 0.55 },
    },
  );
  const { world } = buildFromSpecs(seed, specs);
  world.difficulty = 'easy';
  return { world, win: { kind: 'eliminate' } };
}

function holdThree(seed: number): { world: World; win: WinRule } {
  const specs = chainSpecs(
    ['home', 'empty', 'empty', 'enemy', 'wild'],
    450,
    {
      3: { orbiters: 10 },
      4: { orbiters: 6 },
    },
  );
  const { world } = buildFromSpecs(seed, specs);
  world.difficulty = 'normal';
  return { world, win: { kind: 'hold', rocks: 3, seconds: 45 } };
}

function energyClaim(seed: number): { world: World; win: WinRule } {
  const specs = chainSpecs(
    ['home', 'empty', 'wild', 'energy'],
    470,
    {
      2: { orbiters: 8 },
      3: { orbiters: 6 },
    },
  );
  const { world, energyWellId } = buildFromSpecs(seed, specs);
  world.difficulty = 'normal';
  const asteroidId =
    energyWellId ?? [...world.asteroids.keys()].at(-1)!;
  return { world, win: { kind: 'claimEnergyWell', asteroidId } };
}

function choke(seed: number): { world: World; win: WinRule } {
  // Narrow: home - mid - fork left empty / right enemy
  const travel = 520;
  const specs: RockSpec[] = [
    { x: 0, y: 0, role: 'home', travelRadius: travel },
    { x: 480, y: 0, role: 'empty', travelRadius: travel },
    { x: 960, y: -220, role: 'wild', travelRadius: travel, orbiters: 7 },
    { x: 960, y: 220, role: 'enemy', travelRadius: travel, orbiters: 11 },
    { x: 1440, y: 220, role: 'empty', travelRadius: travel },
  ];
  const { world } = buildFromSpecs(seed, specs);
  world.difficulty = 'normal';
  return { world, win: { kind: 'eliminate' } };
}

function holdFive(seed: number): { world: World; win: WinRule } {
  const specs = chainSpecs(
    ['home', 'empty', 'wild', 'empty', 'enemy', 'wild', 'empty'],
    440,
    {
      2: { orbiters: 6 },
      4: { orbiters: 10 },
      5: { orbiters: 7 },
    },
  );
  const { world } = buildFromSpecs(seed, specs);
  world.difficulty = 'normal';
  return { world, win: { kind: 'hold', rocks: 5, seconds: 50 } };
}

function twinOutposts(seed: number): { world: World; win: WinRule } {
  const travel = 500;
  const specs: RockSpec[] = [
    { x: 0, y: 0, role: 'home', travelRadius: travel },
    { x: 460, y: 0, role: 'empty', travelRadius: travel },
    { x: 920, y: -200, role: 'enemy', travelRadius: travel, orbiters: 9 },
    { x: 920, y: 200, role: 'enemy', travelRadius: travel, orbiters: 9 },
    { x: 460, y: 280, role: 'wild', travelRadius: travel, orbiters: 6 },
  ];
  const { world } = buildFromSpecs(seed, specs);
  world.difficulty = 'hard';
  return { world, win: { kind: 'eliminate' } };
}

function lastStand(seed: number): { world: World; win: WinRule } {
  // Dense enemy home with extra orbiters; skirmish-scale but fixed seed feel.
  const travel = 480;
  const specs: RockSpec[] = [
    { x: 0, y: 0, role: 'home', travelRadius: travel },
    { x: 450, y: 80, role: 'wild', travelRadius: travel, orbiters: 8 },
    { x: 900, y: 0, role: 'empty', travelRadius: travel },
    { x: 1350, y: -120, role: 'energy', travelRadius: travel, orbiters: 5 },
    {
      x: 1350,
      y: 160,
      role: 'enemy',
      travelRadius: travel,
      orbiters: 14,
      treeMaturity: 0.85,
      minerals: 78,
    },
    { x: 1800, y: 40, role: 'enemy', travelRadius: travel, orbiters: 10 },
    { x: 900, y: 320, role: 'wild', travelRadius: travel, orbiters: 7 },
  ];
  const { world } = buildFromSpecs(seed, specs);
  world.difficulty = 'hard';
  return { world, win: { kind: 'eliminate' } };
}

export const CAMPAIGN_MAPS: CampaignMapDef[] = [
  {
    id: 'first-grove',
    title: 'First Grove',
    blurb: 'Learn the path. Clear the only hostile grove.',
    seed: 0xc1000001,
    difficulty: 'easy',
    create: firstGrove,
  },
  {
    id: 'wild-edge',
    title: 'Wild Edge',
    blurb: 'Push through wild rocks before the enemy line.',
    seed: 0xc1000002,
    difficulty: 'easy',
    create: wildEdge,
  },
  {
    id: 'hold-three',
    title: 'Hold Three',
    blurb: 'Own three rocks and keep them for a short while.',
    seed: 0xc1000003,
    difficulty: 'normal',
    create: holdThree,
  },
  {
    id: 'energy-claim',
    title: 'Energy Claim',
    blurb: 'Reach the far Energy well and plant your roots.',
    seed: 0xc1000004,
    difficulty: 'normal',
    create: energyClaim,
  },
  {
    id: 'choke',
    title: 'Choke',
    blurb: 'A narrow fork. Choose your fight carefully.',
    seed: 0xc1000005,
    difficulty: 'normal',
    create: choke,
  },
  {
    id: 'hold-five',
    title: 'Hold Five',
    blurb: 'Stretch the grove across five rocks and endure.',
    seed: 0xc1000006,
    difficulty: 'normal',
    create: holdFive,
  },
  {
    id: 'twin-outposts',
    title: 'Twin Outposts',
    blurb: 'Two enemy posts, one empire. Burn them both.',
    seed: 0xc1000007,
    difficulty: 'hard',
    create: twinOutposts,
  },
  {
    id: 'last-stand',
    title: 'Last Stand',
    blurb: 'A dense hostile home. Finish the campaign.',
    seed: 0xc1000008,
    difficulty: 'hard',
    create: lastStand,
  },
];

export function startCampaignMap(index: number): CampaignStart {
  const i = Math.max(0, Math.min(CAMPAIGN_MAPS.length - 1, index | 0));
  const def = CAMPAIGN_MAPS[i]!;
  const { world, win } = def.create(def.seed);
  world.difficulty = def.difficulty;
  // Ensure connectivity; if an authored map somehow disconnects, force travel.
  if (!isGraphConnected(world)) {
    for (const a of world.asteroids.values()) {
      a.travelRadius = Math.max(a.travelRadius, 2400);
    }
  }
  return {
    world,
    config: { win },
    mapIndex: i,
    title: def.title,
    blurb: def.blurb,
  };
}

export function readCampaignIndex(): number {
  try {
    if (typeof localStorage === 'undefined') return 0;
    const raw = localStorage.getItem(CAMPAIGN_INDEX_KEY);
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(CAMPAIGN_MAPS.length - 1, n));
  } catch {
    return 0;
  }
}

export function writeCampaignIndex(index: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const i = Math.max(0, Math.min(CAMPAIGN_MAPS.length - 1, index | 0));
    localStorage.setItem(CAMPAIGN_INDEX_KEY, String(i));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Skirmish helper used by main — keeps difficulty on the world. */
export function startSkirmishWorld(
  seed: number,
  difficulty: Difficulty,
): { world: World; config: MatchConfig } {
  const world = createSkirmishWorld(seed);
  world.difficulty = difficulty;
  return { world, config: { win: { kind: 'eliminate' } } };
}
