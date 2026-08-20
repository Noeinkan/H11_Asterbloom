import type { Camera } from '../render/camera';
import { edgeScrollAxes } from './edgeScroll';
import { isCoarsePointer } from './sendCount';
import { wheelZoomFactor } from './wheelZoom';

type PointerSample = { x: number; y: number };

/** True when the event target is a clickable HUD/overlay control. */
function isHudControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, [role="button"], .end-overlay, .pause-overlay, .title-overlay, .first-run-overlay, .crust-menu, .hud-minimap',
    ),
  );
}

export function bindCameraControls(
  canvas: HTMLCanvasElement,
  camera: Camera,
  opts?: {
    onUserCamera?: () => void;
    /** When true, left button on this down may start one-finger pan (coarse). */
    shouldLeftPan?: (e: PointerEvent) => boolean;
    /** Abort gameplay send when multi-touch starts. */
    onMultiTouch?: () => void;
  },
): { tick: (dt: number) => void; unbind: () => void } {
  const keys = new Set<string>();
  const pointers = new Map<number, PointerSample>();
  let buttonPan = false;
  let rightPanPending = false;
  let lastX = 0;
  let lastY = 0;
  let pinchDist = 0;
  let pinchMidX = 0;
  let pinchMidY = 0;
  let lastCanvasX = 0;
  let lastCanvasY = 0;
  let pointerOverView = false;
  let pointerOnHud = false;
  let velX = 0;
  let velY = 0;
  let lastMoveAt = 0;
  let coasting = false;
  const onUserCamera = opts?.onUserCamera;

  const stopCoast = () => {
    coasting = false;
    velX = 0;
    velY = 0;
  };

  const twoFingerMetrics = () => {
    const pts = [...pointers.values()];
    if (pts.length < 2) return null;
    const a = pts[0]!;
    const b = pts[1]!;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    return { midX, midY, dist };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
    if (factor === 1) return;
    camera.zoomAt(sx, sy, factor, true);
    stopCoast();
    onUserCamera?.();
  };

  const onPointerDown = (e: PointerEvent) => {
    const pos = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, pos);
    stopCoast();

    if (pointers.size === 2) {
      opts?.onMultiTouch?.();
      buttonPan = false;
      const m = twoFingerMetrics();
      if (m) {
        pinchDist = m.dist;
        pinchMidX = m.midX;
        pinchMidY = m.midY;
      }
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }

    // Middle — pan immediately. Right — wait for a drag so a click can open menus.
    if (e.button === 1) {
      buttonPan = true;
      lastX = e.clientX;
      lastY = e.clientY;
      lastMoveAt = performance.now();
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 2) {
      rightPanPending = true;
      lastX = e.clientX;
      lastY = e.clientY;
      lastMoveAt = performance.now();
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // Left: pan empty space (mouse and touch). Send still starts on a rock.
    if (e.button === 0 && opts?.shouldLeftPan?.(e)) {
      buttonPan = true;
      lastX = e.clientX;
      lastY = e.clientY;
      lastMoveAt = performance.now();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const m = twoFingerMetrics();
      if (!m) return;
      const dx = m.midX - pinchMidX;
      const dy = m.midY - pinchMidY;
      if (dx || dy) {
        camera.pan(dx, dy);
        onUserCamera?.();
      }
      if (pinchDist > 8 && m.dist > 8) {
        const factor = m.dist / pinchDist;
        if (factor > 0.01 && factor < 100) {
          const rect = canvas.getBoundingClientRect();
          camera.zoomAt(m.midX - rect.left, m.midY - rect.top, factor, true);
          onUserCamera?.();
        }
      }
      pinchDist = m.dist;
      pinchMidX = m.midX;
      pinchMidY = m.midY;
      return;
    }

    if (rightPanPending && !buttonPan) {
      const dist = Math.hypot(e.clientX - lastX, e.clientY - lastY);
      if (dist < 8) return;
      buttonPan = true;
      rightPanPending = false;
    }
    if (!buttonPan) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    const now = performance.now();
    const moveDt = Math.max(0.001, (now - lastMoveAt) / 1000);
    lastMoveAt = now;
    velX = dx / moveDt;
    velY = dy / moveDt;
    camera.pan(dx, dy);
    onUserCamera?.();
  };

  const onPointerUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      pinchDist = 0;
    }
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0]!;
      lastX = remaining.x;
      lastY = remaining.y;
      if (e.button === 0) buttonPan = false;
    }
    if (pointers.size === 0) {
      const flung =
        buttonPan &&
        performance.now() - lastMoveAt < 80 &&
        Math.hypot(velX, velY) > 420;
      buttonPan = false;
      rightPanPending = false;
      coasting = flung;
      if (!flung) stopCoast();
    }
    if (e.button === 1 || e.button === 2) {
      if (pointers.size === 0) {
        buttonPan = false;
        rightPanPending = false;
      }
    }
  };

  const onContextMenu = (e: Event) => e.preventDefault();

  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.key.toLowerCase());
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.key.toLowerCase());
  };

  const onWindowPointerMove = (e: PointerEvent) => {
    if (isCoarsePointer()) {
      pointerOverView = false;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    lastCanvasX = e.clientX - rect.left;
    lastCanvasY = e.clientY - rect.top;
    pointerOverView = true;
    pointerOnHud = isHudControlTarget(e.target);
  };

  const clearEdgePointer = () => {
    pointerOverView = false;
  };

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pointermove', onWindowPointerMove);
  window.addEventListener('blur', clearEdgePointer);
  document.documentElement.addEventListener('pointerleave', clearEdgePointer);

  const panSpeed = 980;
  let glideX = 0;
  let glideY = 0;

  const tick = (dt: number) => {
    camera.tick(dt);
    let dx = 0;
    let dy = 0;
    if (keys.has('a') || keys.has('arrowleft')) dx += 1;
    if (keys.has('d') || keys.has('arrowright')) dx -= 1;
    if (keys.has('w') || keys.has('arrowup')) dy += 1;
    if (keys.has('s') || keys.has('arrowdown')) dy -= 1;

    const edgeOk =
      pointerOverView &&
      !pointerOnHud &&
      !buttonPan &&
      pointers.size < 2 &&
      !isCoarsePointer();
    if (edgeOk) {
      const rect = canvas.getBoundingClientRect();
      const edge = edgeScrollAxes(
        lastCanvasX,
        lastCanvasY,
        rect.width,
        rect.height,
      );
      dx += edge.dx;
      dy += edge.dy;
    }

    const len = Math.hypot(dx, dy);
    const mag = len > 0 ? Math.min(1, len) : 0;
    const tx = len > 0 ? (dx / len) * mag * panSpeed : 0;
    const ty = len > 0 ? (dy / len) * mag * panSpeed : 0;
    const ease = 1 - Math.exp(-22 * dt);
    glideX += (tx - glideX) * ease;
    glideY += (ty - glideY) * ease;
    if (Math.hypot(glideX, glideY) < 8) {
      glideX = 0;
      glideY = 0;
    }

    if (glideX || glideY) {
      stopCoast();
      camera.pan(glideX * dt, glideY * dt);
      onUserCamera?.();
    } else if (coasting && !buttonPan) {
      camera.pan(velX * dt, velY * dt);
      const damp = Math.exp(-9 * dt);
      velX *= damp;
      velY *= damp;
      if (Math.hypot(velX, velY) < 28) stopCoast();
      else onUserCamera?.();
    }
  };

  return {
    tick,
    unbind: () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('blur', clearEdgePointer);
      document.documentElement.removeEventListener(
        'pointerleave',
        clearEdgePointer,
      );
    },
  };
}
