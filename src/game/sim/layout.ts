import { isGraphConnected } from './graph';
import { generateAsteroidName } from './names';
import { pickRockRadius } from './rock';
import { mulberry32, range, rangeInt, type Rng } from './rng';
import {
  ENERGY_TREE_MIN_ENERGY,
  HOME_RADIUS_SCALE,
  PLAYER_START_SEEDLINGS,
  ROCK_GAP,
  ROCK_RADIUS_MAX,
  ROCK_RADIUS_MIN,
  type World,
} from './types';
import {
  addAsteroid,
  allocId,
  computeTreeCoreFeed,
  createEmptyWorld,
  spawnOrbiters,
} from './world';

/**
 * 5 connected asteroids. Home at origin with one pre-planted Dyson.
 * Empty / wild / energy-rich / enemy rocks so expansion, fights, and
 * Energy trees all show up in the core loop.
 * Retries layout seeds until the travel graph is connected.
 * Kept as a unit-test fixture; play uses createSkirmishWorld.
 */
export function createCoreLoopWorld(seed = 0xc0a1f00d): World {
  for (let attempt = 0; attempt < 64; attempt++) {
    const world = tryCoreLayout((seed + attempt * 9973) >>> 0);
    if (isGraphConnected(world)) return world;
  }
  return tryCoreLayout(seed, true);
}

/**
 * Seeded skirmish: 14–20 rocks, MST travel graph with a few chords,
 * player home on an MST leaf, 1–2 enemy rocks, energy wells, wild/empty mix.
 */
export function createSkirmishWorld(seed = 0xc0a1f00d): World {
  for (let attempt = 0; attempt < 64; attempt++) {
    const world = trySkirmishLayout((seed + attempt * 9973) >>> 0, false);
    if (world && isGraphConnected(world)) return world;
  }
  const fallback = trySkirmishLayout(seed, true);
  if (fallback) return fallback;
  return createCoreLoopWorld(seed);
}

function tryCoreLayout(seed: number, forceConnected = false): World {
  const world = createEmptyWorld(seed);
  const rng = mulberry32(seed);
  const homeR = pickRockRadius(rng, 'home');

  const home = addAsteroid(world, {
    name: generateAsteroidName(rng),
    x: 0,
    y: 0,
    radius: homeR,
    travelRadius: forceConnected ? 720 : range(rng, 420, 560),
    minerals: mineralsFor(rng, 'home', homeR),
    stats: {
      energy: 90 + Math.floor(rng() * 40),
      strength: 45 + Math.floor(rng() * 40),
      speed: 55 + Math.floor(rng() * 40),
    },
    owner: 'player',
    seed: (seed ^ 0x9e3779b9) >>> 0,
    role: 'home',
  });

  const homeTreeId = allocId(world);
  const homeTreeSeed = (seed ^ 0x85ebca6b) >>> 0;
  world.trees.set(homeTreeId, {
    id: homeTreeId,
    asteroidId: home.id,
    slotIndex: 0,
    kind: 'dyson',
    seed: homeTreeSeed,
    maturity: 0.4,
    faction: 'player',
    spawnAccumulator: 0,
    coreFeed: computeTreeCoreFeed(home, homeTreeSeed, 0, 'dyson'),
  });

  spawnOrbiters(world, home.id, 'player', PLAYER_START_SEEDLINGS);

  const roles = ['empty', 'wild', 'energy', 'enemy'] as const;
  const angles = [0.2, 1.4, 2.6, 4.0];
  for (let i = 0; i < 4; i++) {
    const a = angles[i]! + range(rng, -0.15, 0.15);
    const rockR = pickRockRadius(rng);
    const minSep = home.radius + rockR + ROCK_GAP;
    const dist = Math.max(
      minSep,
      forceConnected ? 420 + i * 60 : range(rng, 400, 620),
    );
    const role = roles[i]!;
    const rock = addAsteroid(world, {
      name: generateAsteroidName(rng),
      x: Math.cos(a) * dist,
      y: Math.sin(a) * dist,
      radius: rockR,
      travelRadius: forceConnected ? 720 : range(rng, 400, 580),
      minerals: mineralsFor(rng, role, rockR),
      role,
      stats: {
        energy:
          role === 'energy'
            ? 130 + Math.floor(rng() * 40)
            : 30 + Math.floor(rng() * 90),
        strength: 30 + Math.floor(rng() * 120),
        speed: 30 + Math.floor(rng() * 120),
      },
      owner:
        role === 'enemy' ? 'enemy' : role === 'empty' ? 'neutral' : 'grey',
      seed: (seed ^ ((i + 1) * 0x27d4eb2d)) >>> 0,
    });

    if (role === 'wild') {
      spawnOrbiters(world, rock.id, 'grey', 9);
    } else if (role === 'energy') {
      spawnOrbiters(world, rock.id, 'grey', 6);
    } else if (role === 'enemy') {
      world.aiHomeId = rock.id;
      const treeId = allocId(world);
      const enemyTreeSeed = (seed ^ 0xc2b2ae35) >>> 0;
      world.trees.set(treeId, {
        id: treeId,
        asteroidId: rock.id,
        slotIndex: 0,
        kind: 'dyson',
        seed: enemyTreeSeed,
        maturity: 0.45,
        faction: 'enemy',
        spawnAccumulator: 0,
        coreFeed: computeTreeCoreFeed(rock, enemyTreeSeed, 0, 'dyson'),
      });
      spawnOrbiters(world, rock.id, 'enemy', 12);
    }
  }

  return world;
}

