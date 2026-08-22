import './style.css';
import { Application } from 'pixi.js';
import { GameAudio } from './game/audio/audio';
import { createCrustMenu } from './game/hud/crustMenu';
import { createDebugOverlay } from './game/hud/debugOverlay';
import { createFactionPlate } from './game/hud/hudFactionPlate';
import { createHudControls } from './game/hud/hudControls';
import { createMinimapHud, type MinimapHud } from './game/hud/minimapHud';
import {
  CRUST_MENU_ASK,
  crustPlantActionLabel,
} from './game/hud/copy';
import { createPauseHud } from './game/hud/pauseHud';
import {
  createPlanetPanel,
  surveyPlanet,
  type PlanetPanel,
  type PlanetSurvey,
} from './game/hud/planetPanel';
import {
  clearSave,
  hasSave,
  readSave,
  SAVE_SCHEMA_VERSION,
  writeSave,
} from './game/hud/saveStore';
import {
  applyHudScale,
  applyReducedMotionClass,
  GAME_VERSION,
  readFactionMarks,
  readHudScale,
  readMinimap,
  readMuted,
  readReducedMotion,
  readScreenFlash,
  writeMuted,
} from './game/hud/prefs';
import { PerfProbe } from './game/hud/perfProbe';
import { createSessionHud } from './game/hud/sessionHud';
import { createTitleHud } from './game/hud/titleHud';
import { bindCameraControls } from './game/input/cameraControls';
import { travelCentroid } from './game/input/followSend';
import {
  bindGameplay,
  createGameplayState,
  plantOnCrust,
  shouldLeftPan,
  type GameplayState,
  type PlayerIntent,
} from './game/input/gameplay';
import {
  bumpSendCount,
  resolveSendCount,
} from './game/input/sendCount';
import {
  AsteroidView,
  EMPTY_PLANTABLE,
  type ResourceHit,
} from './game/render/asteroidView';
import { Camera } from './game/render/camera';
import { GraphView } from './game/render/graphView';
import {
  applySceneToDocument,
  bucketHue,
  createScenePalette,
  sceneAtTime,
  themeAt,
  writeScene,
  type ScenePalette,
} from './game/render/palette';
import { SeedlingLayer } from './game/render/seedlingView';
import { inView, type ViewBox } from './game/render/viewport';
import { getVisualPrefs, setVisualPrefs } from './game/render/visualPrefs';
import { SendPreview } from './game/render/sendPreview';
import { Starfield } from './game/render/starfield';
import {
  seedlingDepartureSignature,
  TreeView,
  type TreeFrameBudget,
} from './game/render/treeView';
import { tickAi } from './game/sim/ai';
import {
  CAMPAIGN_MAPS,
  startCampaignMap,
  startSkirmishWorld,
  writeCampaignIndex,
} from './game/sim/campaign';
import { countFactionOrbiting } from './game/sim/commands';
import {
  createReplayLog,
  encodeReplay,
  recordPlant,
  recordSend,
  type ReplayLog,
} from './game/sim/replay';
import {
  deserializeWorld,
  serializeWorld,
} from './game/sim/serialize';
import {
  createMatchRuntime,
  DEFAULT_MATCH_CONFIG,
  matchStatus,
  tickMatchRuntime,
  type MatchConfig,
  type MatchRuntime,
  type MatchStatus,
} from './game/sim/match';
import {
  SIM_DT,
  type Asteroid,
  type Difficulty,
  type FactionId,
  type SeedlingState,
  type Tree,
  type World,
} from './game/sim/types';
import {
  countOrbitingKind,
  createEmptyWorld,
  pocketDrainRates,
  tick,
} from './game/sim/world';

const FPS_SAMPLE_MS = 500;
const DEFAULT_SESSION_SEED = 0xc0a1f00d;

/**
 * How many queued rock / tree repaints a single frame is allowed to run.
 * A palette step dirties every view at once; draining a couple per frame
 * turns one 12-rock stall into a repaint that finishes well inside the
 * ~30 frames before the next step, with no visible lag.
 */
/**
 * Autosave cadence. `localStorage.setItem` is a synchronous main-thread write
 * of ~60 KB, so this is deliberately not per-second; the pause and tab-hide
 * hooks cover the moments a player actually expects to be safe.
 */
const AUTOSAVE_SECONDS = 10;

const ROCK_REPAINTS_PER_FRAME = 2;
const TREE_REPAINTS_PER_FRAME = 2;
/**
 * How long one frame may spend repainting trees.
 *
 * A grown grove is the most expensive thing on screen: on the 32-tree
 * overview save each tree costs ~16 ms to rebuild its canopy and ~8 ms to
 * repaint its sap under software GL, so an unbudgeted frame spent ~800 ms in
 * trees alone and the field could never climb back out.
 *
 * This is a wall-clock allowance rather than a repaint count so it means the
 * same thing on a laptop and on a workstation. Trees refused by it keep last
 * frame's paint and stay due, so work is deferred, never dropped: growth
 * lands a frame or two late, and the sap glow — a 5.55 s cycle with a
 * per-plant phase offset — staggers in a way the eye cannot follow, since
 * the grove never pulsed in lockstep to begin with.
 */
const TREE_REPAINT_BUDGET_MS = 4;

/**
 * Backbuffer scale. Soft rocks, washes and gradients are fill-rate bound, so
 * every device pixel costs real time: at DPR 2 we shade four times the
 * fragments of DPR 1 for the same picture. 1.5 keeps edges clean on HiDPI
 * screens; `LOW_RESOLUTION` is where we land if the frame budget says the
 * GPU still can't keep up.
 */
const MAX_RESOLUTION = 1.5;
const LOW_RESOLUTION = 1;
/** Sustained FPS below this (over ~2 s) drops the backbuffer one step. */
const DEGRADE_FPS = 45;
const DEGRADE_SAMPLES = 4;
/**
 * Sustained FPS above this restores the backbuffer. The gap to `DEGRADE_FPS`
 * is the hysteresis band: without it a machine sitting right at the budget
 * would flip resolution every couple of seconds. The sample count is much
 * higher than `DEGRADE_SAMPLES` on purpose — dropping quality must be quick,
 * raising it must be sure.
 */
const RESTORE_FPS = 58;
const RESTORE_SAMPLES = 20;

