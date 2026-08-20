/**
 * Corner minimap for large maps.
 *
 * A DOM `<canvas>`, not a Pixi container on `app.stage`, for three reasons:
 *
 * 1. Hit-testing here is DOM-based (`isHudControlTarget` in
 *    `input/cameraControls.ts`). A Pixi overlay's pointer target is the game
 *    canvas, so edge-scroll and empty-space pan would fire straight through
 *    the widget; keeping it in the DOM reuses the guard every other HUD
 *    control already gets.
 * 2. `app.stage` is under adaptive `renderer.resize(..., LOW_RESOLUTION)` and
 *    the camera's z-ordering; a stage overlay would have to opt out of both.
 * 3. It repaints on the HUD's ~8 Hz cadence instead of Pixi's per-frame path,
 *    which keeps it off the renderer hot path entirely.
 *
 * All geometry lives in `render/minimapGeom.ts` so the transform is tested
 * without a DOM; this file is the canvas and the pointer wiring.
 */

import {
  fitTransform,
  mapPoint,
  unmapPoint,
  viewRectOn,
  worldBounds,
  type FitTransform,
} from '../render/minimapGeom';
import { cssHex, FACTION_MARK, type ScenePalette } from '../render/palette';
import { getVisualPrefs } from '../render/visualPrefs';
import type { ViewBox } from '../render/viewport';
import type { FactionId, World } from '../sim/types';
import { observeHudBarOffset } from './hudBarOffset';

/**
 * Below this many rocks the field fits on screen at the default zoom and a
 * minimap is just clutter. The roadmap asks for one at 25+; skirmish maps run
 * 14–20, so this shows it for the big authored maps and hides it otherwise.
 */
export const MINIMAP_MIN_ROCKS = 18;

const WIDTH = 168;
const HEIGHT = 124;
const PAD = 7;
/** Rock dot radius in minimap px, before the per-rock size nudge. */
const DOT_MIN = 1.6;
const DOT_MAX = 3.4;

export interface MinimapHud {
  root: HTMLDivElement;
  /** Player preference — off hides the widget outright. */
  setEnabled(enabled: boolean): void;
  /** Session state — hidden on the title screen. */
  setVisible(visible: boolean): void;
  retheme(scene: ScenePalette): void;
  sync(world: World, view: ViewBox): void;
  destroy(): void;
}

