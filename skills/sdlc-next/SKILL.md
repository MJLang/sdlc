---
name: sdlc-next
version: 0.5.1
description: Deterministic autonomous dispatcher that performs exactly one snapshot-selected plan or implement transition and reports human gates.
disable-model-invocation: true
---

Run exactly one pipeline iteration. Never ask a question, cross a human gate,
or perform a second transition after the selected transition completes or
refuses.

## Snapshot once

Run exactly:

```bash
sdlc snapshot --view=next --json
```

This command is the single normative implementation of eligibility, priority,
overlap exclusion, stale corroboration, and the human queue. Do not spawn a
snapshot agent, rerun doctor per number, query Beads/Git for more facts, or
reimplement a reason code.

Trust the snapshot while its `expiresAt` is current. If it has already expired
before action, discard it and rerun the same snapshot command once; do not patch
old facts with ad-hoc queries. Its `head` and `state` bind the collected facts.

## Perform the selected transition

- No `selected`: report `idle` plus `humanQueue` and stop immediately. This path
  performs no other fact-gathering call and spawns no subagent.
- `transition=plan`: invoke `/sdlc-plan {number}`. Its success or refusal ends this
  invocation.
- `transition=implement`: establish one actor only now with
  `sdlc actor <runtime> --new`, capture the printed literal, and invoke
  `/sdlc-implement {number}` with that inherited actor. The child uses the exact
  literal in every mutation. A guard refusal or atomic-claim race ends this
  invocation; never fall through to another candidate.

Render every human-queue item with its supplied action. Reason-code guidance:
`reapproval-required -> /sdlc-approve`, `gated -> supplied gate resolution`,
`foreign-claim|stale-candidate|orphan-recovery -> explicit human recovery`,
`review-approved -> /sdlc-land`, `legacy -> explicit migration`, and
`file-overlap:<path> -> show the included conflicting plan/path evidence`.
Never execute those human actions.

Do not invoke `/sdlc-approve`, `/sdlc-review`, `/sdlc-land`, `/sdlc-cancel`, or `/sdlc-chore`; do not
repair Beads, release claims/slots, resolve gates, or mutate labels to make work
runnable.
