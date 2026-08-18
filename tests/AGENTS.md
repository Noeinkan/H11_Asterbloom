# Test rules

These rules refine the root `AGENTS.md` for Vitest suites under `tests/`.

- Mirror the source domains: `sim/`, `render/`, `input/`, `hud/`, and `audio/`.
- Name files `*.test.ts`; Vite includes only `tests/**/*.test.ts`.
- Keep tests deterministic and assert observable state or pure helper output.
- For simulation units, build minimal worlds with `createEmptyWorld` and
  `addAsteroid`; use existing debug helpers only when setup otherwise obscures
  the behavior.
- For integrated map behavior, use the established world/layout constructors.
- Drive simulation via `tick`, `sendSeedlings`, and `plantTree`; do not mutate
  state merely to make the assertion pass after the action under test.
- Avoid importing the Pixi barrel in simulation tests. Renderer tests should
  target pure geometry, palette, cache, and viewport helpers where possible.
- Cover boundary and failure cases when changing commands, resources, combat,
  pathfinding, persistence, or match-end rules.
- Run a focused file with `npm test -- --run tests/<domain>/<file>.test.ts`, then
  run the entire suite with `npm test -- --run`.

