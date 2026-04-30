---
name: factory-memory-scope-split
description: Memory in factory operates at two scopes — per-packet workers stay stateless; the project carries learned memory across runs. Worker-scope follows the claw-code model; project-scope follows the claurst memdir model.
type: project
---

# Memory Scope Split

## Decision

Memory in factory operates at **two distinct scopes** with different design properties:

- **Worker scope** (per-packet, per-agent invocation) — stateless. Each agent invocation reads what it needs from the repo and exits without carry-forward state. Modeled on claw-code's "every claw is replaceable" pattern.
- **Project scope** (across pipeline runs, across sessions, across humans) — stateful. The project carries learned memory in the repo. Modeled on claurst's memdir / session_memory / AutoDream three-layer subsystem.

Both kinds of memory matter. They are not the same problem and should not share infrastructure.

## Context

This framing came out of the research audits of two coding-agent harnesses (2026-04-30):
- [`research/claurst_audit.md`](../research/claurst_audit.md) — single-user TUI pair programmer, treats memory as load-bearing, ~2,000 lines across three subsystems (memdir + session_memory + AutoDream)
- [`research/claw_code_audit.md`](../research/claw_code_audit.md) — autonomous coding harness with Discord as human interface, consciously omits learned memory, every worker starts fresh from CLAUDE.md and git context

A glaring gap in the first pass of those audits prompted this decision: memory was treated as an implementation detail rather than a load-bearing pattern. Re-reading the repos exposed that claurst is taking memory seriously enough to implement it as 2,000+ lines of dedicated infrastructure, while claw-code is consciously rejecting it. Factory had not made a deliberate choice between the two postures.

## The two scopes

### Worker scope — stateless

A *worker* is a single agent invocation: developer agent implementing a packet, code reviewer reviewing it, QA agent verifying acceptance criteria. Workers are short-lived (minutes to tens of minutes), parallelizable, and replaceable.

Properties at this scope:
- **Inputs are explicit:** the packet artifact, the spec, the persona instructions, the repo state at invocation time.
- **No carry-forward state:** if the developer agent for `p1` finishes and the developer agent for `p2` starts, the second agent does not remember anything from the first beyond what's written to disk (commits, completion records, packet status updates).
- **Idempotent:** re-running a packet produces the same result given the same inputs.
- **Recovery is recipe-based, not memory-based:** when a worker fails, recovery comes from typed scenarios (stale-branch, MCP-handshake-failure, etc.), not from learned context.

This matches claw-code's design. Adding learned-memory state at this scope would create divergence between workers, hide failures behind "but this worker remembered X," and undermine reproducibility — which is a primary factory invariant.

### Project scope — stateful

A *project* is the long-lived entity that owns the codebase. Multiple intents are processed over its lifetime; multiple humans contribute; multiple pipeline runs accumulate. The project's understanding of itself grows.

Properties at this scope:
- **Memory is curated, not implicit:** `docs/decisions/` for tracked decisions, `docs/research/` for tracked exploration. Both are read at session start via the memdir-style symlink.
- **Memory is typed:** following claurst's `User | Feedback | Project | Reference` taxonomy (encoded in YAML frontmatter on each memory file).
- **Memory has a write-side (TBD):** the equivalent of session_memory — extracting facts learned during pipeline runs and persisting them to disk so the next run starts with more context. Not yet implemented.
- **Memory has a curation layer (TBD):** the equivalent of AutoDream — periodic consolidation that prunes duplicates, updates stale facts, promotes reinforced observations. Not yet implemented.

This matches claurst's design at the project scope but **not** at the per-invocation scope.

## What this decides

1. **Memory will not be added to the worker layer.** Per-packet agent invocations remain stateless. Recovery from worker failure is via typed recipes, not via learned-memory carry-forward.
2. **Memory IS the project layer's load-bearing pattern.** Investment in memory infrastructure is investment in the project layer.
3. **The memdir convention factory already adopted is the read-side of project memory.** `docs/decisions/` is the typed memory directory; `MEMORY.md` is its manifest; the symlink to Claude Code's per-project memory dir is the load mechanism.

## What this does NOT decide

The following are deferred to synthesis or later decisions:

- **Whether to implement a session_memory equivalent** (write-side) for factory pipeline runs. The research audit lists it as a candidate; the synthesis will weigh it against other patterns.
- **Whether to implement an AutoDream equivalent** (background consolidation). Same — candidate, not committed.
- **The specific memory taxonomy.** Claurst uses `User | Feedback | Project | Reference`. Factory might adopt this verbatim, extend it, or pick a different vocabulary.
- **Where extracted memory writes to.** Claurst writes auto-extracted memories to `AGENTS.md` under a heading. Factory could use the same approach, write to a separate `docs/decisions/_auto/` subdirectory, or something else.
- **Frontmatter schema details.** Claurst parses 30 lines of YAML frontmatter per file. Factory might adopt the same schema, extend it, or simplify.

These are implementation questions that depend on the synthesis report's prioritization. The decision recorded here is purely the *scope split* — not the implementation.

## References

- [`docs/research/claurst_audit.md`](../research/claurst_audit.md) §9 — Memory: three-layer subsystem
- [`docs/research/claw_code_audit.md`](../research/claw_code_audit.md) §12 — Memory: context loading, not learned memory
