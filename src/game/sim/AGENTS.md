# Simulation rules

These rules refine the root `AGENTS.md` for `src/game/sim/`.

- Keep this directory pure TypeScript: no Pixi, DOM, Web Audio, or HUD imports.
- `world.ts` owns tick-time mutation: growth, spawning, travel, energy, upkeep,
  tree burn, and orbit transitions.
- `commands.ts` owns player/AI intent. Commands return `CommandResult`; callers
  should not reproduce their validation or mutation.
- `combat.ts` owns combat resolution; `ai.ts` must act through commands.
- `layout.ts` and `campaign.ts` create maps; generated travel graphs must remain
  connected. Travel uses the source asteroid's outbound `travelRadius`.
- `graph.ts` owns reachability/pathfinding; `lsystem.ts` owns tree geometry used
  for tips and planting, not gameplay policy.
- Store entities in the `World` maps and obtain every new ID via `allocId`.
- Use `mulberry32` and RNG helpers for deterministic generation. Any new seeded
  behavior needs a repeatability test.
- Put shared domain types and balance constants in `types.ts`; avoid duplicate
  magic values in commands, AI, and tests.
- Preserve capture order: clear defenders, burn enemy trees, then allow planting.
- Test rule changes through public operations (`tick`, `sendSeedlings`,
  `plantTree`) and assert world state in `tests/sim/`.

