---
name: Factory cost visibility — per-invocation tokens and dollars, configurable caps at run/packet/per-day scope
description: Factory tracks the cost of every agent invocation (input/output tokens plus a derived dollar figure where the provider supports it), surfaces aggregate cost per packet, per spec, and per pipeline run, and enforces configurable caps at run, packet, and per-day scope that abort or escalate rather than silently continue. Cost records are written to the host's tracked artifact tree alongside completions, so the host owns the audit trail. Captured at the agent-call boundary in `tools/pipeline/agent_invoke.ts`. Foundational for budget-aware downstream features — recovery retry budgets, multi-spec scheduling, and the manager-executor tiering pattern lifted from claurst — all of which assume per-call cost data exists. Decided 2026-05-01 alongside four other previously-silent research patterns; informed by [claurst_audit.md](../research/claurst_audit.md) §4.4 (`BudgetSplitPolicy`) and §10 (cost tracking).
type: project
---

# Cost Visibility

## Decision

Factory **must** track and surface the cost of agent invocations.

- Every agent invocation records token counts (input/output) and a derived dollar cost when the provider supports cost reporting.
- Aggregate cost is reported per packet, per spec, and per pipeline run.
- Configurable caps abort or escalate when crossed:
  - **per-run cap** — the whole pipeline invocation
  - **per-packet cap** — single-packet limit (e.g., catch runaway recovery loops)
  - **per-day cap** (optional) — daily ceiling for the host project
- Cost records are written to the host's tracked artifact tree (alongside completions), so the host owns the audit trail.

This is recorded as an architectural commitment now (before Phase 5) so downstream features (recovery retry budgets, multi-spec scheduling, manager-executor tiering) can assume cost visibility exists.

## Context

The research audits surfaced cost tracking as a load-bearing pattern in claurst (`Arc<CostTracker>` shared across nested agent calls, `BudgetSplitPolicy` enum, per-preset cost analysis). The first pass of `specs/single-entry-pipeline.md` listed cost tracking implicitly under "deferred infinitely" without an explicit decision — a silent omission that emerged when the research was re-examined against the implementation roadmap.

Cost visibility is foundational because:
- **Recovery (Phase 6) without cost caps is dangerous.** Recovery recipes retry agent invocations on transient failures. Without a cap, a stuck loop burns money silently.
- **Multi-spec orchestration (Phase 5) without budget visibility is blind.** Running three specs in sequence may consume 10x what the human expected; without visibility, the operator finds out from a billing surprise.
- **Manager-Executor tiering** (claurst's pattern: opus manager + sonnet executors) is meaningless without per-call cost data to optimize against.

Reference: [`research/claurst_audit.md`](../research/claurst_audit.md) §4.4 (BudgetSplitPolicy), §10 (cost tracking pattern of interest).

## What this decides

1. **Cost is a first-class signal**, alongside exit code and verification result. Factory tools must surface it.
2. **Per-invocation cost data is captured at the agent call boundary** — the same place `invokeAgent` (or its successor in `tools/pipeline/agent_invoke.ts`) wraps the provider-specific spawn.
3. **Cost is reported in the host's tracked artifact tree.** Specific path TBD by the implementation spec; likely `factory/cost/` alongside `factory/completions/`. The host owns the records.
4. **Three cap scopes** are recognized: per-run, per-packet, per-day. Caps are configurable in `factory.config.json` (defaults disabled — opt-in).
5. **When a cap is crossed, behavior is escalation**, not silent continuation. The cap-crossing event is structured (per the event observability decision); the orchestrator stops the affected scope (the run, the packet) and reports the overage.
6. **No retroactive cost reporting required.** Cost tracking begins when the implementation spec lands; pre-existing completions/runs do not need to be backfilled.

## What this does NOT decide

- **Exact data structure for cost records.** Schema (JSON shape, file naming, indexing) deferred to the implementation spec.
- **Specific dollar derivations per provider.** Codex, Claude, Copilot, etc., each report cost differently or not at all. The implementation spec maps each provider's reported tokens/dollars into a normalized record. Where a provider does not report cost, we record `null` for dollars and only the tokens.
- **Manager-Executor tiering** (claurst's `ManagedAgentConfig` with budget splitting). This is the natural follow-up once cost tracking is operational. Deferred to a separate decision after this one lands.
- **Cost persistence and consolidation** (memory write-side). Cost records are part of the audit trail; whether and how they're consolidated into long-term memory follows from the future memory-write-side spec (per `memory_scope_split.md`).
- **Implementation timing.** Cost tracking can land as a sister spec before Phase 5, between Phase 4 and 5, or as a Phase 4.5. The roadmap discussion that follows this decision will sequence it.

## References

- [`research/claurst_audit.md`](../research/claurst_audit.md) §4.4, §10 — cost tracking and budget splitting patterns
- [`single_entry_pipeline.md`](single_entry_pipeline.md) — the architectural decision this expands; cost tracking informs Phases 5 (multi-spec) and 6 (recovery)
- [`memory_scope_split.md`](memory_scope_split.md) — host-project memory model; cost records are written to the host's tracked artifact tree per the host-project memory contract
- [`event_observability.md`](event_observability.md) — companion decision; cost-cap-crossings emit events
