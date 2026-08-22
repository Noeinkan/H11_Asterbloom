/**
 * shotkit config for Asterbloom.
 *
 * Asterbloom is a live PixiJS match, not a page with routes: every
 * interesting state is a point in a simulation. Rather than trying to play
 * the game through Playwright, the states are built offline by
 * `tests/_shotkit_seed.test.ts`, which drives the real `sim/` with a small
 * player bot and dumps save-slot envelopes (world + camera + selection) to
 * `scratchpad/seeds/`. Each shot writes one of those into
 * `localStorage['asterbloom.save.v1']`, reloads, and presses Continue.
 *
 * Regenerate the seeds with:
 *   SHOTKIT_SEED=1 npx vitest run tests/_shotkit_seed.test.ts
 *
 * (that suite is skipped without the env var, so `npm test` stays fast)
 *
 * Things learned the hard way, so the next run is cheap:
 * - The match keeps ticking after Continue, so `settleMs` doubles as "how far
 *   past the seeded instant we are". Combat resolves in a few seconds — the
 *   assault shot has to stay short or the fight is over before the shutter.
 * - Trees pop in over ~2 frames but the L-system canopies and the starfield
 *   retheme need ~1.5 s to stop redrawing.
 * - `#hud-census` is the gate that says a match is actually running; the
 *   title overlay keeps `hidden` until then.
 * - Resuming a big save is slow here: the waits in `resume()` are raised well
 *   past Playwright's 30 s default because 800+ live seedlings take longer
 *   than that to come up under headless software GL.
 * - A ninth state, the whole map mid-migration (`empire.json`, ~810 seedlings
 *   with 286 in transit at 0.25 zoom), is deliberately NOT in the set: the
 *   match resumes, but `page.screenshot` cannot get a 2880x1800 frame out of
 *   it inside 30 s. `03-field-overview` (669 seedlings) is right at the edge
 *   and does capture. Try it again on a machine with a real GPU.
 * - `clash.json` (9 of yours against 31 defenders at Xylemeth) is also left
 *   out. It captures fine, but rival seedlings are painted in `scene.dust`,
 *   which on this palette is a dim brown against a dim olive sky — at any
 *   zoom the defenders read as drifting debris, not as an enemy force. Worth
 *   revisiting with the faction-marks pref on, which gives each side a shape.
 */

import { readFileSync } from 'node:fs';

const SEEDS =
  'C:/Users/andre/AppData/Local/Temp/claude/c--Users-andre-Downloads-H11-Asterbloom/c84da635-6630-4cf8-be00-deb14fca063e/scratchpad/seeds';

const manifest = JSON.parse(readFileSync(`${SEEDS}/manifest.json`, 'utf8'));
const save = (name) => readFileSync(`${SEEDS}/${name}.json`, 'utf8');

/** world → screen, the inverse of `viewport.ts`'s `sx = x * zoom + camX`. */
const toScreen = (cam, wx, wy) => ({
  x: wx * cam.zoom + cam.x,
  y: wy * cam.zoom + cam.y,
});

/** The seeder records the send pair in its note; pull the coordinates back. */
const SEND_COORDS = /\s*from=[-\d.]+,[-\d.]+ to=[-\d.]+,[-\d.]+/;

function sendPair() {
  const m = /from=([-\d.]+),([-\d.]+) to=([-\d.]+),([-\d.]+)/.exec(
    manifest.send.note,
  );
  const cam = manifest.send.camera;
  return {
    from: toScreen(cam, Number(m[1]), Number(m[2])),
    to: toScreen(cam, Number(m[3]), Number(m[4])),
  };
}

