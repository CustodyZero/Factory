---
name: Host-project memory — graph-based RAG with typed nodes, composite weights, semantic+graph retrieval, and continuous consolidation
description: >-
  When factory implements the host-project memory write-side (deferred per [memory_scope_split.md](memory_scope_split.md)), it will be a typed knowledge graph with semantic retrieval, weighted nodes, and continuous consolidation — NOT a flat catalog of markdown notes. Nodes are typed (`architectural-fact`, `pattern`, `failure-mode`, `component`, `convention`, `provenance`); edges are typed (`depends-on`, `supersedes`, `contradicts`, `instance-of`, `caused-by`/`prevents`, `applies-to`, `reinforced-by`, `co-occurs-with`); both taxonomies are closed. Each node carries a composite weight vector (reinforcement decay, authority, graph centrality, recency, contradiction flag, retired) — not a single counter — combined at retrieval time. Retrieval is a single pipeline: embedding similarity + k-hop graph traversal from active-context nodes + composite ranking + MMR diversity + per-agent token budget. Source of truth is human-readable markdown in `factory/memory/<category>/<id>.md` (git-committable); a derived SQLite + embedded vector store at `factory/memory/.index/` (gitignored) makes retrieval fast. Extraction runs best-effort at pipeline end and never fails the run; retrieval injects a typed `MemoryContext` block into planner and per-phase prompts; consolidation is first-class (incremental after each run + periodic deeper pass for clustering, contradiction detection, reinforcement reconciliation, decay). Cost cap-cross escalates to "memory not written for this run," not pipeline failure. Reference architectures: Microsoft GraphRAG, Mem0, LightRAG, Cognee, MemGPT. Specific A-decisions (embedding model, vector store dependency, retrieval-injection scope, consolidation cadence, contradiction-resolution policy) are deferred to 4-6 future implementation specs across 3 staging steps. Decided 2026-05-11.
type: project
---

# Host-Project Memory: Graph-Based RAG

## Decision

When factory implements the host-project memory write-side (deferred per [`memory_scope_split.md`](memory_scope_split.md)), it will be a **graph-based knowledge layer with semantic retrieval, weighted nodes, and continuous consolidation** — not a flat catalog of markdown notes.

Specifically:

- **Data model:** typed knowledge graph (typed nodes + typed edges)
- **Node weighting:** composite score (reinforcement, authority, centrality, recency, contradiction-flag, retired), not a single counter
- **Retrieval:** combined semantic similarity + graph proximity + weighted ranking + MMR-style diversity, under a per-agent token budget
- **Consolidation:** continuous and first-class (incremental after each run, plus periodic deeper pass for clustering, contradiction detection, reinforcement, decay)
- **Storage:** file-of-record (markdown + YAML frontmatter, git-committable) plus a derived, gitignored, incremental index (SQLite + embedded vector store)

This doc records the **architectural shape**. Concrete implementation phases, third-party dependency choices, and tuning are deferred to future specs.

## Context

[`memory_scope_split.md`](memory_scope_split.md) committed factory to investing in the project layer's memory and deferred the implementation to a future spec. It did not specify the shape that implementation would take. This decision specifies that shape.

The state of agent-memory architecture in 2026 has converged on **graph-based RAG patterns**. The reference architectures the design draws from:

- **Microsoft GraphRAG** — entity extraction + community detection over a knowledge graph; dual-level (local + global) retrieval.
- **Mem0** — graph-based agent memory with reinforcement and contradiction handling.
- **LightRAG** — dual-level retrieval combining low-level entity facts with high-level relational summaries.
- **Cognee** — typed knowledge graph with consolidation passes.
- **MemGPT** — hierarchical memory with promotion/demotion between scopes.

