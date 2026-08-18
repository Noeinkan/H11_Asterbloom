import { Container, Graphics, Text } from 'pixi.js';
import type { ScenePalette } from './palette';

/**
 * Renders the in-flight send overlay:
 *   - Quadratic Bezier "arc" from the source rock to the cursor or target rock
 *   - Floating seedling-count label at the arc's apex
 *   - "▼ N" pin above the source rock when a count > 0
 *   - Precise-send dial around the destination asteroid when the player is
 *     fine-tuning how many orbiters to dispatch
 */
export class SendPreview {
  readonly root = new Container();
  private line = new Graphics();
  private dial = new Graphics();
  private label: Text;
  private pin: Text;
  private dialLabel: Text;
  private scene: ScenePalette;
  private last:
    | {
        fromX: number;
        fromY: number;
        toX: number;
        toY: number;
        count: number;
        valid: boolean;
        precise: boolean;
        max: number;
      }
    | null = null;

  constructor(scene: ScenePalette) {
    this.scene = scene;
    this.root.eventMode = 'none';
    this.root.visible = false;
    this.root.addChild(this.line);
    this.root.addChild(this.dial);
    this.label = new Text({
      text: '',
      style: {
        fontFamily: 'Comfortaa, Nunito, "Segoe UI", system-ui, sans-serif',
        fontSize: 16,
        fontWeight: '700',
        fill: scene.ink,
      },
    });
    this.label.anchor.set(0.5);
    this.root.addChild(this.label);
    this.pin = new Text({
      text: '',
      style: {
        fontFamily: 'Comfortaa, Nunito, "Segoe UI", system-ui, sans-serif',
        fontSize: 13,
        fontWeight: '700',
        fill: scene.ink,
      },
    });
    this.pin.anchor.set(0.5);
    this.root.addChild(this.pin);
    this.dialLabel = new Text({
      text: '',
      style: {
        fontFamily: 'Comfortaa, Nunito, "Segoe UI", system-ui, sans-serif',
        fontSize: 13,
        fontWeight: '700',
        fill: 0x224526,
      },
    });
    this.dialLabel.anchor.set(0.5);
    this.dialLabel.alpha = 0;
    this.root.addChild(this.dialLabel);
  }

  hide(): void {
    this.root.visible = false;
    this.last = null;
    this.pin.text = '';
    this.dial.clear();
    this.dialLabel.text = '';
    this.dialLabel.alpha = 0;
  }

  retheme(): void {
    if (!this.last || !this.root.visible) return;
    const { fromX, fromY, toX, toY, count, valid, precise, max } = this.last;
    this.show(fromX, fromY, toX, toY, count, valid, precise, max);
  }

  show(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    count: number,
    valid: boolean,
    precise = false,
    max = 0,
  ): void {
    this.root.visible = true;
    this.last = { fromX, fromY, toX, toY, count, valid, precise, max };
    this.line.clear();
    const mx = (fromX + toX) / 2;
    const my = (fromY + toY) / 2;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const len = Math.hypot(dx, dy) || 1;
    const cx = mx - (dy / len) * 28;
    const cy = my + (dx / len) * 28;

    this.line.moveTo(fromX, fromY);
    this.line.quadraticCurveTo(cx, cy, toX, toY);
    this.line.stroke({
      width: valid ? 5.5 : 3.5,
      color: valid ? this.scene.mist : this.scene.dust,
      alpha: valid ? 0.22 : 0.08,
      cap: 'round',
    });
    this.line.moveTo(fromX, fromY);
    this.line.quadraticCurveTo(cx, cy, toX, toY);
    this.line.stroke({
      width: valid ? 1.7 : 1.1,
      color: valid ? this.scene.ink : this.scene.inkSoft,
      alpha: valid ? 0.72 : 0.28,
      cap: 'round',
    });
    this.line.circle(toX, toY, valid ? 6 : 3.5);
    this.line.fill({
      color: valid ? this.scene.mist : this.scene.dust,
      alpha: valid ? 0.28 : 0.1,
    });
    this.line.circle(toX, toY, valid ? 3.2 : 2);
    this.line.fill({
      color: valid ? this.scene.ink : this.scene.inkSoft,
      alpha: valid ? 0.7 : 0.25,
    });

    this.label.text = count <= 0 ? '0' : `${count} seedling${count === 1 ? '' : 's'}`;
    this.label.position.set(cx, cy - 12);
    this.label.style.fill = valid ? this.scene.ink : this.scene.inkSoft;
    this.label.alpha = valid ? 0.95 : 0.4;

    if (count > 0) {
      const px = fromX;
      const py = fromY - 28;
      this.pin.text = `▼ ${count}`;
      this.pin.position.set(px, py);
      this.pin.style.fill = valid ? this.scene.ink : this.scene.inkSoft;
      this.pin.alpha = valid ? 0.95 : 0.4;
    } else {
      this.pin.text = '';
    }

    this.paintDial(toX, toY, count, max, precise, valid);
  }

