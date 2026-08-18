/**
 * Screen-rect test shared by every culled layer. Rocks and trees have always
 * used this; seedlings do now too, so one definition of "on screen" covers the
 * whole field instead of each layer inventing its own.
 */
export interface ViewBox {
  camX: number;
  camY: number;
  zoom: number;
  /** Viewport size in screen pixels (`app.screen.width` / `.height`). */
  w: number;
  h: number;
}

/**
 * True when a world-space disc of `radius` around (x, y) can touch the view.
 * `pad` widens the test so something drifting in has already been updated by
 * the time its edge appears — big soft rocks need more of it than seedlings.
 */
export function inView(
  x: number,
  y: number,
  radius: number,
  view: ViewBox,
  pad = 90,
): boolean {
  const sx = x * view.zoom + view.camX;
  const sy = y * view.zoom + view.camY;
  const pr = (radius + pad) * view.zoom;
  return sx + pr > 0 && sy + pr > 0 && sx - pr < view.w && sy - pr < view.h;
}