A flat-catalog approach (claurst's memdir model; our current `docs/decisions/` convention) is good for **human-curated** decisions. It is insufficient for **agent-consumed institutional memory** because it lacks:

- Retrieval ranking (the agent gets either everything or nothing)
- A notion of node centrality (which facts are load-bearing vs incidental)
- Contradiction detection (two notes can silently disagree)
- Learning behavior (a note is either there or not; it doesn't strengthen with reinforcement or fade with disuse)

Retrieval quality is the metric that determines whether memory **helps** or **hurts** agent performance. Bad retrieval wastes context tokens and crowds out signal. No retrieval loses institutional knowledge. Good retrieval requires graph structure, semantic similarity, and weighted ranking — together, not in isolation.

## What this decides

### Data model: typed knowledge graph

**Nodes are typed.** The starting taxonomy:

- `architectural-fact` — a claim about how the host system works ("the orchestrator is single-process")
- `pattern` — a recurring approach ("phase modules export a state-machine + a thin imperative wrapper")
- `failure-mode` — a recurring failure with its triggering signature ("config edits without `--write` produce silent stale state")
- `component` — a concrete artifact in the host repo (file path, module name, route, schema)
- `convention` — a project-specific rule ("never edit migration files after they've shipped")
- `provenance` nodes — `spec`, `packet`, `run` (used to link facts back to where they were learned)

**Edges are typed.** The starting set:

- `depends-on` — structural dependency between components
- `supersedes` — one fact replaces another
- `contradicts` — two nodes disagree (flagged during consolidation)
- `instance-of` — pattern → concrete component(s) that exemplify it
- `caused-by` / `prevents` — failure ↔ convention
- `applies-to` — fact → component (scopes a claim to the part of the system it covers)
- `reinforced-by` — memory node ← provenance node (a run / spec / packet that observed it)
- `co-occurs-with` — statistical edge derived during consolidation (not asserted directly by extraction)

Closed taxonomy. Unknown node or edge types are rejected. New types require a schema change.

### Node weights: composite, not a single counter

Each node carries a **vector of weights**, combined into a composite score at retrieval time:

- **Reinforcement score** — exponential decay over time; each new observation bumps it
- **Authority** — `human-authored` > `extraction-multi-source` > `extraction-single-source`
- **Centrality** — graph-theoretic (PageRank-like) over the typed graph
- **Recency** — time since `last_observed`
- **Contradiction-flag** — does another node disagree with this one? (penalty until resolved)
- **Retired** — explicit human retirement (hard-zero at retrieval; preserved on disk for audit)

A single counter ("times observed") would lose all of this. The composite vector is what lets retrieval distinguish "this is a load-bearing project invariant" from "this was true once for one packet."

### Retrieval: semantic + graph + weighted ranking

Retrieval is a single pipeline, not a choice between modes:

1. **Semantic similarity** — embeddings on `(title + body)` of each node; top-K by cosine similarity to the query
2. **Graph proximity** — k-hop traversal from currently-active context nodes (components touched by the current packet, spec entities, etc.)
3. **Composite ranking** — `score = similarity × node_weight + graph_neighborhood_bonus`
4. **MMR-style diversity penalty** — avoid returning near-duplicate nodes
5. **Per-agent token budget enforcement** — the helper returns a typed `MemoryContext` block sized to fit the agent's budget

The combined pipeline is what makes retrieval useful. Semantic similarity alone misses graph context (the fact that *this* node is structurally central to the current packet). Graph traversal alone misses semantic similarity (a related fact that doesn't share an edge yet). Weighting alone applied to either misses the other dimension. All three are required.

### Consolidation: continuous, first-class

Consolidation is **not** a "we'll add it later" afterthought. It is the mechanism that keeps memory from accumulating duplicates and stale facts.

Two cadences:

- **Incremental** — after each pipeline run, on the affected subgraph only. Cheap. Updates reinforcement, recency, and the edges touched by the run.
- **Periodic deeper pass** — clustering (e.g., community detection on the typed graph), contradiction detection via claim extraction + entailment, reinforcement reconciliation, decay sweep, retirement flagging. Expensive. Operator-triggered or scheduled.

Specific behaviors:

- **Reinforcement** — when a new observation matches an existing node, the node's reinforcement score bumps and `last_observed` updates. No duplicate node is created.
- **Decay** — unreinforced nodes lose weight over time. Below a threshold, they're flagged for human review or auto-retired (policy TBD).
- **Contradiction handling** — two nodes that `contradicts` each other are flagged. Resolution policy (auto-retire older vs flag for human) is deferred.

### Storage: file-of-record + derived index

- **Source of truth:** `factory/memory/<category>/<id>.md` — markdown body + YAML frontmatter. Human-readable. Git-committable. Operators can edit memory directly.
- **Derived index:** `factory/memory/.index/` — SQLite + embedded vector store (sqlite-vec or equivalent). Rebuilt incrementally on write; full rebuild on demand. Gitignored.

The file-of-record stays human-readable so operators can inspect, edit, and version memory like any other artifact in the host tree. The derived index makes retrieval fast. Neither layer can claim correctness alone — they must stay in sync, and the index must be rebuildable from the files of record.

### Write path

- Extraction is an **agent invocation** that runs at pipeline end (or per-phase — A-decision deferred to the implementation spec)
- **Inputs:** the run's events JSONL (per [`event_observability.md`](event_observability.md)), completions, escalations, and the existing graph
- **Outputs:** new nodes + edges, or reinforcement instructions for existing nodes
- **Persistence:** orchestrator writes the markdown files and triggers an incremental index update
- **Best-effort:** extraction failure does NOT fail the pipeline run. Memory loss for one run is recoverable; a pipeline failure is not.

### Read path

- The memory-context injection point lives in agent prompts: the **planner** (query = the spec) and **per-phase agents** (query = spec + packet + touched components)
- A single helper produces a typed `MemoryContext` block from top-N retrieval and budget
- The helper is the **boundary** between memory storage and prompt rendering — phase modules never reach into the graph directly

### Host integration

- Source files live in `factory/memory/<category>/<id>.md` — host commits these as part of its tracked artifact tree (matching the [`memory_scope_split.md`](memory_scope_split.md) contract).
- Derived index lives in `factory/memory/.index/` — gitignored, per-machine.
- The host owns whether and how to surface source files to its own AI tooling (Claude Code, agent search, dashboards, etc.) — factory does not impose a loading mechanism.
- Factory ships a **recommended-but-not-required** setup (likely a symlink convention mirroring factory-development memory). The implementation spec defines this; hosts that decline it lose nothing structural.

### Cost model

- Extraction and consolidation are agent invocations and respect the cost caps from [`cost_visibility.md`](cost_visibility.md) (Phase 5.7)
- A cap-cross on memory operations escalates to **"memory not written for this run"** rather than failing the pipeline. Memory is best-effort by design.
- Embedding model choice (local via Ollama vs hosted) is an A-decision deferred to the implementation spec

## What this does NOT decide

- **Specific embedding model.** Local Ollama / hosted OpenAI / Voyage / other — A-level choice; cost-vs-portability tradeoff. Local preserves zero-network-deps and reproducibility; hosted preserves quality.
- **Whether `sqlite-vec` is the right vector store.** A-level choice between an acceptable native-binary dependency and preserving the current zero-binary-deps posture.
- **Retrieval-injection scope.** Every agent call vs planner-only. Cost-vs-context-completeness tradeoff. A-level.
- **Consolidation cadence.** Every run / every N runs / operator-triggered. A-level.
- **Authority resolution policy when human-authored entries contradict agent-authored.** Human wins is the obvious default; the formal rule is TBD.
- **Schema versioning strategy.** How to evolve node and edge taxonomies without breaking existing memory.
- **Contradiction resolution policy.** Auto-flag for human review vs auto-retire older. A-level.
- **Migration tooling for hosts bootstrapping memory.** How a host project that has been running for months gets its existing institutional knowledge into the graph.
- **Implementation phasing.** Probably 3 stages spread across 4-6 specs (see below). Specific dependencies and sequencing live in the implementation specs, not here.

## Implementation cost (honest scope)

This is **not** a single mini-spec. The expected work is **4-6 specs over multiple weeks**:

1. **Schema + storage layer** — markdown source files + SQLite+vector index + write/read primitives; no extraction or retrieval logic yet
2. **Extraction agent** — prompt design, structured output contract, persistence pipeline; produces nodes + edges from events JSONL
3. **Retrieval** — combined semantic similarity + graph traversal + weighted scoring + MMR; the `MemoryContext` helper
4. **Read-side prompt integration** — `MemoryContext` injection in planner + per-phase prompts; budget enforcement; A/B-able by config
5. **Consolidation** — incremental pass; periodic deeper pass; clustering, contradiction detection, reinforcement, decay
6. **Host integration + opt-out + migration** — recommended-but-not-required loading convention; opt-out flag; bootstrap tooling

### Staging recommendation

Three stages, each shippable and observable on its own:

- **Stage 1** — Schema + write-side + flat semantic retrieval, **no graph edges yet.** Proves the write path, storage model, and basic retrieval. Specs 1 + 2 + a stripped-down 3.
- **Stage 2** — Add graph edges, k-hop traversal, weighted ranking, MMR. Full retrieval pipeline. Specs 3 (full) + 4.
- **Stage 3** — Consolidation, reinforcement, contradiction handling, decay. Spec 5. Spec 6 (host integration + migration) lands alongside whichever stage it's needed for.

This staging is a **recommendation**, not a commitment. The implementation specs may resequence.

## References

- [`memory_scope_split.md`](memory_scope_split.md) — the parent decision; this extends it from "deferred" to "architectural shape committed, implementation deferred"
- [`event_observability.md`](event_observability.md) — the memory write-side consumes the event stream
- [`cost_visibility.md`](cost_visibility.md) — extraction and consolidation respect cost caps
- External: Microsoft GraphRAG (2024), Mem0, LightRAG, Cognee, MemGPT — the reference architectures the design draws from
