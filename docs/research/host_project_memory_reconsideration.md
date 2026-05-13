---
name: Host-project memory reconsideration — challenge note against premature graph-RAG commitment
description: >-
  Research/challenge note recorded 2026-05-12. This document explicitly challenges the current host-project memory direction, especially the jump from "project-scope memory belongs in the host artifact tree" to "host-project memory should be graph-RAG with consolidation." It does not overturn existing decisions by itself; it records the case for reopening the question and proposes a thinner decision sequence grounded in actual host-project usage before committing implementation effort.
type: lesson
---

# Host-Project Memory Reconsideration

**Status:** Challenge note. This is not an implementation plan. It is a case for reopening the current host-project memory direction before implementation starts.

## The pushback

The current host-project memory stack has three layers of commitment:

1. **Worker memory stays stateless.**
2. **Project memory, if it exists, belongs in the host project's tracked artifact tree.**
3. **Host-project memory should be graph-based RAG with typed nodes, weighted retrieval, and consolidation.**

The first two are defensible. The third is much less proven.

This note records the argument that factory may have moved too quickly from:

- "host projects probably need durable institutional memory"

to:

- "therefore the right architecture is graph-RAG with extraction, indexing, retrieval, and consolidation"

without enough evidence from real host-project use.

## What still looks solid

These parts are not the problem:

- **Worker memory should remain stateless.** This matches the packet model, idempotency, recovery design, and replaceable-agent posture.
- **Host-project memory should not live in per-user local state.** If factory writes memory as a host-project tool, it should write into the host's tracked artifact tree.
- **Event streams are the right extraction substrate if memory exists.** If a write-side is implemented, typed `live_run` events are the right source.

If the host-project memory direction is reopened, these are the parts most likely worth preserving.

## What looks under-evidenced

These parts are not yet justified strongly enough by observed host-project pain:

- **Graph-RAG as the default end-state**
- **Continuous consolidation as a first-class subsystem**
- **Automatic write-side extraction at pipeline end**
- **The assumption that host-project memory should be factory-owned rather than host-curated**
- **The assumption that memory should be built now rather than after more host-project experience**

This is not an argument that the graph-RAG design is wrong in principle. It is an argument that it is **too early** to treat it as the practical next step.

## The core question

What exact failure are we trying to fix?

That needs a sharper answer than "agents forget things."

Possible real problems:

- project conventions are not consistently surfaced to planner/developer/reviewer/QA agents
- recurring failures repeat across intents because lessons are not persisted in a usable way
- architectural invariants are documented, but not retrievable in packet-local context
- humans learn something while shipping one feature and want the next feature to inherit it

Those are not all the same problem. A graph-memory system may help some of them, but it may be overkill or the wrong shape for others.

## The main challenge to the current direction

The current graph-RAG decision seems to optimize for the **most sophisticated plausible future** before factory has proven the **minimum useful present**.

That creates several risks:

### Risk 1: solving retrieval before proving memory authoring

The current direction is retrieval-heavy:

- embeddings
- typed graph
- composite ranking
- MMR
- consolidation

But none of that matters if the project does not yet know:

- what the unit of memory is
- who writes it
- how often it changes
- how trustworthy extracted facts are

If authoring and curation are not stable, optimizing retrieval early is premature.

### Risk 2: building a heavy system for a thin problem

If most real host-project memory needs are actually:

- 5-20 project conventions
- a handful of recurring failure modes
- a small number of architectural facts

then a full graph system may be a large maintenance burden for a problem that could be solved with curated markdown artifacts and a simple retrieval policy.

### Risk 3: factory starts owning knowledge the host may want to own differently

Even if memory belongs in the host artifact tree, it is not obvious that **factory** should be the primary author and curator of that memory.

Some host projects may prefer:

- human-authored notes with factory only reading them
- factory-generated suggestions that humans accept or reject
- no memory writes at all, only read-side support

The current direction leans toward factory-managed institutional memory before that ownership question is settled.

### Risk 4: extraction quality is harder than the current docs imply

The event model is a good substrate, but extraction is still hard:

- architectural facts are not always inferable from events
- recurring failures may be obvious only after clustering across runs
- code patterns may require code understanding, not just event inspection
- contradiction detection is non-trivial even in rich systems

That does not mean extraction should never happen. It means extraction should probably not be treated as an obvious near-term Stage 1 capability.

## A thinner alternative sequence

If the question is reopened, the likely better sequence is:

### Option A: no host-project memory yet

Keep relying on:

- specs
- packets
- features
- completions
- event streams

Use this if the real host-project pain is still not clear enough.

