# Asterbloom project map

## Runtime flow

`index.html` loads `src/main.ts` for the title, campaign, settings, and skirmish
flow. `field.html` loads the same application with `data-boot="field"`, bypassing
the shell to start a skirmish. Vite builds both HTML entry points.

`main.ts` initializes Pixi, creates the world and views, binds HUD/input/audio,
and advances the simulation with a fixed 1/60-second step. Views consume the
resulting `World`; user and AI actions enter the model through commands.

## Source ownership

### Simulation (`src/game/sim`)

- `types.ts` — domain model, constants, resource formulas, and balance values
- `world.ts` — entity creation and the main simulation tick
- `commands.ts` — sending and planting validation/mutation
- `combat.ts` — damage and combat outcomes
- `ai.ts` — difficulty-driven enemy decisions
- `campaign.ts`, `layout.ts` — authored and generated maps
- `graph.ts`, `spatial.ts` — routing and spatial helpers
- `rock.ts`, `pockets.ts`, `life.ts`, `lsystem.ts` — asteroid/resource/flora logic
- `match.ts` — win/loss rules and match runtime
- `rng.ts`, `names.ts` — deterministic randomness and generated names

### Presentation and interaction (`src/game`)

- `render/` — Pixi asteroid, tree, seedling, graph, starfield, palette, camera,
  viewport, glow, and send-preview layers
- `input/` — gameplay gestures, send count, follow-send, wheel/edge/drag camera
- `hud/` — title/session/pause/crust controls, preferences, copy, debug/perf UI
- `audio/` — Web Audio playback, procedural DSP, and music-theory generation

The intended dependency direction is UI/input -> commands -> simulation, with
rendering reading simulation state. Simulation must not depend on presentation.

## Tests

Vitest discovers `tests/**/*.test.ts` with a 30-second timeout. Test directories
mirror the source domains. Simulation has the broadest behavioral coverage;
render tests focus on pure/cached helpers rather than browser rendering.

## Build and generated content

- `vite.config.ts` configures Vite and Vitest.
- `tsconfig.json` enables strict checking, unused-symbol errors, bundler module
  resolution, `noEmit`, and erasable TypeScript syntax.
- `npm run build` runs `tsc` before Vite and writes the static site to `dist/`.
- `public/` is copied as static content. `node_modules/` and `dist/` are generated.

## Where changes belong

- New gameplay rule or balance value: `sim/`, with tests in `tests/sim/`.
- New visual treatment: `render/` or `style.css`; keep `World` read-only there.
- New pointer/keyboard behavior: `input/`, invoking existing/new commands.
- New screen, label, or preference: `hud/`, with pure behavior tested in
  `tests/hud/` where practical.
- New sound behavior: `audio/`, with deterministic DSP/theory tests.
