---
name: Memory scope split — stateless workers, stateful project; host-project memory vs factory-development memory
description: >-
  Memory in factory operates at two scopes with different design properties.
  Workers (per-packet agent invocations: developer, code reviewer, QA) stay
  stateless — short-lived, parallelizable, replaceable, no carry-forward
  state, recovery via typed scenarios rather than learned context
  (claw-code's posture). The project layer is stateful — multiple intents over
  its lifetime, multiple humans, accumulating runs, curated and persistent
  (claurst's memdir/session_memory/AutoDream three-layer pattern). Within
  project scope, factory respects a host/guest boundary claurst (a
  single-user TUI) doesn't have to navigate, splitting further into
  host-project memory (factory's contract with host projects: factory writes
  artifacts to the host's tracked artifact tree; the host owns the loading
  mechanism, not factory) and factory-development memory (the memdir-style
  symlink convention this repo uses, configured via gitignored
  `.claude/settings.local.json`; per-developer setup, NOT inherited by host
  projects). Memory categories at host-project scope are architectural facts,
  recurring failures, project conventions, and code patterns. The current
  implementation shape is the thin layer described in
  [host_project_memory_thin_layer.md](host_project_memory_thin_layer.md);
  heavier graph-backed retrieval remains a future option, not the operative
  contract. Decided 2026-04-30; clarified 2026-05-13. Informed by
  [claurst_audit.md](../research/claurst_audit.md) §9 (three-layer subsystem)
  and [claw_code_audit.md](../research/claw_code_audit.md) §12 (context
  loading, not learned memory).
type: project
---

# Memory Scope Split

## Decision

Memory in factory operates at **two distinct scopes** with different design properties:

- **Worker scope** (per-packet, per-agent invocation) — stateless. Each agent invocation reads what it needs from the repo and exits without carry-forward state. Modeled on claw-code's "every claw is replaceable" pattern.
- **Project scope** (across pipeline runs, across sessions, across humans) — stateful. The project carries learned memory in the repo. Modeled on claurst's memdir / session_memory / AutoDream three-layer subsystem.

Within project scope, two further sub-scopes exist when factory is loaded into a host project:

- **Host-project memory** — the contract factory establishes with host projects: memory artifacts factory produces are written to the **host's** tracked artifact tree; the host owns the files and the loading mechanism.
- **Factory-development memory** — memory specific to this factory repo's own evolution; the memdir-style symlink convention used here is **per-developer setup, not inherited** by host projects.

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

A *project* is the long-lived entity that owns a codebase. Multiple intents are processed over its lifetime; multiple humans contribute; multiple pipeline runs accumulate. Project-scope memory is curated and persistent.

When factory is loaded into a host project as a tool, project scope has **two ownership-distinct sub-scopes**. They share the same general posture (curated, typed, persistent) but differ in *whose tree the artifacts live in* and *who decides how memory is loaded*.

#### Host-project memory (the contract factory establishes)

Factory is a guest in host projects. The host owns its codebase, its artifact tree, and its tooling environment.

Properties at this sub-scope:
- **Factory writes memory artifacts to the host's tracked artifact tree.** Concrete location TBD by a future spec; likely `factory/memory/<...>` alongside `factory/intents/`, `factory/packets/`, etc. — the same artifact tree that already holds factory's other host-project outputs.
- **Factory does NOT write to host-environment-specific locations.** No writes to `~/.claude/projects/<host-encoded>/memory/`, no writes to the host's `docs/decisions/`, no assumptions about the host's editor or CLI tooling.
- **The host owns the loading mechanism.** Whether the host project surfaces factory's memory artifacts to Claude Code (via symlink), to a different agent, to a search index, or to nothing at all — that's the host's decision. Factory provides the artifacts; the host decides what to do with them.
- **Memory categories:** architectural facts, recurring failures, project conventions, code patterns. Operator preferences are explicitly out of scope.

This sub-scope is the load-bearing one for factory-as-a-tool. It is the contract host projects can rely on.

#### Factory-development memory (this repo's own setup)

When developing factory itself (this repo, not host projects), maintainers use a memdir-style symlink that points Claude Code's per-project memory directory at `docs/decisions/`. The symlink is configured via `.claude/settings.local.json` (gitignored).

Properties at this sub-scope:
- **Per-developer, per-machine setup.** Each developer working on factory installs the symlink locally; it doesn't get committed.
- **Specific to THIS repo's development workflow.** Not part of factory's contract with host projects.
- **Uses claurst's typed memory taxonomy** (`User | Feedback | Project | Reference`) encoded in YAML frontmatter, with `MEMORY.md` as the auto-loaded index.
- **Read-only convention today.** No write-side or consolidation layer here either.

Host projects that install factory **are not expected** to adopt this convention. They may, but factory does not impose it.

#### What's still TBD across both sub-scopes

- **Memory write-side** (session_memory analog): a thin write-side now exists for host-project memory in the form of pipeline-generated suggestion reports under `factory/memory/suggestions/`. Durable promotion and richer extraction remain future work.
- **Memory curation/consolidation** (AutoDream analog): periodic consolidation that prunes duplicates, updates stale facts, promotes reinforced observations. Not yet implemented.

This whole arrangement matches claurst's design at the project scope but **not** at the per-invocation worker scope, with the additional refinement that factory respects the host/guest boundary that claurst (a single-user TUI) doesn't have to navigate.

## What this decides

1. **Memory will not be added to the worker layer.** Per-packet agent invocations remain stateless. Recovery from worker failure is via typed recipes, not via learned-memory carry-forward.
2. **Memory IS the project layer's load-bearing pattern.** Investment in memory infrastructure is investment in the project layer.
3. **Project-scope memory has two ownership-distinct sub-scopes.** Host-project memory is what factory writes for host projects; factory-development memory is specific to this repo's evolution. The two are not interchangeable.
4. **For host projects, factory writes memory artifacts to the host's tracked artifact tree** under `factory/memory/` and `factory/cache/`. Factory does **not** write to `~/.claude/...` or any host-environment-specific location.
5. **The host project owns its memory loading mechanism.** Factory produces artifacts; the host decides whether and how to surface them to its AI tooling.
6. **The memdir-style symlink in this repo is per-developer setup, not a contract host projects inherit.** Factory's host-project contract does not assume Claude Code, does not assume the host has a `.claude/` directory, and does not impose the symlink convention.
7. **Memory categories at host-project scope are: architectural facts, recurring failures, project conventions, code patterns.** Operator preferences are explicitly out of scope.

## What this does NOT decide

The following are deferred to a future spec (likely after Phase 6 of `specs/single-entry-pipeline.md`):

- **How suggestion promotion works.** The thin layer writes candidate updates under `factory/memory/suggestions/`, but the durable-promotion contract is still deferred.
- **Whether to implement an AutoDream equivalent** (background consolidation). Not committed.
- **Frontmatter schema details for memory entries.** Whether to mirror claurst's schema (name, description, type), extend it (e.g., add `category`, `severity`, `last_observed`), or define a different one.
- **The agent invocation that performs extraction.** Whether the write-side is a dedicated extraction agent run after each pipeline phase, an in-line extraction during agent runs, or batched/scheduled.
- **Whether host projects can opt OUT of memory writes.** Configurability TBD.

These are implementation questions for a future spec. The decision recorded here is purely the *scope split* (worker vs project, host-project vs factory-development) — not the implementation.

## References

- [`docs/research/claurst_audit.md`](../research/claurst_audit.md) §9 — Memory: three-layer subsystem
- [`docs/research/claw_code_audit.md`](../research/claw_code_audit.md) §12 — Memory: context loading, not learned memory
