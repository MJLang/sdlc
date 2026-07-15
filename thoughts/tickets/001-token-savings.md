---
Status: draft
Tags: [cli, skills, tokens, performance, contracts]
Type: refactor
Target: sdlc
---

# Ticket 001 - Reduce token usage across the pipeline

## Summary

The pipeline pays avoidable model-token costs on its hottest paths: `/next` and `/queue` spawn a fact-gathering subagent, every implement iteration ingests full doctor JSON, quality gates stream unbounded logs, 24.5 KB of always-loaded instructions duplicate procedures owned by skills, subagents receive broad files instead of targeted context, and every session loads all Beads memories via `bd prime`. The converged design in `thoughts/design/token-savings.md` (sha256=ebe6ecbe448709c66427f97271fe4ec87d5966ce7b310426345a2c6d72c85354) specifies the remedies; this ticket makes them deliverable outcomes.

## Scope

**In scope:** a deterministic read-only snapshot command; terse per-stage precondition guards; a quality-gate wrapper with bounded output; slimming the generated instruction contracts and deduplicating skill text; targeted context packets for docs, implementation steps, and reviews; on-demand memory retrieval with a minimal project prime; benchmark measurement gating the release.

**Out of scope:** narrower later review rounds (design §5) and TOON encoding — both deferred until the benchmarks from this work exist. No change to human gates, reproducible approvals, read-only enforcement, or review-evidence requirements.

## Acceptance Criteria

- AC-001: `/next` and `/queue` obtain all pipeline facts from one deterministic, mechanically read-only `sdlc snapshot` invocation; an idle `/next` iteration spawns no subagent and performs no further fact-gathering tool calls.
- AC-002: Every pipeline stage can verify its preconditions through a stage guard that emits exactly one success line with stable field and reason codes, refuses with the relevant errors and recovery action on failure, and preserves the full `sdlc doctor --json` surface unchanged; no stage invariant currently enforced by a skill preflight is lost.
- AC-003: Quality gates run through a wrapper that emits one line per passing command and a bounded failure excerpt plus full-log location on failure, never masks a non-zero exit, and stores logs outside the worktree so gate runs cannot dirty it.
- AC-004: The generated always-loaded contracts (`thoughts/AGENTS.md`, root `AGENTS.md`) are cut to configuration, authority, universal invariants, and gate boundaries, with every transition procedure normative in exactly one loaded-when-needed file.
- AC-005: Implementer subagents receive a compact immutable step packet and return a compact structured result; reviewers receive a deterministic review packet with a lane-scoped diff plus a complete changed-file inventory.
- AC-006: A fresh session loads no memory bodies at start; prime output is minimal, and memory content is retrieved only by tag query and explicit recall.
- AC-007: Baseline and post-change benchmarks for the design's scenarios are recorded under pinned conditions, and the release is blocked if any scenario regresses on correctness signals.

## Open Questions

- None.