  /**
   * Render the green radial dial around the destination asteroid. Activated
   * while the player is in `precise` send mode and has a valid send. The
   * arc sweeps clockwise from 12 o'clock and its filled length tracks
   * `count / max`. The dial collapses cleanly when count or max is zero.
   */
  private paintDial(
    cx: number,
    cy: number,
    count: number,
    max: number,
    precise: boolean,
    valid: boolean,
  ): void {
    const g = this.dial;
    g.clear();
    if (!precise || max < 1 || count < 1) {
      this.dialLabel.alpha = 0;
      return;
    }

    // Arc sits in a fixed world-space ring around the target. The dial
    // does not track the actual asteroid radius (AsteroidView isn't visible
    // here) — 42 is wide enough to read at any reasonable zoom while still
    // fitting between adjacent rocks in dense maps.
    const outer = 42;
    const inner = outer - 7;
    const mid = (outer + inner) * 0.5;

    // Faint track ring so the empty slots read as a groove, not just an
    // absence of fill.
    g.circle(cx, cy, mid);
    g.stroke({
      width: outer - inner,
      color: this.scene.mist,
      alpha: 0.18,
      cap: 'butt',
    });

    const frac = Math.min(1, count / max);
    const startAngle = -Math.PI / 2; // 12 o'clock
    const endAngle = startAngle + frac * Math.PI * 2;

    // Filled green arc — the "active" slice count. Slightly overshoot
    // by ~1° on each end so adjacent slot wedges stay visually separate.
    g.moveTo(cx, cy);
    g.arc(cx, cy, mid, startAngle - 0.04, endAngle + 0.04);
    g.closePath();
    g.fill({ color: 0x6ed46b, alpha: valid ? 0.42 : 0.18 });

    g.moveTo(cx, cy);
    g.arc(cx, cy, mid, startAngle - 0.04, endAngle + 0.04);
    g.closePath();
    g.stroke({
      width: outer - inner,
      color: 0x4ea84c,
      alpha: valid ? 0.55 : 0.28,
      cap: 'butt',
    });

    // Slot tick marks — one per seedling, around the full track. Filled
    // ticks inside the active arc are brighter so the dial reads as
    // "count out of max" at a glance.
    const slots = Math.min(max, 32); // cap draw cost for very large reserves
    for (let i = 0; i < slots; i++) {
      const t0 = i / slots;
      const t1 = (i + 1) / slots;
      if (t1 <= frac + 0.001) {
        const a = startAngle + t0 * Math.PI * 2;
        const ax = cx + Math.cos(a) * outer;
        const ay = cy + Math.sin(a) * outer;
        g.circle(ax, ay, 1.6);
        g.fill({ color: 0x224526, alpha: valid ? 0.55 : 0.22 });
      } else {
        const a = startAngle + (t0 + t1) * 0.5 * Math.PI * 2;
        const ax = cx + Math.cos(a) * (outer + 0.4);
        const ay = cy + Math.sin(a) * (outer + 0.4);
        g.circle(ax, ay, 0.7);
        g.fill({ color: this.scene.inkSoft, alpha: 0.25 });
      }
    }

    // Pointer wedge at the leading edge of the arc — a small notch so the
    // current count is unambiguous even before the player looks at the
    // integer label.
    const pointerAngle = endAngle;
    const px = cx + Math.cos(pointerAngle) * (outer - 1);
    const py = cy + Math.sin(pointerAngle) * (outer - 1);
    g.circle(px, py, 2.4);
    g.fill({ color: 0x224526, alpha: valid ? 0.7 : 0.3 });

    // Tiny readout centered on the dial — keeps the precise count visible
    // even when the camera is zoomed out and the floating label is small.
    this.dialLabel.text = `${count}`;
    this.dialLabel.position.set(cx, cy);
    this.dialLabel.alpha = valid ? 0.95 : 0.4;
  }
}