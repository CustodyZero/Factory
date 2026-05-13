---
name: Host-project memory documentation note — current architecture, lessons learned, and non-goals
description: >-
  Documentation-only synthesis recorded 2026-05-12. This note does not introduce a new architectural commitment; it summarizes what the factory has already decided about host-project memory, what lessons those decisions encode, and what remains explicitly deferred. It exists so future sessions do not have to reconstruct the host-project memory posture by reading `memory_scope_split.md`, `host_project_memory_graph_rag.md`, `event_observability.md`, and the external research audits in parallel.
type: reference
---

# Host-Project Memory Documentation Note

**Status:** Documentation only. This file is not an implementation spec, not a new decision, and not a commitment beyond the decisions it summarizes.

## Why this note exists

Host-project memory is now spread across several committed decisions plus two external research audits:

- [`../decisions/memory_scope_split.md`](../decisions/memory_scope_split.md)
- [`../decisions/host_project_memory_graph_rag.md`](../decisions/host_project_memory_graph_rag.md)
- [`../decisions/event_observability.md`](../decisions/event_observability.md)
- [`claurst_audit.md`](claurst_audit.md)
- [`claw_code_audit.md`](claw_code_audit.md)

That is enough to reconstruct the current posture, but it is too much to ask every future session to do from scratch. This note exists as a synthesis surface:

- what is already decided
- what lessons those decisions encode
- what is deliberately still deferred

The goal is clarity, not new scope.

## What is already decided

### 1. Worker memory is out; project memory is in

Factory has already committed to the worker/project split:

- **Worker scope** stays stateless.
- **Project scope** is where learned memory belongs.

That is the load-bearing takeaway from [`../decisions/memory_scope_split.md`](../decisions/memory_scope_split.md). Developer / reviewer / QA invocations do not accumulate learned state across packets. Institutional memory, when it exists, belongs to the host project layer.

### 2. Host-project memory is owned by the host project, not by the developer machine

Factory is a guest inside host projects. The committed boundary is:

- memory artifacts are written into the **host's tracked artifact tree**
- factory does **not** write learned memory into per-user home-directory locations
- the host decides how to load or ignore those artifacts

This is the main distinction between host-project memory and this repo's factory-development memory setup. The memdir-style symlink convention used for factory development is explicitly **not** the host-project contract.

### 3. Host-project memory is not a flat notebook

The architectural shape is already committed in [`../decisions/host_project_memory_graph_rag.md`](../decisions/host_project_memory_graph_rag.md):

- typed nodes
- typed edges
- composite weighting
- semantic + graph retrieval
- continuous consolidation
- markdown files as source of truth
- gitignored derived index for fast lookup

This means the question is no longer "should host-project memory exist?" or "should it be a plain markdown folder?" The decision is already past that. The open work is implementation sequencing and unresolved A-decisions.

### 4. Event streams are the extraction substrate

Factory has already committed to typed event streams with provenance labels in [`../decisions/event_observability.md`](../decisions/event_observability.md). That matters for memory because the future write-side is supposed to learn from:

- `live_run` events
- completion records
- escalation/failure records

The memory system is therefore downstream of the observability system. That is an important architectural dependency: memory write-side quality depends on event quality.

## Lessons learned encoded by the current decisions

These are not new decisions. They are the practical lessons the existing docs already imply.

### Lesson 1: Memory quality is a retrieval problem more than a storage problem

The graph-RAG decision is a direct response to a real failure mode: a flat pile of notes does not help an agent unless retrieval can rank and scope them well. The important lesson is:

- more memory is not automatically better
- low-quality retrieval crowds out useful context
- memory that cannot rank contradictions, centrality, and recency will eventually hurt the agent

That is why the committed design is heavier than "just write markdown notes."

### Lesson 2: Memory must be best-effort, not run-blocking

The current architecture intentionally treats memory write-side failures as non-fatal. This is the correct posture. A failed memory write is recoverable; a blocked delivery pipeline is not.

So the right lesson is:

- memory should improve future work
- memory should not be a precondition for present work completing

### Lesson 3: Source-of-truth files must remain human-readable

The decisions preserve markdown files as the file-of-record even though retrieval will rely on a derived index. That encodes a governance lesson:

- operators need to be able to inspect memory directly
- project memory must remain reviewable in git
- the derived index must be rebuildable, not authoritative

This keeps the system auditable and prevents "the vector store knows something the repo does not."

### Lesson 4: Factory-development memory and host-project memory solve different problems

This repo's `MEMORY.md` / `QUEUE.md` / `workflow.md` setup is about evolving factory itself across sessions. Host-project memory is about giving downstream projects durable institutional context.

The lesson is:

- do not generalize this repo's local workflow conventions into the host-project contract
- do not let host-project memory requirements distort the stateless worker model inside the pipeline

The two layers can inform each other, but they should not share implementation assumptions.

### Lesson 5: Documentation is part of the architecture here

The memory design is now distributed enough that documentation drift would become architecture drift quickly. This note exists because the current posture was becoming reconstructible only by reading multiple decisions together.

The lesson is:

- if a future session changes the host-project memory posture materially, this note or its successor needs to move too
- otherwise future workers will re-open already-resolved questions by accident

## What remains explicitly deferred

The following remain open by design:

- embedding model choice
- vector-store dependency choice
- retrieval injection scope
- consolidation cadence
- contradiction resolution policy
- authority resolution when human-authored and extracted memory disagree
- schema versioning strategy
- migration/bootstrap tooling for existing host projects

Those are implementation questions, not documentation gaps.

## What this note should stop future sessions from doing

This note exists to prevent a few predictable mistakes:

1. Treating host-project memory as if it were this repo's local memdir convention.
2. Re-opening the "flat markdown notes vs graph retrieval" question as if it were unsettled.
3. Designing worker-level learned memory for developer/reviewer/QA invocations.
4. Assuming memory writes are allowed to fail the delivery pipeline.
5. Treating event observability and memory as independent systems.

## Recommended next move

If the next step is implementation, the right starting point is still the planned queue item in [`../decisions/QUEUE.md`](../decisions/QUEUE.md):

- **Host-project memory implementation — Stage 1 (schema + storage + write path)**

That work should consume this note as orientation, but the real authority remains the committed decisions it summarizes.

## References

- [`../decisions/memory_scope_split.md`](../decisions/memory_scope_split.md)
- [`../decisions/host_project_memory_graph_rag.md`](../decisions/host_project_memory_graph_rag.md)
- [`../decisions/event_observability.md`](../decisions/event_observability.md)
- [`claurst_audit.md`](claurst_audit.md)
- [`claw_code_audit.md`](claw_code_audit.md)