/** Drop a seeded match into the save slot and resume it. */
async function resume(page, name) {
  // shotkit calls page.screenshot() with Playwright's 30 s default, and a
  // full-map frame at 2880x1800 with ~550 live seedlings takes longer than
  // that under headless software GL. This raises the default for every page
  // call that follows, the screenshot included.
  page.setDefaultTimeout(180000);
  await page.evaluate(
    ([key, json]) => {
      localStorage.setItem(key, json);
      // Skip the "How to play" card and keep the widgets we want on screen.
      localStorage.setItem('asterbloom.firstRun.v2', '1');
      localStorage.setItem('asterbloom.minimap.v1', '1');
      localStorage.setItem('asterbloom.mute.v1', '0');
      localStorage.setItem('asterbloom.reducedMotion.v1', '0');
    },
    ['asterbloom.save.v1', save(name)],
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('button[data-nav="continue"]');
  await page.waitForSelector('#hud-census', { state: 'visible' });
  await page.waitForSelector('.title-overlay', { state: 'hidden' });
  // The frame-rate chip is a debug readout and it reads 0 for the first
  // second after a resume, which is the only thing wrong with an otherwise
  // clean HUD. Nothing else is hidden.
  await page.addStyleTag({ content: '#hud-fps { display: none !important; }' });
}

export default {
  baseUrl: 'http://localhost:5199',

  server: {
    command: 'npm run dev -- --port 5199 --strictPort',
    readyUrl: 'http://localhost:5199/',
    timeoutMs: 120000,
  },

  outDir: '.shots',
  viewport: { width: 1440, height: 900 }, // 16:10
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  settleMs: 1800,

  // The shell links Google Fonts (Comfortaa / Nunito) and the HUD is built
  // around them; nothing else leaves the machine. No API, no telemetry.
  allowHosts: ['fonts.googleapis.com', 'fonts.gstatic.com'],

  // No real data exists in this app — every world is generated from a seed.
  mask: [],

  shots: [
    {
      name: '01-title',
      path: '/',
      async prepare(page) {
        // A save in the slot is what makes Continue appear, so the title
        // shows its full set of entry points.
        await page.evaluate(
          ([key, json]) => {
            localStorage.setItem(key, json);
            localStorage.setItem('asterbloom.firstRun.v2', '1');
          },
          ['asterbloom.save.v1', save('overview')],
        );
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector('.title-overlay .title-brand');
      },
      settleMs: 2400, // the starfield drifts in behind the card
      shows: 'title screen over the live starfield: Continue, Play, Campaign, Settings',
      alt: 'Asterbloom title card reading "Grow. Send. Claim the dark." over a dark red starfield, with Continue, Play, Campaign and Settings buttons',
    },

    {
      name: '02-campaign',
      path: '/',
      async prepare(page) {
        await page.evaluate(() =>
          localStorage.setItem('asterbloom.firstRun.v2', '1'),
        );
        await page.reload({ waitUntil: 'networkidle' });
        await page.click('button[data-nav="campaign"]');
        await page.waitForSelector('.title-map-list .title-map:nth-child(8)');
      },
      settleMs: 1200,
      // `.title-map-list` is capped at `min(52vh, 22rem)`, so at 900px the
      // last two maps sit below the fold. HUD scale cannot go under 1, so
      // there is no honest way to fit all eight in — the list scrolls.
      shows: 'the authored campaign maps and their briefs (the list scrolls; six of eight are above the fold at 1440x900)',
      alt: 'Campaign menu listing eight numbered authored maps, each with a title and a one-line brief',
    },

    {
      name: '03-field-overview',
      path: '/',
      async prepare(page) {
        await resume(page, 'overview');
      },
      settleMs: 3000, // whole map on screen: every rock and tree draws once
      shows: `the whole skirmish field zoomed out — ${manifest.overview.note}`,
      alt: 'Zoomed-out view of a generated asteroid field, showing player-held, wild and rival asteroids linked by their travel radii, with the census HUD along the bottom',
    },

    {
      name: '04-grove',
      path: '/',
      async prepare(page) {
        await resume(page, 'grove');
      },
      settleMs: 2600, // L-system canopies finish drawing
      shows: `a claimed asteroid close up, inspector open — ${manifest.grove.note}`,
      alt: 'Close-up of a single asteroid ringed by fractal trees with glowing canopies, and an inspector reading its seedlings, minerals, energy, shield and tree count',
    },

    {
      name: '05-siege',
      path: '/',
      async prepare(page) {
        await resume(page, 'assault');
      },
      settleMs: 900,
      shows:
        'the endgame push: a ~190-seedling wave holding a rock it has just ' +
        'stripped of the rival garrison and trees, ready to plant (rival grove ' +
        'Xylemeth still standing at the top of frame)',
      alt: 'A dense swarm of nearly two hundred seedlings orbiting a captured asteroid stripped of its trees, with a rival grove above it',
    },

    {
      name: '06-send',
      path: '/',
      async prepare(page) {
        await resume(page, 'send');
        const { from, to } = sendPair();
        // Held mid-drag: this is the send preview — the arc, the target ring
        // and the live count in the HUD dock. The mouse is deliberately left
        // down so the shutter catches the gesture, not its result.
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, {
          steps: 12,
        });
        await page.mouse.move(to.x, to.y, { steps: 12 });
      },
      settleMs: 700,
      shows: `a send held mid-drag, preview arc and count dial live — ${manifest.send.note.replace(SEND_COORDS, '')}`,
      alt: 'A drag in progress between two asteroids showing the send preview arc, the count dial on the target and the seedling count lit in the HUD dock',
    },

    {
      name: '07-settings',
      path: '/',
      async prepare(page) {
        await page.evaluate(() =>
          localStorage.setItem('asterbloom.firstRun.v2', '1'),
        );
        await page.reload({ waitUntil: 'networkidle' });
        await page.click('button[data-nav="settings"]');
        await page.waitForSelector('.title-card');
      },
      settleMs: 1200,
      shows: 'the accessibility and audio preferences, all persisted to localStorage',
      alt: 'Settings panel with toggles for sound, reduced motion, screen flash, faction marks, HUD size and minimap',
    },
  ],
};
