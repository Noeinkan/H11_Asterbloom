/**
 * TEMPORARY — screenshot seeder, not a real test.
 *
 * Drives a skirmish offline with a simple player bot, then writes save-slot
 * payloads (`asterbloom.save.v1` envelopes) for shotkit to inject into
 * localStorage. Delete this file once the screenshots are captured.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';

/**
 * Opt-in: this is a ~90 s offline simulation that writes files outside the
 * repo, not a unit test. `npm test` skips it; the screenshot workflow runs
 * it with SHOTKIT_SEED=1.
 */
const ENABLED = process.env.SHOTKIT_SEED === '1';

import { tickAi } from '../src/game/sim/ai';
import { startSkirmishWorld } from '../src/game/sim/campaign';
import { plantOnCrustAngle, sendSeedlings } from '../src/game/sim/commands';
import { neighbors, shortestPath } from '../src/game/sim/graph';
import { createMatchRuntime, tickMatchRuntime } from '../src/game/sim/match';
import { serializeWorld, type WorldSnapshot } from '../src/game/sim/serialize';
import {
  SIM_DT,
  type Asteroid,
  type TreeKind,
  type World,
} from '../src/game/sim/types';
import { tick } from '../src/game/sim/world';

const OUT =
  process.env.SHOTKIT_SEED_OUT ??
  'C:/Users/andre/AppData/Local/Temp/claude/c--Users-andre-Downloads-H11-Asterbloom/c84da635-6630-4cf8-be00-deb14fca063e/scratchpad/seeds';

const VIEW_W = 1440;
const VIEW_H = 900;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

function orbiting(world: World, rockId: number, faction: string): number {
  let n = 0;
  for (const s of world.seedlings.values()) {
    if (s.asteroidId === rockId && s.state === 'orbit' && s.faction === faction) n++;
  }
  return n;
}

function treesOn(world: World, rockId: number) {
  return [...world.trees.values()].filter((t) => t.asteroidId === rockId);
}

function pendingOn(world: World, rockId: number): number {
  let n = 0;
  for (const p of world.pendingPlants.values()) {
    if (p.asteroidId === rockId) n++;
  }
  return n;
}

/** Player seedlings already flying at this rock, so the bot does not pile on. */
function inboundTo(world: World, rockId: number): number {
  let n = 0;
  for (const s of world.seedlings.values()) {
    if (s.faction !== 'player' || s.state !== 'travel' || !s.path) continue;
    if (s.path[s.path.length - 1] === rockId) n++;
  }
  return n;
}

function dist(a: Asteroid, b: Asteroid): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Plant one tree on `rock`, trying each evenly spaced crust bearing. */
function tryPlant(world: World, rock: Asteroid, kind: TreeKind): boolean {
  const n = Math.max(2, rock.treeSlots);
  for (let k = 0; k < n; k++) {
    const angle = ((k + 0.5) * Math.PI * 2) / n;
    if (plantOnCrustAngle(world, rock.id, angle, 'player', kind).ok) return true;
  }
  return false;
}

/**
 * Player bot.
 *
 * Claiming a rock means planting on it, not merely landing there, so the
 * planting pass runs over every rock the player has seedlings orbiting —
 * not just the ones already owned. Expansion waves only leave owned rocks.
 */
function botStep(world: World, push: boolean): void {
  const rocks = [...world.asteroids.values()];

  // Late game: every stocked rock throws its whole orbit at ONE rival rock.
  // Trickling 20 at a time never produces a battle worth photographing; a
  // single converging wave does.
  if (push) {
    const target = rocks
      .filter((a) => a.owner === 'enemy')
      .sort((a, b) => b.treeSlots - a.treeSlots)[0];
    if (target) {
      for (const rock of rocks) {
        if (rock.owner !== 'player') continue;
        const orb = orbiting(world, rock.id, 'player');
        if (orb < 20) continue;
        if (!shortestPath(world, rock.id, target.id)) continue;
        sendSeedlings(world, rock.id, target.id, orb, 'player');
      }
    }
  }

  for (const rock of rocks) {
    const orb = orbiting(world, rock.id, 'player');
    if (orb === 0) continue;

    // Contested or still burning enemy trees: nothing to do but wait.
    const foes = orbiting(world, rock.id, 'enemy') + orbiting(world, rock.id, 'grey');
    const trees = treesOn(world, rock.id);
    if (foes > 0 || trees.some((t) => t.faction !== 'player')) continue;

    const used = trees.length + pendingOn(world, rock.id);
    const mine = rock.owner === 'player';
    if (used < rock.treeSlots && orb >= (mine ? 24 : 12)) {
      let kind: TreeKind = 'dyson';
      if (rock.stats.energy >= 70 && !trees.some((t) => t.kind === 'energy')) {
        kind = 'energy';
      } else if (
        rock.stats.energy >= 50 &&
        used >= 2 &&
        !trees.some((t) => t.kind === 'defense')
      ) {
        kind = 'defense';
      }
      if (tryPlant(world, rock, kind)) continue;
      if (kind !== 'dyson' && tryPlant(world, rock, 'dyson')) continue;
    }

    if (!mine || orb < 30) continue;

    // Empty rocks are a free claim; garrisoned ones need a real wave, so
    // they are only picked when nothing easier is in reach.
    const cands = neighbors(world, rock.id)
      .map((id) => world.asteroids.get(id)!)
      .filter((t) => t.owner !== 'player' && inboundTo(world, t.id) < 8)
      .sort((a, b) => {
        const ea = a.owner === 'neutral' ? 0 : 1;
        const eb = b.owner === 'neutral' ? 0 : 1;
        return ea - eb || dist(rock, a) - dist(rock, b);
      });
    const target = cands[0];
    if (!target) continue;
    if (!shortestPath(world, rock.id, target.id)) continue;
    sendSeedlings(world, rock.id, target.id, Math.min(orb - 6, 30), 'player');
  }
}

