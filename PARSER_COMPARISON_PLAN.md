# Local Replay Parser Comparison Plan

Date: 2026-07-03
Status: Ready for execution
Owner: elo10x maintainers

## Goal

Determine whether local replay import should migrate from aoc-mgz to aoe2rec-js, remain on aoc-mgz, or use a dual-parser strategy.

The decision must be based on measured impact to:
- Parsed replay coverage
- Match and player data fidelity
- Downstream database and leaderboard outputs

## Context

The current local import path parses .aoe2record files through Python and aoc-mgz, then writes normalized matches and players into data/db.json, and recalculates data/leaderboard.json when new 10x games are imported.

There is also a TypeScript aoe2rec-js parser implementation in the repository, but it is not wired into the production local importer.

This introduces uncertainty in two critical areas:
- Existing games: whether re-parsing already-imported files changes match identity, participants, teams, winner, timestamps, or map fields
- Parse coverage: whether aoe2rec-js can parse files that aoc-mgz currently fails to parse

## Codebase Orientation

### Current Local Import Pipeline

1. Replay discovery and import orchestration
- [src/import_local.ts](src/import_local.ts)
- Locates replay directories, scans .aoe2record files, applies cache from [data/imported_replays.json](data/imported_replays.json)
- Parses with Python subprocess call to [src/parse_replay.py](src/parse_replay.py)
- Filters to 10x games by lobby title
- Computes numeric match id hash fallback when needed
- Writes match and player profiles into [data/db.json](data/db.json) via [src/db.ts](src/db.ts)
- Recomputes leaderboard payload and writes [data/leaderboard.json](data/leaderboard.json)

2. Current parser contract
- [src/parse_replay.py](src/parse_replay.py)
- Uses mgz.summary.Summary
- Produces fields: match_id, lobby_name, map_name, start_time, duration, players[]

3. Candidate parser contract
- [src/parse_replay_aoe2rec.ts](src/parse_replay_aoe2rec.ts)
- Uses aoe2rec-js parse_rec_summary
- Produces ParsedRecording from [src/types.ts](src/types.ts)
- Currently used in scratch test only: [scratch/test_parse_aoe2rec.ts](scratch/test_parse_aoe2rec.ts)

### Data and ELO Surfaces Affected by Parser Choice

1. Storage semantics
- [src/db.ts](src/db.ts)
- Match dedupe relies on numeric id and hasMatch lookup
- Profile set is pruned by references during save

2. Ranking output
- [src/elo.ts](src/elo.ts)
- [src/cli.ts](src/cli.ts)
- Leaderboard payload shape and ordering are sensitive to match outcomes and participants

3. Existing failure tooling
- [scratch/test_parse_summary.py](scratch/test_parse_summary.py)
- Useful for baseline failure taxonomy of aoc-mgz

## Rationale

A parser switch can silently alter ratings and player records if any of the following differ:
- Match identity and dedupe keys
- Team assignment or winner flags
- Participant profile ids
- Match timing and ordering

Because ELO is order-sensitive and team-sensitive, even small parser differences can create visible leaderboard divergence. This plan therefore prioritizes deterministic, replay-by-replay comparison before any production migration.

## Decision Criteria

Use these explicit criteria to decide path:

1. Migrate to aoe2rec-js
- Critical field parity is acceptable for sample and expanded set
- Additional parse coverage is meaningful
- Identity and result disagreements are rare and explainable

2. Dual-parser
- aoe2rec-js improves coverage
- Non-trivial disagreements exist on a subset
- Fallback to aoc-mgz meaningfully reduces risk

3. Stay on aoc-mgz
- aoe2rec-js parity is weak on critical fields
- Identity or winner/team disagreements are frequent
- Coverage gains do not offset correctness risk

Critical fields are match identity, participants and profile ids, team assignment, and winner.

## Non-Destructive Execution Policy

All analysis must run in shadow artifacts. Do not modify production files during comparison:
- [data/db.json](data/db.json)
- [data/leaderboard.json](data/leaderboard.json)

Use scratch or analysis output paths for generated comparison data and reports.

## Implementation Plan

### Phase 1: Baseline and Sample Selection

1. Build replay sample
- Source from [data/imported_replays.json](data/imported_replays.json)
- Initial scope: 20 previously imported replays
- Resolve full paths using same replay discovery assumptions as [src/import_local.ts](src/import_local.ts)

2. Snapshot baseline context
- Record counts and metadata from [data/db.json](data/db.json) and [data/leaderboard.json](data/leaderboard.json)
- Save snapshots into shadow analysis folder

3. Define canonical comparison schema
- Normalize both parser outputs to one shape aligned with [src/types.ts](src/types.ts)
- Include replay filename, identity inputs, map fields, players, teams, winner, timestamps, duration

### Phase 2: Dual Parse and Normalize

1. Parse sample with aoc-mgz path
- Invoke [src/parse_replay.py](src/parse_replay.py) per replay
- Capture success or failure and raw fields

2. Parse same sample with aoe2rec-js path
- Invoke [src/parse_replay_aoe2rec.ts](src/parse_replay_aoe2rec.ts) per replay
- Capture success or failure and raw fields

3. Normalize and key
- Convert each success result to canonical schema
- Generate deterministic comparison keys and import-like identity values

### Phase 3: Delta Analysis for Previously Parsed Games

1. Field-level deltas on dual-success files
- map and map id
- player aliases and profile ids
- civ ids
- team assignments
- winner
- start and completion timing
- derived match id impacts

2. Downstream db simulation
- Build shadow match objects for each parser path
- Compare dedupe behavior and potential match insert differences under [src/db.ts](src/db.ts) semantics

3. Downstream leaderboard simulation
- Run shadow ELO calculations via [src/elo.ts](src/elo.ts)
- Compare rank movement, rating deltas, and threshold crossings

### Phase 4: Incremental Coverage Analysis

1. Build failure-focused set
- Use known failures from [scratch/test_parse_summary.py](scratch/test_parse_summary.py)
- Add any newly observed aoc-mgz parse failures

2. Classify coverage outcomes
- aoe2rec-js only success
- aoc-mgz only success
- both succeed with material disagreement
- both fail

3. Record error taxonomy
- Exception categories and counts for each parser
- Risk notes for maintenance and fallback value

### Phase 5: Recommendation and Rollout Guidance

1. Produce recommendation memo
- Migration, dual-parser, or stay decision
- Confidence level and quantified evidence

2. If migration or dual-parser is selected
- Define adapter boundary in [src/parse_replay_aoe2rec.ts](src/parse_replay_aoe2rec.ts)
- Define integration change point in [src/import_local.ts](src/import_local.ts)
- Define parser provenance logging expectations

## Verification Checklist

1. Production artifacts unchanged
- Confirm no modifications to [data/db.json](data/db.json)
- Confirm no modifications to [data/leaderboard.json](data/leaderboard.json)

2. Sample integrity
- 20 replay files resolved and processed by both parsers
- Per-replay status table complete

3. Delta integrity
- Every delta row links to one replay filename and both normalized payloads

4. Reproducibility
- Re-run on same sample yields same summary counts and key deltas

5. Expansion gate
- Only expand from sample to full imported set after initial review

## Suggested Deliverables

1. Sample manifest
- Selected replay files and path resolution status

2. Parse result table
- Success or failure per parser, per replay

3. Delta report
- Field-level disagreement summary with replay references

4. Coverage report
- Incremental parse success analysis for failure-focused set

5. Recommendation memo
- Final go or no-go for migration, or dual-parser plan

## Out of Scope for This Document

1. Immediate production code migration
2. CLI UX changes
3. Full-corpus benchmark before sample review