/**
 * Everything `beginPlayingWorld` normally resets that a resumed match wants
 * back. Every field is optional and defaults to the value a fresh match uses,
 * so the three existing callers are unaffected.
 */
interface WorldEntryRestore {
  camera?: { x: number; y: number; zoom: number };
  gameplay?: Partial<
    Pick<
      GameplayState,
      'selectedAsteroidId' | 'sendCount' | 'sendMode' | 'plantKind'
    >
  >;
  palTime?: number;
  matchRuntime?: MatchRuntime;
}

/** `/field.html` skips title / campaign and drops onto a skirmish map. */
function isFieldBoot(): boolean {
  return document.documentElement.dataset.boot === 'field';
}

function parseSeedFromHash(): number | null {
  const m = /^#s=([0-9a-fA-F]{1,8})$/.exec(location.hash);
  if (!m) return null;
  return Number.parseInt(m[1]!, 16) >>> 0;
}

function writeSeedHash(seed: number): void {
  const hex = (seed >>> 0).toString(16).padStart(8, '0');
  const next = `#s=${hex}`;
  if (location.hash !== next) {
    history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
  }
}

function formatSeedHex(seed: number): string {
  return (seed >>> 0).toString(16).padStart(8, '0');
}

function freshSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

interface CombatSnap {
  hp: Map<number, number>;
  state: Map<number, SeedlingState>;
  /** Last known world x, so a death can be panned where it happened. */
  x: Map<number, number>;
  burn: Map<number, number>;
  trees: Set<number>;
}

function emptyCombatSnap(): CombatSnap {
  return {
    hp: new Map(),
    state: new Map(),
    x: new Map(),
    burn: new Map(),
    trees: new Set(),
  };
}

function fillCombatSnap(world: World, snap: CombatSnap): CombatSnap {
  snap.hp.clear();
  snap.state.clear();
  snap.x.clear();
  snap.burn.clear();
  snap.trees.clear();
  for (const s of world.seedlings.values()) {
    snap.hp.set(s.id, s.hp);
    snap.state.set(s.id, s.state);
    snap.x.set(s.id, s.x);
  }
  for (const a of world.asteroids.values()) {
    snap.burn.set(a.id, a.burnTimer);
  }
  for (const id of world.trees.keys()) snap.trees.add(id);
  return snap;
}

/**
 * Play the combat effects for one sim step and report whether anything was
 * actually fighting — the music uses that to decide how hot the match is.
 * `panAt` turns a world x into a stereo position so hits land on the side of
 * the field they happened on.
 */
function playCombatSfx(
  audio: GameAudio,
  before: CombatSnap,
  world: World,
  into: CombatSnap,
  panAt: (worldX: number) => number,
): { snap: CombatSnap; fighting: boolean } {
  let hpDrop = false;
  let hitX = 0;
  for (const s of world.seedlings.values()) {
    const prev = before.hp.get(s.id);
    if (prev !== undefined && s.hp < prev - 0.01) {
      hpDrop = true;
      hitX = s.x;
      break;
    }
  }
  if (hpDrop) audio.clash(panAt(hitX));

  for (const [id, st] of before.state) {
    if (world.seedlings.has(id)) continue;
    if (st !== 'plant') audio.death(panAt(before.x.get(id) ?? 0));
  }

  for (const a of world.asteroids.values()) {
    const prevBurn = before.burn.get(a.id) ?? 0;
    if (prevBurn <= 0 && a.burnTimer > 0) {
      audio.burn(panAt(a.x));
      break;
    }
  }
  for (const id of before.trees) {
    if (world.trees.has(id)) continue;
    let burning = false;
    for (const a of world.asteroids.values()) {
      if (a.burnTimer > 0) {
        burning = true;
        break;
      }
    }
    if (!burning) {
      for (const t of before.burn.values()) {
        if (t > 0) {
          burning = true;
          break;
        }
      }
    }
    if (burning) audio.burn();
    break;
  }

  return { snap: fillCombatSnap(world, into), fighting: hpDrop };
}

async function loadUiFonts(): Promise<void> {
  const load = Promise.all([
    document.fonts.load('700 16px Comfortaa'),
    document.fonts.load('500 13px Nunito'),
  ]);
  await Promise.race([
    load,
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ]);
}

