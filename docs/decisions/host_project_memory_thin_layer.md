---
name: Host-project memory thin layer — curated categories, bounded cache, selective prompt injection
description: >-
  Current host-project memory implementation. Factory provides a thin durable
  memory surface in the host artifact tree plus a bounded transient cache for
  prompt-side reuse. Durable memory remains human-readable and human-curated;
  the pipeline may suggest updates but does not auto-promote them. Prompt
  loading is selective by persona and change context, not global. This
  supersedes the earlier graph-RAG-first implementation direction as the
  operative near-term contract. Locked 2026-05-13.
type: project
---

# Host-Project Memory Thin Layer

## Decision

Factory's current host-project memory contract is a **thin layer**:

- **Durable memory** lives in the host artifact tree under `factory/memory/`
- **Transient cache** lives under `factory/cache/`
- **Prompt injection is selective**, not global
- **Pipeline-generated suggestions require human promotion** before they become durable memory

This is the operative implementation contract today. It replaces the earlier
"graph-RAG as the immediate next shape" direction as the near-term path.

## What exists now

### Durable host-project memory

The durable surface is:

- `factory/memory/MEMORY.md` — small always-loaded index
- `factory/memory/architectural-facts/`
- `factory/memory/recurring-failures/`
- `factory/memory/project-conventions/`
- `factory/memory/code-patterns/`
- `factory/memory/suggestions/` — candidate updates, not authoritative memory

Properties:

- human-readable
- git-committable
- safe to inspect and edit directly
- advisory context, not state of record

### Transient cache

The cache surface is:

- `factory/cache/`

Properties:

- machine-written
- bounded
- safe to delete and rebuild
- not authoritative
- not durable project memory

The current implementation uses it to avoid re-reading and re-ranking prompt
context on every phase invocation when the underlying files have not changed.

### Selective prompt injection

Factory selectively loads durable memory into planner and execution prompts.

The read-side rules are:

- `MEMORY.md` is always eligible as the small index
- additional files are selected by persona and change context
- selection is capped by file count and file size
- `suggestions/` is excluded from authoritative prompt memory

The intent is to keep the always-loaded layer small and avoid a monolithic
"load every note" posture.

### Suggestion-first write behavior

Factory may emit memory suggestions from a run, but it does not auto-promote
those suggestions into durable memory categories.

This preserves a clear boundary:

- pipeline may propose memory updates
- humans review and promote them
- durable memory remains curated

## Why this shape

This thin layer keeps the parts that are already well supported by both
downstream pressure and external patterns:

- strict separation between durable memory and transient cache
- small always-loaded memory surface
- selective retrieval over global prompt stuffing
- human-readable, auditable files of record
- bounded machine state

It deliberately does **not** commit factory to graph indexing, embeddings,
continuous consolidation, or automatic durable-memory promotion.

## What this does not change

This decision does **not** change the earlier scope split:

- worker invocations remain stateless
- host-project memory and factory-development memory remain separate concerns
- host-project memory still belongs in the host artifact tree, not per-user local state

Those boundaries remain load-bearing.

## What remains deferred

The following are still future questions:

- promotion workflow from `suggestions/` into durable categories
- retrieval tuning and category-scoring heuristics
- whether a richer index is justified later
- whether extraction should become more structured than markdown suggestion reports
- whether graph-backed retrieval is ever earned by real host-project pressure

## Relationship to earlier memory docs

- [`memory_scope_split.md`](memory_scope_split.md) remains the boundary decision.
- [`host_project_memory_graph_rag.md`](host_project_memory_graph_rag.md) is retained as a historical target-architecture note, not the current implementation contract.
- [`../research/host_project_memory_reconsideration.md`](../research/host_project_memory_reconsideration.md) explains why the graph-first path was challenged.

## References

- [`memory_scope_split.md`](memory_scope_split.md)
- [`../research/host_project_memory_reconsideration.md`](../research/host_project_memory_reconsideration.md)
- [`../research/host_project_memory_documentation_note.md`](../research/host_project_memory_documentation_note.md)
