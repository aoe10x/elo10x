# Handoff: Dual-Mode Local Replay Import (mgz Primary, aoe2rec Fallback)

Date: 2026-07-04
Status: Ready for implementation handoff
Scope: Local replay import path only

## Objective

Adopt a dual-mode parser strategy for local replay ingestion:
- Primary parser: aoc-mgz (Python path)
- Fallback parser: aoe2rec-js (Node/WASM path)

The goal is to preserve current ingestion quality while recovering edge-case files where mgz fails.

## Why This Direction

Full-run evidence on all local files (2572 replays) strongly favors mgz as primary:

- mgz full run:
  - attempted: 2572
  - successfulLogged: 73
  - alreadyExistsSkips: 1445
  - parseFailures: 290
  - newImportsSummary: 73
  - source: [data/full_local_reimport_mgz.log](data/full_local_reimport_mgz.log)

- aoe2rec full run:
  - attempted: 2572
  - successfulLogged: 0
  - alreadyExistsSkips: 217
  - parseFailures: 2353
  - newImportsSummary: 0
  - source: [data/full_local_reimport_aoe2rec.log](data/full_local_reimport_aoe2rec.log)

- There are still edge cases where mgz fails and aoe2rec appears to process enough to match existing records.
  - Evidence from cross-log analysis and sample comparisons indicates a small but real fallback opportunity.

Conclusion:
- aoe2rec should not be primary today.
- aoe2rec is still useful as a controlled fallback path for mgz failures.

## Current State (Code Orientation)

- Local importer entrypoint: [src/import_local.ts](src/import_local.ts)
- mgz parser bridge: [src/parse_replay.py](src/parse_replay.py)
- aoe2rec adapter logic currently in importer and scratch scripts
- Match source type includes parser provenance: [src/types.ts](src/types.ts)
- DB and fingerprint dedupe: [src/db.ts](src/db.ts)

Current importer supports parser mode env:
- IMPORT_LOCAL_PARSER=mgz|aoe2rec|auto
- IMPORT_LOCAL_ASSUME_10X_WHEN_LOBBY_MISSING=1 for aoe2rec lobby-name gap handling

## Target Behavior

Implement and standardize runtime behavior as:

1. Default mode is effectively dual:
- Try mgz first
- If mgz parse fails, try aoe2rec

2. Provenance per inserted match:
- mgz path inserts source=local_replay_mgz
- fallback path inserts source=local_replay_aoe2rec

3. Keep dedupe semantics unchanged:
- Preserve existing id checks and fingerprint checks
- Do not relax duplicate-equivalence rules

4. Keep 10x gate conservative:
- If lobby name is missing on aoe2rec output, only allow import when explicit fallback env is enabled

## Implementation Tasks

### Task A: Lock in dual fallback as default operational mode

- File: [src/import_local.ts](src/import_local.ts)
- Make default parser flow: mgz first, aoe2rec on mgz exception.
- Preserve explicit override support for forced modes only for testing.

### Task B: Add parse-path counters and summary output

- File: [src/import_local.ts](src/import_local.ts)
- Add counters:
  - mgz_success
  - mgz_fail
  - aoe_fallback_attempt
  - aoe_fallback_success
  - aoe_fallback_fail
  - inserted_from_mgz
  - inserted_from_aoe
- Print a structured end-of-run summary block.

### Task C: Persist parser provenance for observability

- Already in place at insert time via source field.
- Ensure any fallback insert always sets source=local_replay_aoe2rec.
- Verify legacy backfill behavior in [src/db.ts](src/db.ts) remains unchanged.

### Task D: Harden aoe2rec failure handling noise

- Ensure panic/noisy WASM error output is suppressed in importer context.
- Keep exceptions captured and counted, not dropped.

### Task E: Add a small regression test harness (optional but recommended)

- Add a scratch or test script to run a fixed replay subset through dual-mode and assert:
  - no crash
  - deterministic summary counters
  - expected source tags for inserted matches

## Validation Plan

Run in this order:

1. Baseline
- Record source distribution in [data/db.json](data/db.json)
- Record cache size from [data/imported_replays.json](data/imported_replays.json)

2. Controlled subset reimport
- Temporarily clear a subset from imported cache
- Run importer in default dual behavior
- Capture counters and inserted match ids

3. Verify provenance
- Confirm newly inserted matches have expected source values

4. Verify dedupe stability
- Confirm no unexpected duplicate growth

5. Full-run smoke (optional heavy)
- Use Node scratch runner approach used in:
  - [scratch/run_full_local_reimport_mgz.ts](scratch/run_full_local_reimport_mgz.ts)
  - [scratch/run_full_local_reimport_aoe2rec.ts](scratch/run_full_local_reimport_aoe2rec.ts)

## Rollout Guardrails

1. Do not run Relic API crawler/fetch in parallel with local import comparison runs.
2. Avoid concurrent writers to [data/db.json](data/db.json).
3. Keep backup-and-restore behavior for [data/imported_replays.json](data/imported_replays.json) during experiments.
4. Keep parser override env vars documented for emergency rollback.

## Suggested Operational Defaults

- Production/local daily use:
  - IMPORT_LOCAL_PARSER=auto
  - IMPORT_LOCAL_ASSUME_10X_WHEN_LOBBY_MISSING=0

- Investigation mode only:
  - IMPORT_LOCAL_ASSUME_10X_WHEN_LOBBY_MISSING=1

## Decision Record

Given current evidence, recommended parser policy is:
- Keep mgz as primary parser
- Enable aoe2rec fallback only on mgz failure
- Continue collecting parser provenance and fallback counters before any future primary-parser reconsideration

## Reference Artifacts

- Full-run comparison summary:
  - [scratch/results/parser-compare/full-reimport-compare-2026-07-04T22-45-04-438Z.md](scratch/results/parser-compare/full-reimport-compare-2026-07-04T22-45-04-438Z.md)
  - [scratch/results/parser-compare/full-reimport-compare-2026-07-04T22-45-04-438Z.json](scratch/results/parser-compare/full-reimport-compare-2026-07-04T22-45-04-438Z.json)
- Full logs:
  - [data/full_local_reimport_mgz.log](data/full_local_reimport_mgz.log)
  - [data/full_local_reimport_aoe2rec.log](data/full_local_reimport_aoe2rec.log)
