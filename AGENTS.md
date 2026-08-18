# Asterbloom agent guide

## Project

Asterbloom is an original browser strategy game inspired by Eufloria. Players grow
trees on asteroids, produce seedlings, and expand across a generated skirmish map
or eight authored campaign maps. Keep all art, copy, music, and level content
original; do not introduce ripped assets, protected names, or trademarks.

## Stack

- TypeScript (strict, ES modules, target ES2023)
- Vite 8 for development and static builds
- PixiJS 8 for rendering
- Vitest 4 for tests
- Plain DOM/CSS for the shell and HUD; no UI framework

## Repository map

- `src/main.ts` — application boot, fixed-step game loop, screen/HUD orchestration
- `src/style.css` — global shell and HUD styling
- `src/game/sim/` — deterministic world model, rules, AI, maps, and commands
- `src/game/render/` — Pixi views, palettes, camera, and visual effects
- `src/game/input/` — pointer, keyboard, camera, and send interactions
- `src/game/hud/` — DOM HUDs, copy, preferences, and performance probe
- `src/game/audio/` — Web Audio engine, DSP, and music theory helpers
- `tests/` — Vitest suites mirroring the game domains
- `public/` — static icons; `index.html` and `field.html` are the two entry pages
- `dist/` — generated build output; never hand-edit or commit it
- `tools/agent-lock.mjs` — cooperative lock utility for concurrent agents
- `docs/PROJECT_MAP.md` — detailed ownership and dependency map

## Commands

```bash
npm install        # install dependencies
npm run dev        # title screen and full game
npm run field      # open the direct skirmish entry at /field.html
npm test           # Vitest in watch mode
npm test -- --run  # run the suite once
npm run build      # TypeScript check, then production build to dist/
npm run preview    # serve the production build locally
```

There are no dedicated `lint` or `typecheck` scripts. `npm run build` is the
canonical typecheck. Do not claim lint verification unless tooling is added.

## Architecture and conventions

- Use strict TypeScript and ESM imports. Match existing formatting: two spaces,
  single quotes, semicolons, trailing commas in multiline constructs.
- Keep simulation code independent of Pixi and browser APIs. `render/` reads the
  world; it must not mutate it. Route player/AI intent through `sim/commands.ts`.
- Only the ticker calls `tick`/`tickAi`; simulation time advances at fixed `1/60`.
- Allocate entity IDs through `allocId`; do not construct ad-hoc IDs.
- Keep balance constants and core domain types in `src/game/sim/types.ts`.
- Preserve seeded determinism: use the repository RNG helpers, not `Math.random`,
  inside generated simulation/layout behavior.
- Keep palette and faction-color decisions in `render/palette.ts`.
- Prefer small pure helpers for behavior that can be tested without Pixi or DOM.
- Add dependencies only when explicitly requested and justified.

## Change rules

- Before editing, acquire the relevant path with `tools/agent-lock.mjs`; release
  it after the edit. A busy lock is a queue: wait rather than overwrite work.
- Do not edit `node_modules/`, `dist/`, or live files under `.cursor/locks/`.
- Do not mix rendering state changes into simulation modules or duplicate game
  rules in views, input handlers, HUD copy, or AI.
- Preserve the outbound `travelRadius` graph semantics and connected map layouts.
- Keep renderer hot paths allocation-conscious; avoid rebuilding textures or
  graphics every frame when cached/retheme paths exist.
- Do not silently change player-facing controls, balance, campaign progression,
  persistence keys, or seed/hash behavior as part of unrelated work.

## Definition of done

1. Add or update focused tests in the matching `tests/<domain>/` directory.
2. Run the affected test file while iterating, then `npm test -- --run`.
3. Run `npm run build` to enforce strict TypeScript and validate the Vite build.
4. For visual/input changes, manually check the relevant entry page; for release
   work, check Chromium and Firefox at 1280x720 and 1920x1080 as documented.
5. Confirm no generated `dist/`, lock files, or unrelated changes are included.

@RTK.md
