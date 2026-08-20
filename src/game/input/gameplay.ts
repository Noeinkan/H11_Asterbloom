import type { GameAudio } from '../audio/audio';
import type { Camera } from '../render/camera';
import type { SendPreview } from '../render/sendPreview';
import {
  countFactionOrbiting,
  plantOnCrustAngle,
  sendSeedlings,
  type CommandResult,
} from '../sim/commands';
import { shortestPath } from '../sim/graph';
import { hitRockCrust } from '../sim/rock';
import { orbitBand, type TreeKind, type World } from '../sim/types';
import {
  bumpSendCount,
  countFromDialAngle,
  isCoarsePointer,
  resolveSendCount,
  type SendMode,
} from './sendCount';

export type { SendMode };

export interface GameplayState {
  selectedAsteroidId: number | null;
  sendCount: number;
  sendMode: SendMode;
  dragging: boolean;
  dragFromId: number | null;
  hoverTargetId: number | null;
  cursorWorld: { x: number; y: number };
  plantKind: TreeKind;
}

export function createGameplayState(homeId: number): GameplayState {
  return {
    selectedAsteroidId: homeId,
    sendCount: 0,
    sendMode: 'all',
    dragging: false,
    dragFromId: null,
    hoverTargetId: null,
    cursorWorld: { x: 0, y: 0 },
    plantKind: 'dyson',
  };
}

const DRAG_THRESHOLD = 8;
const FINE_ASTEROID_PAD = 28;
const COARSE_ASTEROID_PAD = 48;
const FINE_CRUST_HIT = 22;
const COARSE_CRUST_HIT = 36;
const HOLD_MS = 480;

/**
 * What the player asked for, alongside what the command returned. The replay
 * log records the request rather than the outcome, so this carries the crust
 * bearing rather than the slot the command happened to pick.
 */
export type PlayerIntent =
  | { kind: 'send'; fromId: number; toId: number; count: number }
  | { kind: 'plant'; asteroidId: number; angle: number; treeKind: TreeKind };

export interface CrustMenuHit {
  asteroidId: number;
  angle: number;
  screenX: number;
  screenY: number;
}

export function plantOnCrust(
  world: World,
  state: GameplayState,
  asteroidId: number,
  angle: number,
): CommandResult {
  return plantOnCrustAngle(world, asteroidId, angle, 'player', state.plantKind);
}