interface Point {
  x: number;
  y: number;
}

interface MstEdge {
  a: number;
  b: number;
  dist: number;
}

function trySkirmishLayout(seed: number, forceConnected: boolean): World | null {
  const rng = mulberry32(seed);
  const count = rangeInt(rng, 14, 20);
  const diskR = range(rng, 1300, 1750);
  const radii = Array.from({ length: count }, () => pickRockRadius(rng));

  const points = placePoints(rng, radii, diskR, ROCK_GAP);
  if (!points || points.length !== count) return null;

  const mst = buildMst(points);
  const mstAdj = adjacencyFromEdges(count, mst);

  const travelRadius = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i++) {
    let maxEdge = 0;
    for (const j of mstAdj[i]!) {
      maxEdge = Math.max(maxEdge, dist(points[i]!, points[j]!));
    }
    travelRadius[i] = maxEdge * 1.08 + range(rng, 8, 28);
  }

  const mstEdgeSet = new Set(mst.map((e) => edgeKey(e.a, e.b)));
  const chordCount = rangeInt(rng, 2, 5);
  const candidates: MstEdge[] = [];
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (mstEdgeSet.has(edgeKey(i, j))) continue;
      const d = dist(points[i]!, points[j]!);
      if (d < diskR * 0.55) candidates.push({ a: i, b: j, dist: d });
    }
  }
  candidates.sort((u, v) => u.dist - v.dist);
  let added = 0;
  for (const c of candidates) {
    if (added >= chordCount) break;
    travelRadius[c.a] = Math.max(travelRadius[c.a]!, c.dist * 1.05);
    travelRadius[c.b] = Math.max(travelRadius[c.b]!, c.dist * 1.05);
    added++;
  }

  if (forceConnected) {
    for (let i = 0; i < count; i++) {
      travelRadius[i] = Math.max(travelRadius[i]!, diskR * 0.85);
    }
  }

  const cx = points.reduce((s, p) => s + p.x, 0) / count;
  const cy = points.reduce((s, p) => s + p.y, 0) / count;

  const leaves: number[] = [];
  for (let i = 0; i < count; i++) {
    if (mstAdj[i]!.length === 1) leaves.push(i);
  }
  if (leaves.length === 0) return null;

  let homeIdx = leaves[0]!;
  let bestHome = -Infinity;
  for (const i of leaves) {
    const d = dist(points[i]!, { x: cx, y: cy });
    if (d > bestHome) {
      bestHome = d;
      homeIdx = i;
    }
  }

  const homePos = points[homeIdx]!;
  const byFar = [...Array(count).keys()]
    .filter((i) => i !== homeIdx)
    .sort(
      (a, b) =>
        dist(points[b]!, homePos) - dist(points[a]!, homePos),
    );

  const enemyCount = rangeInt(rng, 1, 2);
  const enemyIdx = new Set<number>();
  const primaryEnemy = byFar[0]!;
  enemyIdx.add(primaryEnemy);
  if (enemyCount === 2) {
    const adjFar = byFar.find(
      (i) => i !== primaryEnemy && mstAdj[primaryEnemy]!.includes(i),
    );
    enemyIdx.add(adjFar ?? byFar[1]!);
  }

  const remaining = byFar.filter((i) => !enemyIdx.has(i));
  const wellCount = Math.min(rangeInt(rng, 1, 2), remaining.length);
  const energyIdx = new Set(remaining.slice(0, wellCount));
  const rest = remaining.slice(wellCount);

  scaleHomeDisc(points, radii, travelRadius, mstAdj, homeIdx);

  const world = createEmptyWorld(seed);
  const idByIndex: number[] = [];

  for (let i = 0; i < count; i++) {
    const p = points[i]!;
    let role: 'home' | 'enemy' | 'energy' | 'wild' | 'empty';
    if (i === homeIdx) role = 'home';
    else if (enemyIdx.has(i)) role = 'enemy';
    else if (energyIdx.has(i)) role = 'energy';
    else {
      const ri = rest.indexOf(i);
      role = ri >= 0 && ri < Math.ceil(rest.length / 2) ? 'wild' : 'empty';
    }

    const rock = addAsteroid(world, {
      name: generateAsteroidName(rng),
      x: p.x,
      y: p.y,
      radius: radii[i]!,
      travelRadius: travelRadius[i]!,
      minerals: mineralsFor(rng, role, radii[i]!),
      role,
      stats: {
        energy:
          role === 'energy'
            ? ENERGY_TREE_MIN_ENERGY + 40 + Math.floor(rng() * 40)
            : role === 'home'
              ? 80 + Math.floor(rng() * 40)
              : 30 + Math.floor(rng() * 90),
        strength: 30 + Math.floor(rng() * 120),
        speed: 30 + Math.floor(rng() * 120),
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
    });
    idByIndex[i] = rock.id;

    if (role === 'home') {
      const treeId = allocId(world);
      const homeTreeSeed = (seed ^ 0x85ebca6b) >>> 0;
      world.trees.set(treeId, {
        id: treeId,
        asteroidId: rock.id,
        slotIndex: 0,
        kind: 'dyson',
        seed: homeTreeSeed,
        maturity: 0.4,
        faction: 'player',
        spawnAccumulator: 0,
        coreFeed: computeTreeCoreFeed(rock, homeTreeSeed, 0, 'dyson'),
      });
      spawnOrbiters(world, rock.id, 'player', PLAYER_START_SEEDLINGS);
    } else if (role === 'enemy') {
      const treeId = allocId(world);
        const enemyTreeSeed = (seed ^ (0xc2b2ae35 + i)) >>> 0;
        world.trees.set(treeId, {
          id: treeId,
          asteroidId: rock.id,
          slotIndex: 0,
          kind: 'dyson',
          seed: enemyTreeSeed,
          maturity: 0.45,
          faction: 'enemy',
        spawnAccumulator: 0,
        coreFeed: computeTreeCoreFeed(rock, enemyTreeSeed, 0, 'dyson'),
      });
      spawnOrbiters(world, rock.id, 'enemy', 10 + rangeInt(rng, 0, 4));
    } else if (role === 'energy') {
      spawnOrbiters(world, rock.id, 'grey', 5 + rangeInt(rng, 0, 3));
    } else if (role === 'wild') {
      spawnOrbiters(world, rock.id, 'grey', 7 + rangeInt(rng, 0, 4));
    }
  }

  world.aiHomeId = idByIndex[primaryEnemy]!;
  return world;
}

