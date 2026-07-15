# SDLC Beads Context

Use `bd --readonly ready` and `bd --readonly show <id>` for observation. Execute
ticket/plan transitions only through the owning SDLC skill and read
`thoughts/AGENTS.md` for repository policy.

Only a mutating root pipeline session establishes a session actor. Every Beads
mutation supplies its captured `BEADS_ACTOR=sdlc:<runtime>:<session-id>` literal;
observers and subagents stay read-only.

Memory bodies are on demand: search with
`bd --readonly memories "tag:<tag>" --json`, then read a selected key with
`bd --readonly recall <key>`. Do not enumerate or inject all memories at startup.
