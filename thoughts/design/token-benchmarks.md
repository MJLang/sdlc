# Token-Savings Benchmarks

## Protocol

This benchmark compares the workflow contract immediately before and after the
token-savings refactor. A run is accepted only when it reaches the same legal
transition decision and preserves the same review/gate evidence.

Scenarios:

1. idle `/next`;
2. `/queue` with several active plans;
3. `/plan` with no research tracks;
4. `/plan` with three research tracks;
5. four-step `/implement` with a clean first review;
6. four-step `/implement` with one blocked review and fix round;
7. `/land`, replayed once with a current base and once after main advances.

For each scenario record uncached input tokens, cached input tokens, output
tokens, root/model/subagent calls, bytes returned by tools to models, elapsed
wall time, retries or malformed outputs, and incorrect transition decisions.
Token counters are recorded only when the host exposes them. Otherwise the
release metrics are tool-output bytes and model/subagent call counts; instruction
payload bytes are retained as a stable secondary proxy. A correctness regression
(wrong transition, missed review defect, weakened evidence, or extra repair
loop) blocks release regardless of byte savings.

## Pinned conditions

| Condition | Baseline |
|---|---|
| Fixture-project commit | `8a78632d44d590f3def1168ba8af35fe0f606763` (the repository is its own fixture) |
| SDLC commit | `8a78632d44d590f3def1168ba8af35fe0f606763` |
| Runtime | Codex CLI host; Node `v24.4.1`; npm `11.4.2` |
| Model | Host-selected model; per-agent token counters unavailable |
| Cache | Cold instruction reads; no assumption of provider prompt caching |
| Beads | `1.1.0` (Homebrew), embedded mode |
| Repetitions | 1 contract replay per scenario; deterministic CLI fixtures use 3 test repetitions during verification |
| Recorded at | 2026-07-14, America/Los_Angeles |

The baseline was captured before any optimizing source/template change. The
runtime available for this repository does not expose token counters or a
machine-readable transcript byte counter, so those cells are `N/E` (not
exposed), not estimates. Contract call counts and directly measured prompt
payload bytes are the reproducible baseline fallback.

## Baseline

`thoughts/AGENTS.md` plus root `AGENTS.md` measured 24,518 bytes. The three code
review profiles measured 41,281 bytes; the snapshot profile measured 3,708
bytes. The hot-path skills measured 5,124 bytes (`next`), 5,802 bytes (`queue`),
and 12,952 bytes (`implement`).

| Scenario | Uncached input | Cached input | Output | Model calls | Subagent calls | Tool-output bytes | Wall time | Retries/malformed | Incorrect decisions |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| idle `/next` | N/E | N/E | N/E | 2 | 1 snapshot | N/E | N/E | 0 | 0 |
| `/queue`, several active plans | N/E | N/E | N/E | 2 | 1 snapshot | N/E | N/E | 0 | 0 |
| `/plan`, no research | N/E | N/E | N/E | 2 | 1 plan review | N/E | N/E | 0 | 0 |
| `/plan`, three research tracks | N/E | N/E | N/E | 5 | 3 research + 1 plan review | N/E | N/E | 0 | 0 |
| four-step implement, clean review | N/E | N/E | N/E | 6 | 4 implementers + 1 reviewer | N/E | N/E | 0 | 0 |
| four-step implement, blocked round | N/E | N/E | N/E | 8 | 4 implementers + 1 fixer + 2 reviews | N/E | N/E | 0 | 0 |
| land, current / rebase | N/E | N/E | N/E | 1 / 1 | 0 / 0 | N/E | N/E | 0 / 0 | 0 / 0 |

Call counts are minimum completed-path counts dictated by the pre-change skill
contracts. Same-HEAD malformed retries are counted separately when they occur.

## Post-change

The post-change replay used the same host/runtime assumptions and the `0.4.0`
working tree based on the pinned baseline commit. The host still exposed
neither provider token counters nor complete model-session transcript/timing
telemetry, so those values remain `N/E`; no token values were estimated.
Contract call counts, deterministic command-output bytes, and instruction-file
bytes are direct measurements. Session-shaped values that the host did not
expose are also `N/E`, rather than being reconstructed from partial logs.