async function boot(): Promise<void> {
  const host = document.querySelector<HTMLDivElement>('#app');
  if (!host) throw new Error('#app missing');
  await loadUiFonts();

  const audio = new GameAudio();
  audio.setEnabled(!readMuted());

  let sessionSeed = parseSeedFromHash() ?? DEFAULT_SESSION_SEED;
  let world: World = createEmptyWorld(sessionSeed);
  let scene: ScenePalette = createScenePalette(world.seed);
  applySceneToDocument(scene);

  const app = new Application();
  const maxResolution = Math.min(window.devicePixelRatio || 1, MAX_RESOLUTION);
  await app.init({
    resizeTo: window,
    antialias: true,
    backgroundColor: scene.bg,
    autoDensity: true,
    resolution: maxResolution,
    preference: 'webgl',
    powerPreference: 'high-performance',
  });
  host.appendChild(app.canvas);

  host.addEventListener(
    'pointerdown',
    () => {
      audio.startAmbient();
    },
    { once: true },
  );

  const camera = new Camera();
  // The renderer lets the starfield bake its screen-space backdrop into a
  // texture instead of re-shading five stacked full-screen fills every
  // frame. Without it the class still works, just unbaked.
  const starfield = new Starfield(world.seed, scene, app.renderer);
  starfield.resize(app.screen.width, app.screen.height);
  app.stage.addChild(starfield.backdrop);
  app.stage.addChild(camera.world);
  camera.world.addChild(starfield.root);
  app.renderer.on('resize', (width: number, height: number) => {
    starfield.resize(width, height);
  });

  const graphView = new GraphView(scene);
  camera.world.addChild(graphView.root);

  let asteroidViews = new Map<number, AsteroidView>();
  let treeViews = new Map<number, TreeView>();
  let lastOwners = new Map<number, FactionId>();
  let seedlings: SeedlingLayer | null = null;
  const preview = new SendPreview(scene);
  preview.root.zIndex = 6;
  camera.world.addChild(preview.root);

  let gameplay: GameplayState = createGameplayState(0);
  let unbindGameplay: (() => void) | null = null;
  let abortGameplay: (() => void) | null = null;

  let paused = false;
  let status: MatchStatus = 'playing';
  let sessionMode: 'title' | 'playing' = 'title';
  let playMode: 'skirmish' | 'campaign' = 'skirmish';
  let matchConfig: MatchConfig = DEFAULT_MATCH_CONFIG;
  let matchRuntime: MatchRuntime = createMatchRuntime();
  let campaignIndex = 0;
  let campaignTitle = '';
  let skirmishDifficulty: Difficulty = 'normal';
  let firstRunBlocking = false;
  let followSendEnabled = false;
  let followingSend = false;
  let acc = 0;
  /** Completed sim steps this match — the replay log's timebase. */
  let simTick = 0;
  /** Seconds since the last autosave. */
  let saveAcc = 0;
  let palTime = 0;
  let hudAcc = 0;
  let debugAcc = 0;
  let lastHudKey = '';
  let combatSnap = fillCombatSnap(world, emptyCombatSnap());
  let combatSnapB = emptyCombatSnap();
  /** Decays over a few seconds after the last exchange; feeds music intensity. */
  let combatHeat = 0;
  let audioSyncAcc = 0;

  /**
   * Screen x → stereo position, softened so nothing is ever hard panned.
   * Off-screen events fold to the nearest edge rather than wrapping.
   */
  const screenPan = (screenX: number): number => {
    const w = app.screen.width;
    if (w <= 0) return 0;
    return Math.max(-1, Math.min(1, (screenX / w) * 2 - 1)) * 0.7;
  };
  /** Same, for a point in world space. */
  const panAt = (worldX: number): number =>
    screenPan(worldX * camera.zoom + camera.x);
  let lastHueKey = -1;
  let lastPaletteKey = '';
  /** Views whose colors are stale, drained a few per frame while on screen. */
  const rockRepaints = new Set<number>();
  const treeRepaints = new Set<number>();
  let fpsSampleStarted = performance.now();
  let fpsSampleFrames = 0;
  let slowSamples = 0;
  let fastSamples = 0;
  const perf = new PerfProbe();

  /** Created below, but `applyVisualPrefs` runs before that. */
  let minimap: MinimapHud | null = null;

  /**
   * Command log for the running match. Null when the match cannot produce a
   * valid replay — a resumed save starts mid-simulation, so a log from that
   * point would not reproduce anything.
   */
  let replayLog: ReplayLog | null = null;

  const recordIntent = (intent: PlayerIntent) => {
    if (!replayLog) return;
    if (intent.kind === 'send') {
      recordSend(replayLog, simTick, intent.fromId, intent.toId, intent.count);
    } else {
      recordPlant(
        replayLog,
        simTick,
        intent.asteroidId,
        intent.angle,
        intent.treeKind,
      );
    }
  };

  /**
   * Pull every accessibility pref out of storage and push it at the things
   * that render. One function for boot and for every Settings change, so the
   * two paths cannot drift. Declared here because it touches the view maps.
   */
  const applyVisualPrefs = () => {
    const reducedMotion = readReducedMotion();
    applyReducedMotionClass(reducedMotion);
    applyHudScale(readHudScale());
    setVisualPrefs({
      reducedMotion,
      screenFlash: readScreenFlash(),
      factionMarks: readFactionMarks(),
    });
    minimap?.setEnabled(readMinimap());
    // Owner marks are baked into each rock's paint, so a marks toggle has to
    // dirty every view; the repaint budget drains them a couple per frame.
    for (const id of asteroidViews.keys()) rockRepaints.add(id);
  };
  applyVisualPrefs();

  const canAct = () =>
    sessionMode === 'playing' &&
    !paused &&
    !firstRunBlocking &&
    status === 'playing';

  let sessionHud!: ReturnType<typeof createSessionHud>;
  let titleHud!: ReturnType<typeof createTitleHud>;
  let pauseHud!: ReturnType<typeof createPauseHud>;
  let crustMenu!: ReturnType<typeof createCrustMenu>;
  let debugOverlay!: ReturnType<typeof createDebugOverlay>;
  let factionPlate!: ReturnType<typeof createFactionPlate>;
  let hudControls!: ReturnType<typeof createHudControls>;
  let planetPanel: PlanetPanel | null = null;
  /** Last subsurface hit, so its highlight can be cleared off its own rock. */
  let hoverHit: ResourceHit | null = null;

  const syncMuteLabel = () => {
    const muted = !audio.isEnabled();
    pauseHud.setMuted(muted);
    sessionHud.setMuted(muted);
  };

  const setMuted = (muted: boolean) => {
    audio.setEnabled(!muted);
    writeMuted(muted);
    syncMuteLabel();
  };

  const resumeMatch = () => {
    paused = false;
    pauseHud.hide();
    hudControls.setPauseActive(false);
  };

  const pauseMatch = () => {
    paused = true;
    preview.hide();
    crustMenu.hide();
    pauseHud.show({ showNewMap: playMode === 'skirmish' });
    hudControls.setPauseActive(true);
    captureSave();
  };

  const setFollowSend = (enabled: boolean) => {
    followSendEnabled = enabled;
    if (!enabled) followingSend = false;
    pauseHud.setFollowSend(enabled);
  };

  const cancelFollow = () => {
    followingSend = false;
  };

  /**
   * True when `treeViews` no longer mirrors `world.trees`. Size alone is not
   * enough: a tree dying and another being planted in the same tick leaves
   * the count unchanged while both entries are wrong.
   */
  const treeViewsStale = (): boolean => {
    if (world.trees.size !== treeViews.size) return true;
    for (const id of treeViews.keys()) {
      if (!world.trees.has(id)) return true;
    }
    return false;
  };

  const syncTrees = () => {
    for (const [id, view] of treeViews) {
      if (world.trees.has(id)) continue;
      view.destroy();
      treeViews.delete(id);
    }
    for (const tree of world.trees.values()) {
      if (treeViews.has(tree.id)) continue;
      const asteroid = world.asteroids.get(tree.asteroidId);
      if (!asteroid) continue;
      const view = new TreeView(tree, asteroid, scene);
      view.roots.zIndex = 2;
      view.canopy.zIndex = 4;
      treeViews.set(tree.id, view);
      camera.world.addChild(view.roots, view.canopy);
    }
  };

  const clearWorldViews = () => {
    unbindGameplay?.();
    unbindGameplay = null;
    abortGameplay = null;
    preview.hide();
    crustMenu?.hide();
    // The panel outlives the views it points at, so drop its target here.
    planetPanel?.hide();
    hoverHit = null;
    for (const view of asteroidViews.values()) view.destroy();
    asteroidViews.clear();
    for (const view of treeViews.values()) view.destroy();
    treeViews.clear();
    rockRepaints.clear();
    treeRepaints.clear();
    if (seedlings) {
      camera.world.removeChild(seedlings.back, seedlings.front);
      seedlings.destroy();
      seedlings = null;
    }
  };

  const beginPlayingWorld = (
    nextWorld: World,
    seed: number,
    config: MatchConfig,
    restore?: WorldEntryRestore,
  ) => {
    clearWorldViews();
    world = nextWorld;
    sessionSeed = seed;
    matchConfig = config;
    matchRuntime = restore?.matchRuntime ?? createMatchRuntime();
    // Set before the scene is built: a resumed match has to pick the palette
    // and starfield up where it left them instead of snapping back to 0.
    palTime = restore?.palTime ?? 0;
    writeSeedHash(sessionSeed);
    pauseHud.setSeed(formatSeedHex(sessionSeed));
    writeScene(scene, sceneAtTime(world.seed, palTime));
    applySceneToDocument(scene);
    // Seed the soundtrack from the world seed, so a map's theme is as fixed
    // as its palette and starfield.
    audio.beginMatch(scene.hue, scene.dark, world.seed);
    app.renderer.background.color = scene.bg;
    {
      const themes = themeAt(world.seed, palTime);
      starfield.retheme(scene, themes.themeA, themes.themeB, themes.mix);
    }

    // A resumed save can be a match the player was already losing, with no
    // player-owned rock left — so this cannot assume one exists.
    const rocks = [...world.asteroids.values()];
    const home = rocks.find((a) => a.owner === 'player') ?? rocks[0]!;
    asteroidViews = new Map();
    for (const a of world.asteroids.values()) {
      const view = new AsteroidView(a, scene);
      view.root.zIndex = 3;
      // Pollen rides above the canopy but below the seedlings, in its own
      // container so grains keep drifting over neighbouring geometry.
      view.pollenRoot.zIndex = 4.5;
      asteroidViews.set(a.id, view);
      camera.world.addChild(view.root, view.pollenRoot);
    }

    seedlings = new SeedlingLayer(app.renderer, scene);
    seedlings.back.zIndex = 2.5;
    seedlings.front.zIndex = 5;
    camera.world.addChild(seedlings.back, seedlings.front);

    lastOwners = new Map();
    for (const a of world.asteroids.values()) lastOwners.set(a.id, a.owner);

    treeViews = new Map();
    syncTrees();

    gameplay = createGameplayState(home.id);
    if (restore?.gameplay) Object.assign(gameplay, restore.gameplay);
    sessionHud.setPlantKind(gameplay.plantKind);
    const bound = bindGameplay({
      canvas: app.canvas,
      camera,
      world,
      state: gameplay,
      preview,
      audio,
      onCommand: (result, intent) => {
        sessionHud.showCommandResult(result);
        // Only successes go in the log: a rejected command mutates nothing,
        // so replaying it would be a no-op at best and a divergence at worst.
        if (result.ok) recordIntent(intent);
      },
      onSend: () => {
        if (followSendEnabled) followingSend = true;
      },
      canAct,
      onSendCountChange: () => {
        sessionHud.syncSendDock(gameplay.sendCount, gameplay.sendMode);
      },
      onCrustMenu: (hit) => {
        crustMenu.show({
          screenX: hit.screenX,
          screenY: hit.screenY,
          ask: CRUST_MENU_ASK,
          plantLabel: crustPlantActionLabel(gameplay.plantKind),
          onPlant: () => {
            const result = plantOnCrust(
              world,
              gameplay,
              hit.asteroidId,
              hit.angle,
            );
            sessionHud.showCommandResult(result);
            if (result.ok) {
              recordIntent({
                kind: 'plant',
                asteroidId: hit.asteroidId,
                angle: hit.angle,
                treeKind: gameplay.plantKind,
              });
              audio.plant(gameplay.plantKind, screenPan(hit.screenX));
              syncTrees();
            } else {
              audio.fail(screenPan(hit.screenX));
            }
          },
        });
      },
    });
    unbindGameplay = bound.unbind;
    abortGameplay = bound.abort;

    if (restore?.camera) {
      camera.zoom = restore.camera.zoom;
      camera.x = restore.camera.x;
      camera.y = restore.camera.y;
      camera.apply();
    } else {
      camera.zoom = 0.85;
      camera.centerOn(home.x, home.y, app.screen.width, app.screen.height);
    }
    followingSend = false;

    sessionMode = 'playing';
    paused = false;
    status = 'playing';
    acc = 0;
    simTick = 0;
    saveAcc = 0;
    replayLog = restore
      ? null
      : createReplayLog(
          playMode === 'campaign'
            ? { mode: 'campaign', index: campaignIndex }
            : { mode: 'skirmish', seed, difficulty: skirmishDifficulty },
        );
    // palTime is set above, before the scene is built.
    combatSnap = fillCombatSnap(world, combatSnap);
    lastHueKey = Math.round(scene.hue);
    lastPaletteKey = '';
    pauseHud.hide();
    sessionHud.hideEnd();
    sessionHud.setVisible(true);
    titleHud.hide();
    factionPlate.setVisible(true);
    minimap?.retheme(scene);
    minimap?.setVisible(true);
    hudControls.setVisible(true);
    hudControls.setPauseActive(false);
    factionPlate.sync(world, gameplay.selectedAsteroidId);
  };

  /**
   * Snapshot the live match into the save slot. Cheap enough to call on a
   * timer; a failed write (full or unavailable storage) is ignored on purpose,
   * because losing a save is not worth interrupting play for.
   */
  const captureSave = () => {
    if (sessionMode !== 'playing') return;
    if (status !== 'playing') return;
    writeSave({
      schema: SAVE_SCHEMA_VERSION,
      version: GAME_VERSION,
      savedAt: Date.now(),
      mode: playMode,
      seed: sessionSeed,
      difficulty: skirmishDifficulty,
      campaignIndex,
      campaignTitle,
      matchConfig,
      holdAcc: matchRuntime.holdAcc,
      world: serializeWorld(world),
      camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
      view: {
        selectedAsteroidId: gameplay.selectedAsteroidId,
        sendCount: gameplay.sendCount,
        sendMode: gameplay.sendMode,
        plantKind: gameplay.plantKind,
      },
      followSend: followSendEnabled,
      palTime,
    });
  };

  /**
   * Pick up the saved match. Returns false when there is nothing to resume or
   * the payload cannot be trusted, in which case the slot is cleared so the
   * title screen stops offering it.
   */
  const resumeSaved = (): boolean => {
    const snap = readSave();
    if (!snap) return false;
    let restoredWorld: World;
    try {
      restoredWorld = deserializeWorld(snap.world);
    } catch {
      clearSave();
      return false;
    }
    playMode = snap.mode;
    skirmishDifficulty = snap.difficulty;
    campaignIndex = snap.campaignIndex;
    campaignTitle = snap.campaignTitle;
    beginPlayingWorld(restoredWorld, snap.seed, snap.matchConfig, {
      camera: snap.camera,
      gameplay: snap.view,
      palTime: snap.palTime,
      matchRuntime: { holdAcc: snap.holdAcc },
    });
    // beginPlayingWorld does not touch follow-send, so restore it after.
    setFollowSend(snap.followSend);
    return true;
  };

  const startSkirmish = (difficulty: Difficulty, seed?: number) => {
    // A new match replaces the old one; the stale save must not outlive it.
    clearSave();
    playMode = 'skirmish';
    skirmishDifficulty = difficulty;
    campaignTitle = '';
    const s = seed ?? freshSeed();
    const started = startSkirmishWorld(s, difficulty);
    beginPlayingWorld(started.world, s, started.config);
  };

  const startCampaign = (index: number) => {
    clearSave();
    playMode = 'campaign';
    const started = startCampaignMap(index);
    campaignIndex = started.mapIndex;
    campaignTitle = started.title;
    writeCampaignIndex(campaignIndex);
    beginPlayingWorld(started.world, started.world.seed, started.config);
  };

  const restartCurrent = () => {
    if (playMode === 'campaign') startCampaign(campaignIndex);
    else startSkirmish(skirmishDifficulty, sessionSeed);
  };

  const showTitle = () => {
    if (isFieldBoot()) {
      startSkirmish(skirmishDifficulty, sessionSeed);
      return;
    }
    clearWorldViews();
    debugOverlay.setVisible(false);
    sessionMode = 'title';
    status = 'playing';
    paused = false;
    followingSend = false;
    firstRunBlocking = false;
    pauseHud.hide();
    sessionHud.hideEnd();
    sessionHud.setVisible(false);
    sessionHud.dismissFirstRun();
    titleHud.show();
    factionPlate.setVisible(false);
    minimap?.setVisible(false);
    hudControls.setVisible(false);
    hudControls.setPauseActive(false);
    hudControls.setHelpActive(false);
  };

  sessionHud = createSessionHud({
    host,
    onRestart: () => restartCurrent(),
    onNewMap: () => startSkirmish(skirmishDifficulty, freshSeed()),
    onNextMap: () => {
      const next = campaignIndex + 1;
      if (next < CAMPAIGN_MAPS.length) startCampaign(next);
      else showTitle();
    },
    onTitle: () => showTitle(),
    onPlantKind: (kind) => {
      gameplay.plantKind = kind;
    },
    onMuteToggle: () => setMuted(audio.isEnabled()),
    onSendScout: () => {
      if (!canAct()) return;
      const id = gameplay.selectedAsteroidId;
      if (id === null) return;
      const max = countFactionOrbiting(world, id, 'player');
      gameplay.sendMode = 'scout';
      gameplay.sendCount = resolveSendCount(max, 'scout', 1);
    },
    onSendPrecise: () => {
      if (!canAct()) return;
      const id = gameplay.selectedAsteroidId;
      if (id === null) return;
      const max = countFactionOrbiting(world, id, 'player');
      // Enter precise mode with half of available as a friendly default —
      // the player then dials around the target to fine-tune.
      gameplay.sendMode = 'precise';
      gameplay.sendCount = Math.min(max, Math.max(1, Math.ceil(max / 2)));
    },
    onSendAll: () => {
      if (!canAct()) return;
      const id = gameplay.selectedAsteroidId;
      if (id === null) return;
      const max = countFactionOrbiting(world, id, 'player');
      gameplay.sendMode = 'all';
      gameplay.sendCount = resolveSendCount(max, 'all', 0);
    },
    onSendBump: (delta) => {
      if (!canAct()) return;
      const id = gameplay.selectedAsteroidId;
      if (id === null) return;
      const max = countFactionOrbiting(world, id, 'player');
      if (max < 1) {
        gameplay.sendCount = 0;
        gameplay.sendMode = 'fixed';
        return;
      }
      gameplay.sendMode = 'fixed';
      gameplay.sendCount = bumpSendCount(max, gameplay.sendCount, delta);
    },
    onFirstRunDismiss: () => {
      firstRunBlocking = false;
    },
  });

  crustMenu = createCrustMenu(host);

  pauseHud = createPauseHud({
    host,
    onResume: () => resumeMatch(),
    onRestart: () => {
      pauseHud.hide();
      restartCurrent();
    },
    onNewMap: () => {
      pauseHud.hide();
      startSkirmish(skirmishDifficulty, freshSeed());
    },
    onTitle: () => showTitle(),
    onMuteToggle: () => setMuted(audio.isEnabled()),
    onFollowToggle: () => setFollowSend(!followSendEnabled),
  });

  titleHud = createTitleHud({
    host,
    onSkirmish: (difficulty) => {
      const hashSeed = parseSeedFromHash();
      startSkirmish(difficulty, hashSeed ?? freshSeed());
      if (sessionHud.maybeShowFirstRun()) firstRunBlocking = true;
    },
    onCampaign: (index) => {
      startCampaign(index);
      if (sessionHud.maybeShowFirstRun()) firstRunBlocking = true;
    },
    onMuteChange: (muted) => setMuted(muted),
    onPrefsChange: () => applyVisualPrefs(),
    canContinue: () => hasSave(),
    onContinue: () => {
      // A stale or unreadable slot falls through to the normal title screen
      // rather than dropping the player into a broken match.
      if (!resumeSaved()) titleHud.show();
    },
  });

  debugOverlay = createDebugOverlay(host, {
    onCopyReplay: () => (replayLog ? encodeReplay(replayLog) : null),
  });
  planetPanel = createPlanetPanel(host);

  factionPlate = createFactionPlate(host, sessionHud.root.querySelector('.hud-bar'));
  minimap = createMinimapHud({
    host,
    scene,
    anchor: sessionHud.root.querySelector('.hud-bar'),
    onRecenter: (worldX, worldY) => {
      camera.centerOn(worldX, worldY, app.screen.width, app.screen.height);
      // Dragging the minimap is a camera command; it must win over follow-send.
      cancelFollow();
    },
  });
  minimap.setEnabled(readMinimap());
  hudControls = createHudControls({
    host,
    onPause: () => {
      if (sessionMode !== 'playing') return;
      if (pauseHud.isVisible()) resumeMatch();
      else pauseMatch();
    },
    onHelp: () => {
      if (sessionMode !== 'playing') return;
      sessionHud.maybeShowFirstRun();
      if (sessionHud.isFirstRunVisible()) {
        firstRunBlocking = true;
        hudControls.setHelpActive(true);
      }
    },
  });

  camera.world.sortableChildren = true;
  starfield.root.zIndex = 0;
  graphView.root.zIndex = 1;
  const cameraInput = bindCameraControls(app.canvas, camera, {
    onUserCamera: cancelFollow,
    shouldLeftPan: (e) => {
      const rect = app.canvas.getBoundingClientRect();
      const w = camera.screenToWorld(
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      return shouldLeftPan(world, w.x, w.y);
    },
    onMultiTouch: () => abortGameplay?.(),
  });

  syncMuteLabel();
  pauseHud.setFollowSend(followSendEnabled);

  const buildSurvey = (asteroid: Asteroid, hit: ResourceHit): PlanetSurvey => {
    let treesPlanted = 0;
    for (const tree of world.trees.values()) {
      if (tree.asteroidId === asteroid.id) treesPlanted += 1;
    }
    return surveyPlanet(
      asteroid,
      pocketDrainRates(world, asteroid.id),
      treesPlanted,
      hit.target === 'pocket'
        ? { target: 'pocket', pocketId: hit.pocketId }
        : hit.target === 'core'
          ? { target: 'core' }
          : null,
    );
  };

  const clearPlanetHover = () => {
    planetPanel?.hide();
    if (!hoverHit) return;
    asteroidViews.get(hoverHit.asteroidId)?.setHover(null);
    hoverHit = null;
  };

  /**
   * Planet survey on hover. Its own pointermove listener so it never
   * interferes with the gameplay click handler — this only reads.
   *
   * The panel opens for the whole rock, anywhere on the disc, and marks
   * whichever subsurface target the cursor happens to be over. That is what
   * makes the pocket orbs and the core well reachable: the player aims at a
   * planet, not at a 6-pixel orb.
   */
  const onPlanetHover = (e: PointerEvent) => {
    if (!planetPanel) return;
    if (sessionMode !== 'playing') {
      clearPlanetHover();
      return;
    }
    const rect = app.canvas.getBoundingClientRect();
    const w = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    let hit: ResourceHit | null = null;
    for (const view of asteroidViews.values()) {
      const found = view.pickResource(w.x, w.y);
      if (!found) continue;
      // A precise target beats bare crust on an overlapping neighbour, so
      // keep scanning while all we have is a body hit.
      if (found.target !== 'body') {
        hit = found;
        break;
      }
      hit ??= found;
    }
    const asteroid = hit ? world.asteroids.get(hit.asteroidId) : undefined;
    if (!hit || !asteroid) {
      clearPlanetHover();
      return;
    }
    if (hoverHit && hoverHit.asteroidId !== hit.asteroidId) {
      asteroidViews.get(hoverHit.asteroidId)?.setHover(null);
    }
    hoverHit = hit;
    asteroidViews.get(hit.asteroidId)?.setHover(hit);
    planetPanel.show(e.clientX, e.clientY, buildSurvey(asteroid, hit));
  };
  app.canvas.addEventListener('pointermove', onPlanetHover);
  app.canvas.addEventListener('pointerleave', clearPlanetHover);



  if (isFieldBoot()) {
    startSkirmish('normal', parseSeedFromHash() ?? DEFAULT_SESSION_SEED);
  } else {
    showTitle();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (sessionMode !== 'playing') return;
    // Save before the guards below: a hidden tab may never come back, and an
    // already-paused match still deserves an up-to-date save.
    captureSave();
    if (!sessionHud.endOverlay.hidden) return;
    if (pauseHud.isVisible()) return;
    pauseMatch();
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !e.repeat) {
      setMuted(audio.isEnabled());
      return;
    }
    if (sessionMode !== 'playing') return;
    if (e.code === 'F3') {
      e.preventDefault();
      if (e.repeat) return;
      debugOverlay.setVisible(!debugOverlay.isVisible());
      if (debugOverlay.isVisible()) debugOverlay.sync(world, perf);
      return;
    }
    if (e.code === 'KeyF' && !e.repeat) {
      setFollowSend(!followSendEnabled);
      return;
    }
    if (firstRunBlocking) return;
    if (status !== 'playing') return;
    if (e.code === 'Escape' && crustMenu.isVisible()) {
      e.preventDefault();
      crustMenu.hide();
      return;
    }
    if (e.code === 'Escape' || e.code === 'Space') {
      e.preventDefault();
      if (e.repeat) return;
      if (pauseHud.isVisible()) resumeMatch();
      else pauseMatch();
    }
  });

  // Keep plant-kind chips in sync when 1/2/3 keys change gameplay.plantKind.
  window.addEventListener('keydown', (e) => {
    if (!canAct()) return;
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      sessionHud.setPlantKind(gameplay.plantKind);
    }
  });

  // Where the repaint budget ran out last frame, so the trees after it get
  // their turn next time instead of the first few always winning. Without
  // this, a field too big for one frame's budget would animate its first
  // few trees and freeze the rest.
  let treeCursor = 0;
  // Reused every frame so the per-tree call does not allocate.
  const treeWork: TreeFrameBudget = { deadline: 0 };
  const TREE_WORK_NONE: TreeFrameBudget = { deadline: 0 };

  app.ticker.add((ticker) => {
    const frameDt = Math.min(0.05, ticker.deltaMS / 1000);
    perf.beginFrame(ticker.deltaMS);
    fpsSampleFrames += 1;
    const fpsNow = performance.now();
    const fpsElapsed = fpsNow - fpsSampleStarted;
    if (fpsElapsed >= FPS_SAMPLE_MS) {
      const fps = (fpsSampleFrames * 1000) / fpsElapsed;
      sessionHud.setFps(fps);
      fpsSampleFrames = 0;
      fpsSampleStarted = fpsNow;
      // Adaptive backbuffer: when the frame keeps missing its budget *and*
      // the JavaScript finishes in well under half of it, we are shading
      // more pixels than this GPU can afford. Step the resolution down once
      // — the art is soft-edged, so the loss is barely visible, and every
      // wash and gradient gets proportionally cheaper.
      const playing = sessionMode === 'playing';
      const stalling = playing && fps < DEGRADE_FPS && perf.gpuBound();
      slowSamples = stalling ? slowSamples + 1 : 0;
      fastSamples = playing && fps >= RESTORE_FPS ? fastSamples + 1 : 0;
      if (slowSamples >= DEGRADE_SAMPLES) {
        slowSamples = 0;
        fastSamples = 0;
        if (app.renderer.resolution > LOW_RESOLUTION) {
          app.renderer.resize(
            app.screen.width,
            app.screen.height,
            LOW_RESOLUTION,
          );
        }
      } else if (fastSamples >= RESTORE_SAMPLES) {
        // The degrade used to be permanent: one hitch during worldgen cost
        // the session its resolution until reload. Climb back once the
        // frame has been comfortably inside budget for ~10 s.
        fastSamples = 0;
        if (app.renderer.resolution < maxResolution) {
          app.renderer.resize(
            app.screen.width,
            app.screen.height,
            maxResolution,
          );
        }
      }
    }
    cameraInput.tick(frameDt);
    // The hue/theme cycle is the largest ambient motion on screen; freezing
    // palTime holds the whole palette and starfield still.
    if (!getVisualPrefs().reducedMotion) palTime += frameDt;

    if (
      sessionMode === 'playing' &&
      !paused &&
      !firstRunBlocking &&
      status === 'playing'
    ) {
      acc += frameDt;
      perf.start('sim');
      while (acc >= SIM_DT) {
        const before = combatSnap;
        tick(world, SIM_DT);
        tickAi(world, SIM_DT);
        tickMatchRuntime(world, matchConfig, matchRuntime, SIM_DT);
        const combat = playCombatSfx(audio, before, world, combatSnapB, panAt);
        combatSnap = combat.snap;
        if (combat.fighting) combatHeat = 1;
        combatSnapB = before;
        simTick += 1;
        acc -= SIM_DT;
      }
      perf.stop();

      // Autosave. Skipped while the first-run overlay blocks play, since
      // nothing has happened yet worth writing.
      if (!firstRunBlocking) {
        saveAcc += frameDt;
        if (saveAcc >= AUTOSAVE_SECONDS) {
          saveAcc = 0;
          captureSave();
        }
      }

      const next = matchStatus(world, matchConfig, matchRuntime);
      if (next !== 'playing') {
        status = next;
        paused = false;
        pauseHud.hide();
        // The match is over; there is nothing left to resume.
        clearSave();
        const isLastCampaign =
          playMode === 'campaign' &&
          next === 'won' &&
          campaignIndex >= CAMPAIGN_MAPS.length - 1;
        if (next === 'won' && playMode === 'campaign' && !isLastCampaign) {
          writeCampaignIndex(campaignIndex + 1);
        }
        crustMenu.hide();
        sessionHud.showEnd({
          outcome: next,
          mode: playMode,
          mapTitle: campaignTitle || undefined,
          showNext:
            playMode === 'campaign' && next === 'won' && !isLastCampaign,
          campaignComplete: isLastCampaign,
        });
        if (next === 'won') audio.win();
        else audio.lose();
      }
    }

    if (sessionMode !== 'playing') {
      starfield.setParallax(camera.x, camera.y);
      starfield.tick(ticker.lastTime * 0.001);
      perf.endFrame();
      return;
    }

    if (treeViewsStale()) syncTrees();

    const playerOrbit = new Map<number, number>();
    for (const s of world.seedlings.values()) {
      if (s.faction !== 'player' || s.state !== 'orbit') continue;
      playerOrbit.set(s.asteroidId, (playerOrbit.get(s.asteroidId) ?? 0) + 1);
    }

    const treesByRock = new Map<number, Tree[]>();
    for (const tree of world.trees.values()) {
      const list = treesByRock.get(tree.asteroidId);
      if (list) list.push(tree);
      else treesByRock.set(tree.asteroidId, [tree]);
    }

    // The scene hue drifts continuously, but a repaint only earns its keep
    // when the 1° hue bucket (or the theme crossfade) actually moves —
    // roughly twice a second. Everything below used to run every frame, and
    // most of it was pure overhead at 60 Hz: a Text style write per rock
    // (which re-rasterizes the label), seven CSS custom properties on :root
    // (which invalidates the whole HUD's style), plus a retheme call per
    // view. Gate the lot on the palette key, then hand the per-view repaints
    // to a queue so one bucket step never repaints the field in one frame.
    perf.start('palette');
    writeScene(scene, sceneAtTime(world.seed, palTime));
    const themes = themeAt(world.seed, palTime);
    const paletteKey = `${bucketHue(scene.hue)}|${themes.themeA}|${themes.themeB}|${Math.round(themes.mix * 32)}`;
    if (paletteKey !== lastPaletteKey) {
      lastPaletteKey = paletteKey;
      const hueKey = Math.round(scene.hue);
      if (hueKey !== lastHueKey) {
        lastHueKey = hueKey;
        audio.setAtmosphere(scene.hue, scene.dark);
      }
      applySceneToDocument(scene);
      app.renderer.background.color = scene.bg;
      starfield.retheme(scene, themes.themeA, themes.themeB, themes.mix);
      seedlings?.retheme(scene);
      preview.retheme();
      graphView.retheme(scene);
      minimap?.retheme(scene);
      for (const id of asteroidViews.keys()) rockRepaints.add(id);
      for (const id of treeViews.keys()) treeRepaints.add(id);
    }
    perf.stop();

    let playerRocks = 0;
    for (const a of world.asteroids.values()) {
      if (a.owner === 'player') playerRocks += 1;
      const prev = lastOwners.get(a.id);
      if (prev !== a.owner) {
        lastOwners.set(a.id, a.owner);
        if (a.owner === 'player') audio.capture(panAt(a.x));
      }
    }

    // Feed the soundtrack. A contested field (neither side dominant) plus
    // recent fighting is what "hot" means here — a runaway win is calm, not
    // exciting. Twice a second is plenty; the engine ignores small deltas.
    combatHeat = Math.max(0, combatHeat - frameDt * 0.35);
    audioSyncAcc += frameDt;
    if (audioSyncAcc >= 0.5) {
      audioSyncAcc = 0;
      const rocks = world.asteroids.size;
      const share = rocks > 0 ? playerRocks / rocks : 0;
      const contested = 1 - Math.abs(share * 2 - 1);
      audio.setIntensity(0.12 + 0.4 * contested + 0.48 * combatHeat);
    }

    graphView.sync(world, gameplay.selectedAsteroidId);

    const viewW = app.screen.width;
    const viewH = app.screen.height;
    const viewBox: ViewBox = {
      camX: camera.x,
      camY: camera.y,
      zoom: camera.zoom,
      w: viewW,
      h: viewH,
    };
    perf.start('rocks');
    let rockBudget = ROCK_REPAINTS_PER_FRAME;
    for (const a of world.asteroids.values()) {
      const view = asteroidViews.get(a.id);
      if (!view) continue;
      const on = inView(a.x, a.y, a.radius, viewBox);
      view.root.visible = on;
      view.pollenRoot.visible = on;
      // Off-screen rocks stay queued: nobody can see their stale colors, and
      // they repaint on the frame they scroll back in.
      if (!on) continue;
      const selected = a.id === gameplay.selectedAsteroidId;
      const localTrees = treesByRock.get(a.id);
      if (rockBudget > 0 && rockRepaints.delete(a.id)) {
        rockBudget -= 1;
        view.retheme(a, scene, selected, EMPTY_PLANTABLE, localTrees);
      }
      view.update(a, selected, EMPTY_PLANTABLE, localTrees);
    }
    perf.stop();

    const seedlingsArr = [...world.seedlings.values()];
    // One hash for the whole field: every tree view compares against the
    // same number instead of rescanning the seedling array itself.
    const departureSig = seedlingDepartureSignature(seedlingsArr);

    perf.start('trees');
    let treeBudget = TREE_REPAINTS_PER_FRAME;
    treeWork.deadline = performance.now() + TREE_REPAINT_BUDGET_MS;
    let visibleTrees = 0;
    let served = 0;
    for (const [id, view] of treeViews) {
      const tree = world.trees.get(id);
      if (!tree) continue;
      const asteroid = world.asteroids.get(tree.asteroidId);
      if (!asteroid) continue;
      const on = inView(asteroid.x, asteroid.y, asteroid.radius, viewBox);
      view.canopy.visible = on;
      view.roots.visible = on;
      if (!on) continue;
      // A retheme is a full geometry repaint, so it comes out of the same
      // frame allowance as everything else the grove wants to redraw. A tree
      // that misses out is left in `treeRepaints` and recolours on a later
      // frame — the check runs before the first repaint, so at least one
      // always gets through and the queue cannot stall.
      if (
        treeBudget > 0 &&
        performance.now() < treeWork.deadline &&
        treeRepaints.delete(id)
      ) {
        treeBudget -= 1;
        view.retheme(tree, asteroid, scene);
      }
      // Trees ahead of the cursor already had their turn on an earlier frame.
      const turn = visibleTrees >= treeCursor;
      visibleTrees += 1;
      if (view.update(tree, asteroid, turn ? treeWork : TREE_WORK_NONE)) {
        served += 1;
      }
      view.setDepartingSeedlings(seedlingsArr, tree, asteroid, departureSig);
    }
    // Wrap once the cursor has walked past the last visible tree.
    treeCursor = served > 0 ? treeCursor + served : 0;
    if (treeCursor >= visibleTrees) treeCursor = 0;
    perf.stop();

    perf.start('seedlings');
    seedlings?.sync(world.seedlings, frameDt, viewBox);
    perf.stop();

    if (followingSend) {
      const center = travelCentroid(world, 'player');
      if (!center) {
        followingSend = false;
      } else {
        const t = 1 - Math.exp(-3.2 * frameDt);
        camera.followToward(
          center.x,
          center.y,
          app.screen.width,
          app.screen.height,
          t,
        );
      }
    }

    starfield.setParallax(camera.x, camera.y);
    starfield.tick(ticker.lastTime * 0.001);

    const selId = gameplay.selectedAsteroidId;
    const local = selId !== null ? (playerOrbit.get(selId) ?? 0) : 0;
    const sentinels = selId !== null
      ? countOrbitingKind(world, selId, 'player', 'sentinel')
      : 0;
    hudAcc += frameDt;
    perf.start('hud');
    const hudKey = `${selId}:${gameplay.dragging}:${gameplay.plantKind}:${gameplay.sendMode}:${gameplay.sendCount}:${local}`;
    if (hudAcc >= 0.12 || hudKey !== lastHudKey) {
      hudAcc = 0;
      lastHudKey = hudKey;
      sessionHud.sync(
        world,
        selId,
        local,
        sentinels,
        gameplay.plantKind,
        gameplay.dragging,
        gameplay.sendCount,
        gameplay.sendMode,
      );
      factionPlate.sync(world, selId);
      minimap?.sync(world, viewBox);
      if (!sessionHud.isFirstRunVisible()) hudControls.setHelpActive(false);
      if (debugOverlay.isVisible()) {
        debugAcc += frameDt;
        if (debugAcc >= 0.25) {
          debugAcc = 0;
          debugOverlay.sync(world, perf);
        }
      }
    }
    perf.stop();
    perf.endFrame();
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.textContent = String(err);
});