export function createMinimapHud(opts: {
  host: HTMLElement;
  scene: ScenePalette;
  /** The bottom bar, so the widget stacks clear of it when it wraps. */
  anchor?: HTMLElement | null;
  onRecenter: (worldX: number, worldY: number) => void;
}): MinimapHud {
  const root = document.createElement('div');
  root.className = 'hud-minimap';
  root.hidden = true;

  const canvas = document.createElement('canvas');
  canvas.className = 'hud-minimap-canvas';
  canvas.setAttribute('aria-label', 'Map overview');
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(WIDTH * dpr);
  canvas.height = Math.round(HEIGHT * dpr);
  canvas.style.width = `${WIDTH}px`;
  canvas.style.height = `${HEIGHT}px`;
  root.appendChild(canvas);
  opts.host.appendChild(root);

  const ctx = canvas.getContext('2d');
  ctx?.scale(dpr, dpr);

  const offset = observeHudBarOffset(opts.anchor, (px) => {
    root.style.setProperty('--ab-minimap-bottom', `${px}px`);
  });

  let scene = opts.scene;
  let enabled = true;
  let visible = false;
  let bigEnough = false;
  /** Rocks never move, so the fit is recomputed only when the field changes. */
  let transform: FitTransform | null = null;
  let boundsKey = '';

  const applyHidden = () => {
    root.hidden = !(enabled && visible && bigEnough);
    offset.refresh();
  };

  const colorFor = (owner: FactionId): string => {
    if (owner === 'player') return cssHex(scene.ink);
    if (owner === 'enemy') return cssHex(scene.dust);
    if (owner === 'grey') return cssHex(scene.mist);
    return cssHex(scene.mist);
  };

  /**
   * Owner glyphs when the faction-marks pref is on: at this size a shape
   * reads where a hue does not. Square = you, triangle = enemy, circle = wild,
   * matching the `FACTION_MARK` vocabulary used on hulls and rocks.
   */
  const drawRock = (
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    owner: FactionId,
    marks: boolean,
  ) => {
    c.beginPath();
    if (!marks || FACTION_MARK[owner] === 'none') {
      c.arc(x, y, r, 0, Math.PI * 2);
    } else if (FACTION_MARK[owner] === 'bar') {
      c.rect(x - r, y - r, r * 2, r * 2);
    } else if (FACTION_MARK[owner] === 'chevron') {
      c.moveTo(x, y - r * 1.2);
      c.lineTo(x + r * 1.1, y + r * 0.9);
      c.lineTo(x - r * 1.1, y + r * 0.9);
      c.closePath();
    } else {
      c.arc(x, y, r, 0, Math.PI * 2);
    }
    c.fill();
  };

  const draw = (world: World, view: ViewBox) => {
    if (!ctx || root.hidden) return;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // Field backdrop — a wash, so the widget reads as a panel not a hole.
    ctx.fillStyle = cssHex(scene.bg);
    ctx.globalAlpha = 0.55;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.globalAlpha = 1;

    if (!transform) return;
    const marks = getVisualPrefs().factionMarks;

    let maxRadius = 1;
    for (const a of world.asteroids.values()) {
      if (a.radius > maxRadius) maxRadius = a.radius;
    }

    for (const a of world.asteroids.values()) {
      const p = mapPoint(transform, a.x, a.y);
      // Bigger rocks read bigger, but the range is deliberately narrow: this
      // is a position readout, not a scale model.
      const t = Math.min(1, a.radius / maxRadius);
      const r = DOT_MIN + (DOT_MAX - DOT_MIN) * t;
      ctx.fillStyle = colorFor(a.owner);
      ctx.globalAlpha = a.owner === 'neutral' ? 0.45 : 0.9;
      drawRock(ctx, p.x, p.y, r, a.owner, marks);
    }
    ctx.globalAlpha = 1;

    // Camera frustum, clipped to the widget so a zoomed-out view still shows
    // an edge the player can grab.
    const rect = viewRectOn(transform, view);
    ctx.strokeStyle = cssHex(scene.ink);
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(rect.x) + 0.5,
      Math.round(rect.y) + 0.5,
      Math.max(2, Math.round(rect.w)),
      Math.max(2, Math.round(rect.h)),
    );
    ctx.globalAlpha = 1;
  };

  const recenterFrom = (clientX: number, clientY: number) => {
    if (!transform) return;
    const r = canvas.getBoundingClientRect();
    const p = unmapPoint(transform, clientX - r.left, clientY - r.top);
    opts.onRecenter(p.x, p.y);
  };

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);
    recenterFrom(e.clientX, e.clientY);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!canvas.hasPointerCapture(e.pointerId)) return;
    e.preventDefault();
    recenterFrom(e.clientX, e.clientY);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  return {
    root,

    setEnabled(next) {
      enabled = next;
      applyHidden();
    },

    setVisible(next) {
      visible = next;
      applyHidden();
    },

    retheme(next) {
      scene = next;
    },

    sync(world, view) {
      const rocks = world.asteroids.size;
      const wasBigEnough = bigEnough;
      bigEnough = rocks >= MINIMAP_MIN_ROCKS;
      if (bigEnough !== wasBigEnough) applyHidden();
      if (root.hidden) return;

      // Rocks are static for a whole match, so the fit is computed once and
      // only rebuilt when the field itself changes.
      const key = `${world.seed}:${rocks}`;
      if (key !== boundsKey) {
        boundsKey = key;
        const b = worldBounds(world.asteroids.values());
        transform = b ? fitTransform(b, WIDTH, HEIGHT, PAD) : null;
      }
      draw(world, view);
    },

    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      offset.destroy();
      root.remove();
    },
  };
}
