/**
 * Minimap geometry — pure, DOM-free, Pixi-free.
 *
 * The world has no stored extent: rocks are placed by `layout.ts` and nothing
 * records the bounding box, so the minimap derives it from the rocks
 * themselves. Rocks never move, so a caller can compute bounds once per match.
 *
 * The forward transform mirrors `viewport.ts` (`sx = x * zoom + camX`); the
 * camera rectangle drawn on the minimap is that transform inverted, then
 * mapped through the minimap fit. Keeping both in one tested module is what
 * stops the view rect from drifting out of step with what is actually on
 * screen.
 */

import type { Asteroid } from '../sim/types';
import type { ViewBox } from './viewport';

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FitTransform {
  /** Uniform world→minimap scale; the same on both axes, so nothing skews. */
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface MinimapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A span this small is treated as a point. Guards the degenerate cases —
 * one rock, or every rock stacked — that would otherwise divide by zero and
 * hand Infinity to a canvas call.
 */
const MIN_SPAN = 1e-6;

/** Bounding box over rock discs, radius included. Null for an empty field. */
export function worldBounds(
  asteroids: Iterable<Asteroid>,
): WorldBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let seen = false;

  for (const a of asteroids) {
    seen = true;
    if (a.x - a.radius < minX) minX = a.x - a.radius;
    if (a.y - a.radius < minY) minY = a.y - a.radius;
    if (a.x + a.radius > maxX) maxX = a.x + a.radius;
    if (a.y + a.radius > maxY) maxY = a.y + a.radius;
  }

  return seen ? { minX, minY, maxX, maxY } : null;
}

/**
 * Fit `bounds` into a `w`×`h` box inset by `pad`, preserving aspect. The
 * leftover on the wider axis is split evenly, so the map is centred rather
 * than pinned to a corner.
 */
export function fitTransform(
  bounds: WorldBounds,
  w: number,
  h: number,
  pad: number,
): FitTransform {
  const innerW = Math.max(MIN_SPAN, w - pad * 2);
  const innerH = Math.max(MIN_SPAN, h - pad * 2);
  const spanX = Math.max(MIN_SPAN, bounds.maxX - bounds.minX);
  const spanY = Math.max(MIN_SPAN, bounds.maxY - bounds.minY);

  const scale = Math.min(innerW / spanX, innerH / spanY);
  // Centre the drawn extent inside the padded box.
  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  return {
    scale,
    offsetX: pad + (innerW - drawnW) / 2 - bounds.minX * scale,
    offsetY: pad + (innerH - drawnH) / 2 - bounds.minY * scale,
  };
}

export function mapPoint(
  t: FitTransform,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  return {
    x: worldX * t.scale + t.offsetX,
    y: worldY * t.scale + t.offsetY,
  };
}

export function unmapPoint(
  t: FitTransform,
  mapX: number,
  mapY: number,
): { x: number; y: number } {
  return {
    x: (mapX - t.offsetX) / t.scale,
    y: (mapY - t.offsetY) / t.scale,
  };
}

/** World-space rectangle the camera can currently see. */
export function viewWorldRect(view: ViewBox): MinimapRect {
  const zoom = Math.abs(view.zoom) < MIN_SPAN ? MIN_SPAN : view.zoom;
  // Inverse of viewport.ts's `sx = x * zoom + camX`, at screen 0 and w/h.
  const x = -view.camX / zoom;
  const y = -view.camY / zoom;
  return { x, y, w: view.w / zoom, h: view.h / zoom };
}

/** The same rectangle in minimap pixels — what the widget strokes. */
export function viewRectOn(t: FitTransform, view: ViewBox): MinimapRect {
  const r = viewWorldRect(view);
  const topLeft = mapPoint(t, r.x, r.y);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: r.w * t.scale,
    h: r.h * t.scale,
  };
}
