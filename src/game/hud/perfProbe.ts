/**
 * Frame profiler behind the F3 overlay.
 *
 * Times named sections of the ticker callback and folds each into an EMA so
 * the readout is stable enough to read while the game runs. Two numbers do
 * the diagnosing:
 *
 *   - `frame` — wall clock between ticks (what the FPS chip reports).
 *   - `js`    — everything the ticker callback did this frame.
 *
 * If `js` is close to `frame`, we are CPU bound and the section rows say
 * where. If `js` is far *below* `frame`, the JavaScript is done early and the
 * frame is waiting on the GPU (fill rate, overdraw, device pixel ratio) or on
 * vsync — no amount of sim/paint tuning will move it.
 */
export class PerfProbe {
  private readonly current = new Map<string, number>();
  private readonly avg = new Map<string, number>();
  private readonly order: string[] = [];
  private readonly stack: { name: string; at: number }[] = [];
  private jsStart = 0;
  private frameMs = 0;
  private jsMs = 0;

  /** Call first thing in the ticker callback. */
  beginFrame(frameMs: number): void {
    this.current.clear();
    this.stack.length = 0;
    this.frameMs = frameMs;
    this.jsStart = performance.now();
  }

  start(name: string): void {
    if (!this.avg.has(name)) {
      this.avg.set(name, 0);
      this.order.push(name);
    }
    this.stack.push({ name, at: performance.now() });
  }

  stop(): void {
    const open = this.stack.pop();
    if (!open) return;
    const ms = performance.now() - open.at;
    this.current.set(open.name, (this.current.get(open.name) ?? 0) + ms);
  }

  /** Call last in the ticker callback. */
  endFrame(): void {
    this.jsMs = performance.now() - this.jsStart;
    for (const name of this.order) {
      const prev = this.avg.get(name) ?? 0;
      this.avg.set(name, prev + ((this.current.get(name) ?? 0) - prev) * 0.1);
    }
    this.avgFrame += (this.frameMs - this.avgFrame) * 0.1;
    this.avgJs += (this.jsMs - this.avgJs) * 0.1;
  }

  private avgFrame = 0;
  private avgJs = 0;

  /** Smoothed readout: `[label, milliseconds]` pairs, heaviest section first. */
  rows(): [string, number][] {
    const sections = this.order
      .map((name): [string, number] => [name, this.avg.get(name) ?? 0])
      .sort((a, b) => b[1] - a[1]);
    return [
      ['frame', this.avgFrame],
      ['js', this.avgJs],
      ...sections,
    ];
  }

  /** True while JavaScript is using less than half the frame — GPU bound. */
  gpuBound(): boolean {
    return this.avgFrame > 20 && this.avgJs < this.avgFrame * 0.5;
  }
}