| Scenario | Uncached input | Cached input | Output | Model calls | Subagent calls | Tool-output bytes | Wall time | Retries/malformed | Incorrect decisions | Delta |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| idle `/next` | N/E | N/E | N/E | 1 | 0 | 345 B snapshot | N/E | 0 | 0 | model calls -50%; subagents -100%; instruction proxy -68.6% |
| `/queue`, several active plans | N/E | N/E | N/E | 1 | 0 | N/E (state-sized single snapshot) | N/E | 0 | 0 | model calls -50%; subagents -100%; instruction proxy -71.3% |
| `/plan`, no research | N/E | N/E | N/E | 2 | 1 plan review | N/E | N/E | 0 | 0 | calls unchanged; instruction proxy -53.8% |
| `/plan`, three research tracks | N/E | N/E | N/E | 5 | 3 research + 1 plan review | N/E | N/E | 0 | 0 | calls unchanged; instruction proxy -53.8% |
| four-step implement, clean review | N/E | N/E | N/E | 6 | 4 implementers + 1 reviewer | N/E session; 244 B final gate | N/E | 0 | 0 | calls unchanged; instruction proxy -44.3%; gate output -97.4% |
| four-step implement, blocked round | N/E | N/E | N/E | 8 | 4 implementers + 1 fixer + 2 reviews | N/E session; bounded per gate | N/E | 0 | 0 | calls unchanged; instruction proxy -44.3%; packets replace broad context |
| land, current / rebase | N/E | N/E | N/E | 1 / 1 | 0 / 0 | N/E | N/E | 0 / 0 | 0 / 0 | calls unchanged; instruction proxy -54.0% |

The post-change call counts are the minimum completed-path counts dictated by
the new skill contracts. The two dashboard contracts each make exactly one
model-visible snapshot call and spawn no fact-gathering model. Planning and
implementation keep their quality-bearing research, implementation, and review
calls; their reductions come from smaller contracts and targeted packets, not
from deleting those judgments.

### Direct payload proxies

Instruction floors below are exact UTF-8 byte counts. A scenario floor is the
root plus workflow contracts and its owning skill; it excludes variable ticket,
plan, code, provider wrapper, and cache content. It is therefore a stable
secondary proxy, not a token estimate.

| Surface | Baseline bytes | Post-change bytes | Delta |
|---|---:|---:|---:|
| Always-loaded root + workflow contracts | 24,518 | 7,169 | -70.8% |
| Idle `/next` instruction floor | 29,642 | 9,304 | -68.6% |
| `/queue` instruction floor | 30,320 | 8,688 | -71.3% |
| `/plan` instruction floor | 31,646 | 14,635 | -53.8% |
| `/implement` parent instruction floor | 37,470 | 20,865 | -44.3% |
| `/land` instruction floor | 34,769 | 16,003 | -54.0% |
| Three code-reviewer profiles | 41,281 | 38,211 | -7.4% |
| Snapshot-agent profile | 3,708 | 0 | -100.0% |

The generated workflow contract is 746 words and the root contract is 228
words (974 combined), keeping the workflow contract below the 1,000-word
limit. The deterministic healthy/empty snapshot fixtures serialize to 345
bytes for `next` and 346 bytes for `queue`.

### Mechanical output and correctness replay

The final explicit quality-gate replay ran `npm test` through `sdlc gates`.
The complete raw test output was 9,525 bytes; the model-facing wrapper output
was 244 bytes, including a Git-common-unwritable fallback warning forced by the
sandbox. That is a 97.4% reduction while retaining `tests=109`, `pass=109`,
`fail=0`, `skipped=0`, the command, source, duration, and protected log
location.

The final suite passed 109 of 109 tests. It exercises every guard matrix mode,
snapshot selection/rejection and worktree evidence, config ordering and opaque
shell commands, gate exit/log/permission/retention behavior, lane and
cross-lane packet fallbacks, complete review inventory, setup idempotence, and
the real Beads 1.1 prime/worktree/gate paths. No fixture produced an incorrect
transition decision, malformed retry, missed expected review finding, or extra
repair loop. Under the predeclared fallback metrics, the release gate passes:
idle `/next` removes one model and one subagent, implementation retains its
review calls while shrinking its instruction floor and gate output, and all
correctness signals remain zero.