function ownedBy(world: World, faction: string): number {
  let n = 0;
  for (const a of world.asteroids.values()) if (a.owner === faction) n++;
  return n;
}

/** camX/camY that put a world point at the middle of the viewport. */
function centerOn(wx: number, wy: number, zoom: number) {
  return { x: VIEW_W / 2 - wx * zoom, y: VIEW_H / 2 - wy * zoom, zoom };
}

function fitAll(world: World, pad = 90) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const a of world.asteroids.values()) {
    minX = Math.min(minX, a.x - a.radius);
    minY = Math.min(minY, a.y - a.radius);
    maxX = Math.max(maxX, a.x + a.radius);
    maxY = Math.max(maxY, a.y + a.radius);
  }
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(
      MIN_ZOOM,
      Math.min((VIEW_W - pad * 2) / (maxX - minX), (VIEW_H - pad * 2) / (maxY - minY)),
    ),
  );
  return centerOn((minX + maxX) / 2, (minY + maxY) / 2, zoom);
}

/** Frame two rocks together, leaving room for the bottom HUD bar. */
function fitPair(a: Asteroid, b: Asteroid, pad = 190) {
  const minX = Math.min(a.x - a.radius, b.x - b.radius);
  const maxX = Math.max(a.x + a.radius, b.x + b.radius);
  const minY = Math.min(a.y - a.radius, b.y - b.radius);
  const maxY = Math.max(a.y + a.radius, b.y + b.radius);
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(
      MIN_ZOOM,
      Math.min((VIEW_W - pad * 2) / (maxX - minX), (VIEW_H - pad * 2) / (maxY - minY)),
    ),
  );
  return centerOn((minX + maxX) / 2, (minY + maxY) / 2, zoom);
}

interface Envelope {
  camera: { x: number; y: number; zoom: number };
  selected: number | null;
  world: WorldSnapshot;
  time: number;
  note: string;
}

type EnvelopeFn = () => Envelope;

