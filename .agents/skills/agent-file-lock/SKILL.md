---
name: agent-file-lock
description: Cooperative file semaphore for parallel Codex agents. Acquire, wait forever, take free paths with --any, heartbeat, and release. Keep retrying until every objective is done — a busy lock is a queue, not a reason to give up. Use before any Write, StrReplace, or Delete, when multiple agents may run, or when the user mentions locks, semaphores, or waiting on files.
---

# Agent file lock

Run from the repo root. Do not invent a second lock scheme.

## Do not give up

A `busy` result means **wait and retry**, not “skip this task.” Keep a remaining-objectives list. The job is unfinished until that list is empty (or the user cancels).

## Holder

One slug per chat (`render-canopy`, `sim-travel`). Reuse it for acquire, heartbeat, and release.

## Commands

```bash
node tools/agent-lock.mjs acquire --any --wait --holder <slug> -- src/game/render src/game/sim
node tools/agent-lock.mjs heartbeat --holder <slug>
node tools/agent-lock.mjs release --holder <slug>
node tools/agent-lock.mjs status
```

- `--wait` + `--timeout 0` (default) waits forever. Set Shell `block_until_ms` to at least `600000`. If the command is still running, keep waiting.
- `--any` takes every requested path that is free **now**. With `--wait`, it blocks until at least one is free, then takes all currently free paths.
- `pending …` / `still busy` = those paths are still on the checklist. After you finish and `release` the acquired batch, acquire again.
- Without `--wait`, exit `2` means nothing was free. Retry immediately with `--any --wait`.
- `--force` only if `status` shows a dead holder.

## Loop

1. List remaining objectives and their paths.
2. `acquire --any --wait` on **all remaining paths**.
3. Edit only `acquired` paths. Heartbeat if that batch lasts > 2 minutes.
4. `release` that batch.
5. Remove finished items. If anything is still pending, go to step 2.
6. Stop only when the checklist is empty.