export function bindGameplay(opts: {
  canvas: HTMLCanvasElement;
  camera: Camera;
  world: World;
  state: GameplayState;
  preview: SendPreview;
  audio: GameAudio;
  /** Fired for every plant/send attempt (success or failure). */
  onCommand?: (result: CommandResult, intent: PlayerIntent) => void;
  /** Fired after a successful player send (optional follow-send). */
  onSend?: () => void;
  /** When false, ignore send / plant / selection gestures. */
  canAct?: () => boolean;
  /** Called when send count / mode changes (HUD dock). */
  onSendCountChange?: () => void;
  /** Right-click or hold on the crust — open the plant menu. */
  onCrustMenu?: (hit: CrustMenuHit) => void;
}): { unbind: () => void; abort: () => void } {
  const {
    canvas,
    camera,
    world,
    state,
    preview,
    audio,
    onCommand,
    onSend,
    canAct = () => true,
    onSendCountChange,
    onCrustMenu,
  } = opts;

  let pointerDown = false;
  let activePointerId: number | null = null;
  let downX = 0;
  let downY = 0;
  let downWorld = { x: 0, y: 0 };
  let shiftOnDown = false;
  let didDrag = false;
  let aborted = false;
  let holdTimer: number | null = null;
  let rightDown = false;
  let rightDidDrag = false;
  let rightCrust: { asteroidId: number; angle: number } | null = null;

  const coarse = () => isCoarsePointer();

  const orbitCount = (asteroidId: number) =>
    countFactionOrbiting(world, asteroidId, 'player');

  const applySendForRock = (fromId: number, forceScout: boolean) => {
    const n = orbitCount(fromId);
    if (forceScout) {
      state.sendMode = 'scout';
      state.sendCount = resolveSendCount(n, 'scout', 1);
    } else if (state.sendMode === 'precise') {
      // Preserve the exact count the player already dialed in. Clamped to
      // whatever the source asteroid can actually muster.
      state.sendCount = resolveSendCount(n, 'precise', state.sendCount);
    } else {
      state.sendCount = resolveSendCount(n, state.sendMode, state.sendCount);
    }
    onSendCountChange?.();
  };

  const hitAsteroid = (wx: number, wy: number): number | null => {
    const pad = coarse() ? COARSE_ASTEROID_PAD : FINE_ASTEROID_PAD;
    let best: number | null = null;
    let bestDist = Infinity;
    for (const a of world.asteroids.values()) {
      const d = Math.hypot(wx - a.x, wy - a.y);
      // Include the orbit band so clicking seedlings still selects the rock
      if (d <= a.radius + orbitBand(a.radius) + pad && d < bestDist) {
        bestDist = d;
        best = a.id;
      }
    }
    return best;
  };

  const hitCrust = (wx: number, wy: number) => {
    const hit = hitRockCrust(
      world.asteroids.values(),
      wx,
      wy,
      coarse() ? COARSE_CRUST_HIT : FINE_CRUST_HIT,
    );
    return hit ? { asteroidId: hit.id, angle: hit.angle } : null;
  };

  const clearHold = () => {
    if (holdTimer !== null) {
      window.clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const openCrustMenu = (
    hit: { asteroidId: number; angle: number },
    screenX: number,
    screenY: number,
  ) => {
    onCrustMenu?.({
      asteroidId: hit.asteroidId,
      angle: hit.angle,
      screenX,
      screenY,
    });
  };

  const worldFromEvent = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  };

  /** Where the gesture happened, as a softened stereo position. */
  const panFromEvent = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const t = (e.clientX - rect.left) / rect.width;
    return Math.max(-1, Math.min(1, t * 2 - 1)) * 0.7;
  };

  const clearGesture = () => {
    clearHold();
    pointerDown = false;
    activePointerId = null;
    didDrag = false;
    aborted = false;
    state.dragging = false;
    state.dragFromId = null;
    state.hoverTargetId = null;
    preview.hide();
  };

  const abortGesture = () => {
    if (!pointerDown && !state.dragging) return;
    aborted = true;
    clearGesture();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) {
      if (!canAct()) return;
      rightDown = true;
      rightDidDrag = false;
      downX = e.clientX;
      downY = e.clientY;
      const w = worldFromEvent(e);
      rightCrust = hitCrust(w.x, w.y);
      return;
    }
    if (e.button !== 0) return;
    if (!canAct()) return;

    // Second finger: abort send so camera pinch can take over.
    if (pointerDown && activePointerId !== null && e.pointerId !== activePointerId) {
      abortGesture();
      return;
    }

    pointerDown = true;
    activePointerId = e.pointerId;
    didDrag = false;
    aborted = false;
    downX = e.clientX;
    downY = e.clientY;
    downWorld = worldFromEvent(e);
    state.cursorWorld = downWorld;
    shiftOnDown = e.shiftKey;

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    const crust = hitCrust(downWorld.x, downWorld.y);
    if (crust) {
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        if (!pointerDown || didDrag || !canAct()) return;
        abortGesture();
        openCrustMenu(crust, downX, downY);
      }, HOLD_MS);
    }

    const hit = hitAsteroid(downWorld.x, downWorld.y);
    if (hit !== null) {
      state.selectedAsteroidId = hit;
      state.dragFromId = hit;
      applySendForRock(hit, shiftOnDown);
    }
    // Empty space: camera pans (shouldLeftPan). Do not start a send.
  };

  const onPointerMove = (e: PointerEvent) => {
    if (rightDown && !rightDidDrag) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) >= DRAG_THRESHOLD) {
        rightDidDrag = true;
      }
    }
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    const w = worldFromEvent(e);
    state.cursorWorld = w;
    if (!pointerDown || aborted || !canAct()) return;

    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (dist >= DRAG_THRESHOLD) clearHold();
    if (!didDrag && dist >= DRAG_THRESHOLD && state.dragFromId !== null) {
      didDrag = true;
      state.dragging = true;
      applySendForRock(state.dragFromId, shiftOnDown);
    }

    if (state.dragging && state.dragFromId !== null) {
      const target = hitAsteroid(w.x, w.y);
      state.hoverTargetId =
        target !== null && target !== state.dragFromId ? target : null;
      const from = world.asteroids.get(state.dragFromId)!;
      const path =
        state.hoverTargetId !== null
          ? shortestPath(world, state.dragFromId, state.hoverTargetId)
          : null;
      const valid = !!path && path.length >= 2 && state.sendCount > 0;

      // Precise-send dial: while hovering the destination asteroid (or
      // within a small slack around its rim), the cursor angle around the
      // target sets the exact count to send. Switching to precise mode
      // also flips the dock's highlight so the player sees they are no
      // longer in scout / all / half.
      const dest =
        state.hoverTargetId !== null
          ? world.asteroids.get(state.hoverTargetId) ?? null
          : null;
      const dialActive =
        dest !== null &&
        (state.sendMode === 'precise' ||
          Math.hypot(w.x - dest.x, w.y - dest.y) <= dest.radius + 14);
      if (dialActive && dest !== null) {
        const max = orbitCount(state.dragFromId);
        if (max > 0) {
          const angle = Math.atan2(w.y - dest.y, w.x - dest.x);
          state.sendCount = countFromDialAngle(max, angle);
          state.sendMode = 'precise';
          onSendCountChange?.();
        }
      }

      const toX = dest !== null ? dest.x : w.x;
      const toY = dest !== null ? dest.y : w.y;
      const finalValid = valid && state.sendCount > 0;
      preview.show(
        from.x,
        from.y,
        toX,
        toY,
        state.sendCount,
        finalValid,
        state.sendMode === 'precise' && dialActive,
        orbitCount(state.dragFromId),
      );
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.button === 2) {
      const crust = rightCrust;
      const dragged = rightDidDrag;
      rightDown = false;
      rightDidDrag = false;
      rightCrust = null;
      if (!dragged && crust && canAct()) {
        openCrustMenu(crust, e.clientX, e.clientY);
      }
      return;
    }
    if (e.button !== 0) return;
    if (activePointerId !== null && e.pointerId !== activePointerId) return;

    const wasAborted = aborted;
    const wasDragging = didDrag && state.dragging;
    const fromId = state.dragFromId;
    const toId = state.hoverTargetId;
    const sendN = state.sendCount;

    if (!wasAborted && canAct()) {
      if (!didDrag) {
        const w = worldFromEvent(e);
        const hit = hitAsteroid(w.x, w.y);
        if (hit !== null) {
          state.selectedAsteroidId = hit;
          applySendForRock(hit, false);
        }
      } else if (wasDragging && fromId !== null && toId !== null) {
        const result = sendSeedlings(world, fromId, toId, sendN, 'player');
        onCommand?.(result, {
          kind: 'send',
          fromId,
          toId,
          count: sendN,
        });
        if (result.ok) {
          audio.send(sendN, panFromEvent(e));
          onSend?.();
        } else audio.fail(panFromEvent(e));
      }
    }

    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    clearGesture();
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    abortGesture();
  };

  const onWheel = (e: WheelEvent) => {
    if (!canAct() || !state.dragging || state.dragFromId === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const max = orbitCount(state.dragFromId);
    if (max < 1) {
      state.sendCount = 0;
      state.sendMode = 'fixed';
      onSendCountChange?.();
      return;
    }
    const delta = e.deltaY < 0 ? 1 : -1;
    state.sendMode = 'fixed';
    state.sendCount = bumpSendCount(max, state.sendCount, delta);
    onSendCountChange?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!canAct()) return;
    if (e.key === '1') state.plantKind = 'dyson';
    else if (e.key === '2') state.plantKind = 'energy';
    else if (e.key === '3') state.plantKind = 'defense';
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });

  window.addEventListener('keydown', onKeyDown);

  const unbind = () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('keydown', onKeyDown);
  };

  return { unbind, abort: abortGesture };
}

/** True when a left press on empty space should pan the camera. */
export function shouldLeftPan(
  world: World,
  wx: number,
  wy: number,
): boolean {
  const pad = isCoarsePointer() ? COARSE_ASTEROID_PAD : FINE_ASTEROID_PAD;
  for (const a of world.asteroids.values()) {
    const d = Math.hypot(wx - a.x, wy - a.y);
    if (d <= a.radius + orbitBand(a.radius) + pad) return false;
  }
  return true;
}