test.runIf(ENABLED)('seed screenshot saves', { timeout: 600_000 }, () => {
  const SEED = Number(process.env.SHOTKIT_SEED ?? 0x5eed11);
  const { world, config } = startSkirmishWorld(SEED, 'normal');
  const runtime = createMatchRuntime();

  mkdirSync(OUT, { recursive: true });

  // Lazily built: serializeWorld is the expensive part, so it only runs for
  // a candidate that actually beats the incumbent.
  const best: Record<string, { score: number; env: Envelope }> = {};
  const keep = (key: string, score: number, make: EnvelopeFn) => {
    if (best[key] && score <= best[key]!.score) return;
    best[key] = { score, env: make() };
  };

  const PUSH_AT = 420;
  const TOTAL = Math.round(900 / SIM_DT);
  let botAcc = 0;

  for (let i = 0; i < TOTAL; i++) {
    botAcc += SIM_DT;
    if (botAcc >= 0.5) {
      botAcc = 0;
      botStep(world, world.time >= PUSH_AT && world.time < PUSH_AT + 24);
    }
    tick(world, SIM_DT);
    tickAi(world, SIM_DT);
    tickMatchRuntime(world, config, runtime, SIM_DT);

    // Only sample every ~0.5 s; serializing is not cheap.
    if (i % 30 !== 0) continue;
    const t = world.time;

    // --- contested rock: player seedlings trading fire with a garrison ---
    for (const a of world.asteroids.values()) {
      if (a.owner === 'player') continue;
      const mine = orbiting(world, a.id, 'player');
      if (mine < 6) continue;
      const foe = orbiting(world, a.id, 'enemy') + orbiting(world, a.id, 'grey');
      const hostileTrees = treesOn(world, a.id).filter(
        (x) => x.faction !== 'player',
      ).length;
      if (foe < 3 && hostileTrees === 0) continue;
      // Raw mass on screen, with the defenders weighted: a lopsided walkover
      // photographs worse than a crowded fight.
      const score = mine + foe * 2 + hostileTrees * 4;
      // A genuinely two-sided fight, scored on the smaller side so a
      // walkover cannot win the slot.
      if (foe >= 6) {
        keep('clash', Math.min(mine, foe) * 10 + Math.max(mine, foe), () => ({
          camera: centerOn(a.x, a.y, 1.5),
          selected: a.id,
          world: serializeWorld(world),
          time: t,
          note: `clash at ${a.name}: ${mine} of yours against ${foe} defenders`,
        }));
      }

      keep('assault', score, () => ({
        camera: centerOn(a.x, a.y, 1.5),
        selected: a.id,
        world: serializeWorld(world),
        time: t,
        note: `assault on ${a.name}: ${mine} of yours vs ${foe} defenders and ${hostileTrees} rival trees`,
      }));
    }

    if (t < 240) continue;

    // --- overview: as much of the map claimed and contested as possible ---
    // Capped before the all-in push: past that the field carries 700+ live
    // seedlings and the browser cannot get a 2880x1800 frame out of it.
    if (t < PUSH_AT - 5) {
    const pRocks = ownedBy(world, 'player');
    const eRocks = ownedBy(world, 'enemy');
    keep('overview', pRocks * 24 + eRocks * 8 + world.trees.size, () => ({
      camera: fitAll(world),
      selected: null,
      world: serializeWorld(world),
      time: t,
      note: `overview: you ${pRocks} rocks, rival ${eRocks}, ${world.trees.size} trees`,
    }));
    }

    // --- empire: just the player's cluster, closer in than fit-all ---
    {
      const mineRocks = [...world.asteroids.values()].filter(
        (a) => a.owner === 'player',
      );
      if (mineRocks.length >= 3) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const a of mineRocks) {
          minX = Math.min(minX, a.x - a.travelRadius * 0.5);
          minY = Math.min(minY, a.y - a.travelRadius * 0.5);
          maxX = Math.max(maxX, a.x + a.travelRadius * 0.5);
          maxY = Math.max(maxY, a.y + a.travelRadius * 0.5);
        }
        const zoom = Math.min(
          1.1,
          Math.max(
            MIN_ZOOM,
            Math.min((VIEW_W - 160) / (maxX - minX), (VIEW_H - 260) / (maxY - minY)),
          ),
        );
        const travelling = [...world.seedlings.values()].filter(
          (x) => x.faction === 'player' && x.state === 'travel',
        ).length;
        keep('empire', mineRocks.length * 20 + travelling * 3 + zoom * 30, () => ({
          camera: centerOn((minX + maxX) / 2, (minY + maxY) / 2, zoom),
          selected: null,
          world: serializeWorld(world),
          time: t,
          note: `empire: ${mineRocks.length} rocks, ${travelling} seedlings in transit, zoom ${zoom.toFixed(2)}`,
        }));
      }
    }

    // --- grove: the fullest player rock, close in ---
    for (const a of world.asteroids.values()) {
      if (a.owner !== 'player') continue;
      const trees = treesOn(world, a.id);
      if (trees.length < 3) continue;
      const mature = trees.filter((x) => x.maturity > 0.85).length;
      const orb = orbiting(world, a.id, 'player');
      const kinds = new Set(trees.map((x) => x.kind)).size;
      const score = mature * 12 + kinds * 25 + Math.min(orb, 35);
      keep('grove', score, () => ({
        camera: centerOn(a.x, a.y - a.radius * 0.16, 1.9),
        selected: a.id,
        world: serializeWorld(world),
        time: t,
        note: `${a.name}: ${trees.length} trees (${mature} mature, ${kinds} kinds), ${orb} orbiting`,
      }));
    }

    // --- send: a stocked player rock next to an unclaimed neighbour ---
    for (const a of world.asteroids.values()) {
      if (a.owner !== 'player') continue;
      const orb = orbiting(world, a.id, 'player');
      if (orb < 18) continue;
      for (const nid of neighbors(world, a.id)) {
        const b = world.asteroids.get(nid)!;
        if (b.owner === 'player') continue;
        const cam = fitPair(a, b);
        if (cam.zoom < 0.45) continue;
        const score = orb + treesOn(world, a.id).length * 6 + cam.zoom * 20;
        keep('send', score, () => ({
          camera: cam,
          selected: a.id,
          world: serializeWorld(world),
          time: t,
          note:
            `send from ${a.name} (${orb} orbiting) to ${b.name} ` +
            `from=${a.x},${a.y} to=${b.x},${b.y}`,
        }));
      }
    }
  }

  const manifest: Record<string, unknown> = {};
  for (const [key, { env }] of Object.entries(best)) {
    const payload = {
      schema: 1,
      version: '0.1.0',
      savedAt: Date.now(),
      mode: 'skirmish' as const,
      seed: SEED,
      difficulty: 'normal' as const,
      campaignIndex: 0,
      campaignTitle: '',
      matchConfig: config,
      holdAcc: 0,
      world: env.world,
      camera: env.camera,
      view: {
        selectedAsteroidId: env.selected,
        sendCount: 20,
        sendMode: 'half' as const,
        plantKind: 'dyson' as const,
      },
      followSend: false,
      palTime: env.time,
    };
    writeFileSync(`${OUT}/${key}.json`, JSON.stringify(payload));
    manifest[key] = { note: env.note, time: env.time, camera: env.camera };
  }
  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(manifest, null, 2));
});