/** Grow the player home disc and nudge it out so rims still keep ROCK_GAP. */
function scaleHomeDisc(
  points: Point[],
  radii: number[],
  travelRadius: number[],
  mstAdj: number[][],
  homeIdx: number,
): void {
  radii[homeIdx] = radii[homeIdx]! * HOME_RADIUS_SCALE;
  const home = points[homeIdx]!;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      if (i === homeIdx) continue;
      const p = points[i]!;
      const min = radii[homeIdx]! + radii[i]! + ROCK_GAP;
      const dx = home.x - p.x;
      const dy = home.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d + 1e-6 >= min) continue;
      const inv = 1 / Math.max(d, 1e-6);
      const push = min - d;
      home.x += dx * inv * push;
      home.y += dy * inv * push;
      moved = true;
    }
    if (!moved) break;
  }
  for (const j of mstAdj[homeIdx]!) {
    const d = dist(home, points[j]!);
    travelRadius[homeIdx] = Math.max(travelRadius[homeIdx]!, d * 1.08);
    travelRadius[j] = Math.max(travelRadius[j]!, d * 1.08);
  }
}

function mineralsFor(
  rng: Rng,
  role: 'home' | 'enemy' | 'energy' | 'wild' | 'empty',
  radius: number,
): number {
  const t = Math.min(
    1,
    Math.max(0, (radius - ROCK_RADIUS_MIN) / (ROCK_RADIUS_MAX - ROCK_RADIUS_MIN)),
  );
  const fromSize = Math.round(t * 22);
  const base = role === 'home' || role === 'enemy' ? 56 : 36;
  return base + fromSize + Math.floor(rng() * 14);
}