### Option B: curated note memory only

Add a very small, human-readable memory surface under the host artifact tree:

- `factory/memory/architectural-facts/`
- `factory/memory/recurring-failures/`
- `factory/memory/code-patterns/`

Properties:

- human-authored or human-curated
- no embeddings
- no graph
- no automatic extraction
- simple optional read-side injection

This proves the authoring model first.

### Option C: extracted flat memory

Factory writes structured notes or fact entries, but still without graph edges or heavy consolidation.

Properties:

- extraction exists
- retrieval stays simple
- source of truth remains inspectable
- the system proves whether automatic writing is even useful

This is the natural bridge between "no memory" and "graph memory."

### Option D: full graph-RAG memory

Only after real host-project usage shows that:

- flat memory is insufficient
- retrieval quality is the real bottleneck
- contradiction and consolidation are recurring problems
- projects are willing to carry the extra complexity

At that point the graph architecture is earned rather than speculative.

## Questions that should be answered before implementation

1. Is host-project memory **required**, **optional**, or **advisory-only**?
2. Who is the primary author?
3. What is the minimum unit of memory?
4. What concrete host-project failures will the first implementation solve?
5. What is the smallest useful read path?
6. What evidence would justify moving from flat memory to graph memory?

Until those questions are answered from real host-project usage, implementation should be conservative.

## Recommended decision reset

The likely better posture is:

- keep `memory_scope_split.md` as-is
- treat the current graph-RAG note as a **possible target architecture**, not the default implementation path
- re-open the host-project memory direction with a thinner comparative decision

That comparative decision should evaluate:

- no memory
- curated markdown memory
- extracted flat memory
- graph-RAG memory

against concrete host-project use cases and failure modes.

## External patterns that matter

There is enough external signal now that factory should not pretend it is reasoning from scratch.

### 1. Scoped memory is the norm

Public systems consistently separate memory by scope:

- Anthropic Claude Code: project instructions vs auto-written repository memory
- Letta: core in-context memory vs external archival memory
- Mem0: conversation vs session vs user vs organizational memory
- LangChain / Deep Agents: short-term thread state vs long-term store

That strongly supports the existing intuition that factory should split:

- transient execution cache/state
- durable host-project memory
- factory-development memory

### 2. The always-loaded layer stays small

The practical systems that work well do not load everything all the time.

- Claude Code keeps project instructions concise and caps startup auto-memory loading
- LangChain Deep Agents distinguishes startup-loaded memory from on-demand loaded files
- Letta distinguishes always-visible core memory from retrieved external memory

That argues against an unbounded monolithic host-project memory file.

### 3. Consolidation exists, but it is gated and bounded

The more serious systems do support memory consolidation, but not as an unbounded append stream.

- Claurst's AutoDream uses explicit time/session/lock gates before consolidation runs
- LangChain Deep Agents documents background consolidation as an optional pattern
- Cognee and Mem0 both emphasize promotion / fusion / consolidation rather than endlessly stuffing raw history into the active layer

That supports consolidation as a later capability, but not "append every lesson forever."

### 4. Retrieval sophistication is optional, not universal

External systems disagree about how much infrastructure memory needs:

- Claude Code gets value from layered files plus auto-memory
- LangGraph can use simple JSON document stores
- Letta uses memory blocks + external search
- Mem0 and Cognee push much harder toward hybrid search, entity linking, and graph-heavy retrieval

This is exactly why factory should compare alternatives before committing to graph-RAG as the immediate Stage 1 shape.

## Revised recommendation

The right standard is not:

- "wait until factory has perfect local evidence"

It is:

- "use external patterns to narrow the design space, then validate the shortlist against host-project needs before committing to a heavy implementation path"

## What this note recommends next

1. **Do not treat graph-RAG as the automatic next implementation step.**
2. **Write a comparative decision note** that explicitly weighs external patterns and local host-project needs.
3. **Use both evidence sources**:
   - public and industry patterns
   - real host-project failure modes from factory usage
4. If the pressure remains "we need memory now," the most defensible first implementation is still probably **curated note memory** or **flat extracted memory**, not full graph-RAG on day one.

## References

- [`../decisions/memory_scope_split.md`](../decisions/memory_scope_split.md)
- [`../decisions/host_project_memory_graph_rag.md`](../decisions/host_project_memory_graph_rag.md)
- [`../decisions/event_observability.md`](../decisions/event_observability.md)
- [`host_project_memory_documentation_note.md`](host_project_memory_documentation_note.md)
- [`claurst_audit.md`](claurst_audit.md)
- [`claw_code_audit.md`](claw_code_audit.md)