function placePoints(
  rng: Rng,
  radii: number[],
  diskR: number,
  pad: number,
): Point[] | null {
  const points: Point[] = [];
  const extra = radii.map(() => range(rng, 0, 24));
  for (let n = 0; n < radii.length; n++) {
    const r = radii[n]!;
    let placed = false;
    for (let tryN = 0; tryN < 160; tryN++) {
      const ang = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * diskR;
      const x = Math.cos(ang) * rad;
      const y = Math.sin(ang) * rad;
      let ok = true;
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        const min = r + radii[i]! + pad + extra[n]! + extra[i]!;
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy < min * min) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      points.push({ x, y });
      placed = true;
      break;
    }
    if (!placed) return null;
  }
  return points;
}

function buildMst(points: Point[]): MstEdge[] {
  const n = points.length;
  const edges: MstEdge[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      edges.push({ a: i, b: j, dist: dist(points[i]!, points[j]!) });
    }
  }
  edges.sort((u, v) => u.dist - v.dist);

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const unite = (a: number, b: number): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent[ra] = rb;
    return true;
  };

  const mst: MstEdge[] = [];
  for (const e of edges) {
    if (!unite(e.a, e.b)) continue;
    mst.push(e);
    if (mst.length === n - 1) break;
  }
  return mst;
}

function adjacencyFromEdges(n: number, edges: MstEdge[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.a]!.push(e.b);
    adj[e.b]!.push(e.a);
  }
  return adj;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** Degree in the Euclidean MST of asteroid positions (ignores travel chords). */
export function mstDegree(world: World, asteroidId: number): number {
  const rocks = [...world.asteroids.values()];
  const idx = rocks.findIndex((a) => a.id === asteroidId);
  if (idx < 0) return 0;
  const points = rocks.map((a) => ({ x: a.x, y: a.y }));
  const mst = buildMst(points);
  const adj = adjacencyFromEdges(points.length, mst);
  return adj[idx]!.length;
}
