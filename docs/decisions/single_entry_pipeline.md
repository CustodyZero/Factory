---
name: factory-single-entry-pipeline
description: Factory has exactly one human entry point — run.ts — accepting one or more spec IDs. The factory drives plan, develop, review, verify, recovery, and completion without further human interaction. Internal lifecycle scripts remain as the agent-facing protocol. Recovery is scenario-recipe based with two-layer provider failover (cross-CLI and within-CLI for abstraction providers). LintFailed and TestFailed always escalate — auto-recovery would invite agents to disable rules or mutilate tests. Sequential dependency-aware first; parallel later.
type: project
---

# Single Entry Pipeline

## Decision

Factory has exactly one entry point that humans invoke during normal operation:

```
npx tsx tools/run.ts <spec-id> [<spec-id>...]
```

From there, the factory drives the full lifecycle to completion across all named specs:

- Plan each spec (translate spec → intent, invoke planner agent)
- Develop each packet within each intent (developer + code reviewer + complete)
- Verify each QA packet (QA agent + complete)
- Recover from known failure scenarios autonomously (one attempt per scenario before escalation)

No other CLI script is documented as user-facing. The internal lifecycle scripts (`start`, `request-review`, `review`, `complete`) remain as the agent-facing protocol and as library functions for `run.ts`, but humans do not invoke them directly during normal pipeline runs.

## Context

This decision came out of the design conversation following [`research/factory_script_audit.md`](../research/factory_script_audit.md). The audit identified `run.ts` as the load-bearing weakness (798 lines, no tests, doing seven distinct jobs) and noted the "strict scripts + idempotent orchestrator" pattern as implicit architecture.

The directive: minimize human interaction. The factory is meant to be a deterministic orchestrator that takes specs in and produces completed work out, with humans involved only at spec authoring, recovery escalation, and final review.

This decision does not establish that goal — it commits the factory to it.

## Architecture: four layers

The new `run.ts` is decomposed into four layers with clear responsibilities:

```
┌─────────────────────────────────────────────────────┐
│  ENTRY                                              │
│  tools/run.ts                                       │
│  Arg parsing, spec resolution, dispatch.            │
│  No business logic.                                 │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  DRIVER                                             │
│  tools/pipeline/orchestrator.ts                     │
│  Topo-sort specs, sequence per-spec pipelines,      │
│  detect spec-level failures and block dependents.   │
└──────────────────────┬──────────────────────────────┘
                       │ (per spec, in dependency order)
┌──────────────────────▼──────────────────────────────┐
│  PHASES                                             │
│  pipeline/plan_phase.ts                             │
│  pipeline/develop_phase.ts                          │
│  pipeline/verify_phase.ts                           │
│  Each phase is a pure state machine over disk       │
│  state, with a thin imperative wrapper that         │
│  invokes agents and lifecycle calls.                │
└──────────────────────┬──────────────────────────────┘
                       │ (every state transition)
┌──────────────────────▼──────────────────────────────┐
│  LIFECYCLE                                          │
│  tools/lifecycle/start.ts                           │
│  tools/lifecycle/request_review.ts                  │
│  tools/lifecycle/review.ts                          │
│  tools/lifecycle/complete.ts                        │
│  Each exposes both a CLI (for agents) and a         │
│  library function (for run.ts/phases).              │
│  Each is idempotent: detects "already done"         │
│  state and returns success without error.           │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  RECOVERY (orthogonal — wraps phases)               │
│  tools/pipeline/recovery.ts                         │
│  Classify failures into scenarios; look up          │
│  recipe; one recovery attempt per scenario;         │
│  escalate if recovery fails.                        │
└─────────────────────────────────────────────────────┘
```

### Why four layers

- **Driver** holds the multi-spec sequencing logic. It knows nothing about packets or agents.
- **Phases** hold per-spec lifecycle logic. They know nothing about specs other than being invoked once per spec.
- **Lifecycle** holds atomic state transitions. They know nothing about phases or specs.
- **Recovery** is a cross-cutting concern that intercepts failures from any phase.

Each layer is independently testable. The driver can be tested with stub phases. Phases can be tested with stub lifecycle. Lifecycle can be tested with disk fixtures. Recovery can be tested with fault-injected scenarios.

## CLI-as-agent-protocol

Lifecycle scripts (`start`, `request-review`, `review`, `complete`) remain as CLI scripts.

Reasoning:

- **The CLI invocation is itself the structured event.** When a developer agent runs `npx tsx tools/request-review.ts p1`, the act of invocation is the signal. The orchestrator does not need to parse LLM output.
- **LLMs are unreliable at structured output.** Asking agents to return JSON imposes a parser-correctness burden on the agent and a parsing-correctness burden on the orchestrator. The CLI script keeps the contract clean.
- **Hooks have a natural surface.** Pre/post-script hooks can intercept either the CLI path (used by agents) or the library path (used by `run.ts`).
- **Separation of concerns.** `run.ts` is a deterministic actor; LLM-output parsing would smuggle interpretation into the deterministic layer.

What changes is the **audience**:

- Today: `AGENTS.md` and `CLAUDE.md` document these scripts as commands humans (or anyone) might run.
- After this decision: documentation describes them as the agent-to-factory protocol. They are not advertised as user-facing commands. The expectation is that `run.ts` is the only command users run.

The scripts themselves are unchanged in their CLI contract. Documentation is updated.

## Idempotency of lifecycle scripts

`start.ts` is currently the only lifecycle script that detects "already done" state and returns success silently. The other three (`request-review`, `review`, `complete`) error on re-run.

This decision commits to making **all four lifecycle scripts properly idempotent**, following the `start.ts` pattern:

| Script | Already-done detection | Behavior |
|--------|------------------------|----------|
| `start.ts` | `started_at` present | Print "already started," exit 0 |
| `request-review.ts` | status is `review_requested` | Print "review already requested," exit 0 |
| `review.ts` | status is `review_approved` (matching `--approve`) or `changes_requested` (matching `--request-changes`) | Print "decision already recorded," exit 0 |
| `complete.ts` | completion record exists | Print "already complete," exit 0 |

This removes the "strict-script + idempotent-orchestrator" coupling. After the change:

- The orchestrator no longer needs to read state defensively before each lifecycle call.
- External callers (humans recovering from a stuck pipeline, future orchestrators) can re-invoke without errors.
- The strict invariants (FI-1 one-completion-per-packet) are preserved — the script still refuses to *create a duplicate completion*; it just returns success when the existing completion already satisfies the request.

`complete.ts` requires special care: the success-on-rerun path must not re-run build/lint/test (those already ran when the completion was originally created). Detecting "completion exists, return success" must happen *before* the verification step.

## Multi-spec semantics

`run.ts <spec-1> <spec-2> <spec-3>` runs the pipeline for each spec in **sequential dependency-aware** order:

1. Load each spec's frontmatter (per [`spec_artifact_model.md`](spec_artifact_model.md)).
2. Topo-sort specs by `depends_on`. Cycles are rejected upfront.
3. Process specs one at a time, in topological order:
   - For each spec, run plan → develop → verify to completion (or scenario-driven failure)
   - If a spec fails after recovery, all dependent specs are marked blocked and not attempted
   - Independent specs are still attempted (one failure does not abort the whole run)
4. Report final status across all specs.

### Why sequential first

- Sequential is simpler to reason about and to test.
- Dependency-aware sequencing is the harder design problem; doing it first means the parallel jump later is largely an executor change, not a planner change.
- The unit of parallelism is "one spec's pipeline" — each is self-contained. Adding parallelism later does not invalidate the sequential design; it adds an outer scheduler over the same per-spec pipeline.

### Future: parallel execution

Adding parallelism later requires:

- Worktree-per-spec isolation (claurst pattern from research)
- A scheduler that launches independent specs concurrently up to a budget
- Provenance labels on agent events so concurrent specs don't poison each other's logs

This decision does **not** commit to that work. It only commits to a design that doesn't preclude it.

## Recovery

Failures during any phase are classified into **scenarios** and routed through **recipes**. One recovery attempt per scenario per failure; if recovery fails, escalate.

### Scope (in for first pass)

| Scenario | Trigger | Recipe |
|---|---|---|
| `ProviderTransient` | Single API 5xx, 429, network timeout, connection error | Wait `n` seconds; retry the **same provider/model** once before reclassifying as `ProviderUnavailable` |
| `ProviderUnavailable` | `ProviderTransient` exhausted, or repeated provider failures | Try the next entry in the within-CLI `model_failover` list (if configured) on the same CLI provider. If exhausted, fall through to the next CLI provider in the persona's `persona_providers` list. If all CLIs exhausted, escalate. |
| `BuildFailed` | `complete.ts` reports build failure | Re-invoke developer agent with build error appended to prompt and explicit guardrail (*"Fix the implementation. Do not modify tests, build configuration, or lint configuration."*); retry once. On second failure, escalate. |
| `LintFailed` | `complete.ts` reports lint failure | **Escalate.** Auto-recovery would invite the agent to disable lint rules rather than fix code violations. |
| `TestFailed` | `complete.ts` reports test failure | **Escalate.** The agent has no mandate to decide whether tests are wrong or its implementation is wrong; "make the tests pass" is the failure mode where agents mutilate tests to clear errors. Humans decide. |
| `StaleBranch` | Detected branch is behind main at request-review or complete | Run `git fetch && git rebase origin/main` from the worktree; abort rebase on conflict; retry once. If conflict, escalate. |
| `AgentNonResponsive` | Agent exits non-zero with no output | Treat as `ProviderTransient` |
| `CompletionGateBlocked` | Pre-commit hook FI-7 violation | Cannot auto-recover (intentional human gate). Escalate. |

### Provider failover (the `ProviderUnavailable` recipe in detail)

Factory recognizes two classes of provider:

- **Direct providers** (codex, claude) — the CLI maps to a single upstream provider. A model failure at this layer typically means the CLI's primary model is down, and the right move is to fall through to the next CLI.
- **Abstraction providers** (copilot) — the CLI routes to multiple underlying models. "Opus is down" does not mean "copilot is down" — copilot may still successfully serve a GPT-5 or Gemini call.

To express this, the provider config gains an optional `model_failover` field:

```json
"copilot": {
  "command": "gh copilot --",
  "model_map": {
    "high": "claude-opus-4-6",
    "medium": "GPT-5.4",
    "low": "claude-haiku-4-5"
  },
  "model_failover": ["claude-opus-4-6", "GPT-5.4", "claude-haiku-4-5"]
}
```

Direct providers (codex, claude) do not set `model_failover`. The field is reserved for abstraction providers.

The escalation cascade for `ProviderUnavailable`:

1. Failure on `<CLI>` with `<model>` → if `<CLI>.model_failover` is configured, try the next entry on the same CLI
2. Same-CLI failover exhausted (or not configured) → fall through to the next CLI in the persona's `persona_providers` list
3. New CLI fails → recurse: same-CLI failover, then next-CLI failover
4. All CLIs in `persona_providers` exhausted → escalate

### Schema change: `persona_providers` becomes an ordered list

Today:

```json
"persona_providers": {
  "developer": "codex",
  "code_reviewer": "claude",
  ...
}
```

After this decision:

```json
"persona_providers": {
  "developer": ["codex", "claude", "copilot"],
  "code_reviewer": ["claude", "copilot"],
  ...
}
```

A single string is still accepted (treated as a one-element list) for backward compatibility. The schema change is additive: existing configs with `"developer": "codex"` continue to work; new configs can opt into failover by switching to an array.

### Out of scope (deferred)

- `McpHandshakeFailure` — factory does not currently use MCP servers in pipeline
- `TrustPromptUnresolved` — factory uses bypass-permissions providers
- `WorkspaceMismatch` — single-worktree assumption holds in sequential mode

### Recipe shape

Recipes are pure functions:

```typescript
type RecoveryRecipe = (
  scenario: FailureScenario,
  context: FailureContext,
) => RecoveryAttempt | EscalateRequest;
```

A `RecoveryAttempt` describes the action to take; the orchestrator executes it and observes whether the original phase now succeeds. An `EscalateRequest` writes a structured failure record to `factory/escalations/<spec-id>-<timestamp>.json` and skips dependent specs.

### Recovery budget

- Maximum 1 attempt per scenario per packet per phase invocation
- Maximum 3 total recovery attempts per packet across all scenarios
- After budget exhausted, the packet is marked `failed` and the spec is marked blocked

These bounds keep recovery from infinite-looping on degraded providers or genuinely broken work.

## Module decomposition

### Proposed file shape

```
tools/
├── run.ts                         # entry only
├── pipeline/
│   ├── orchestrator.ts            # multi-spec driver, topo sort
│   ├── plan_phase.ts              # plan phase logic
│   ├── develop_phase.ts           # dev state machine
│   ├── verify_phase.ts            # qa loop
│   ├── prompts.ts                 # all prompt builders
│   ├── recovery.ts                # FailureScenario + recipes
│   └── agent_invoke.ts            # provider-specific spawn logic
├── lifecycle/
│   ├── start.ts                   # CLI + exported function
│   ├── request_review.ts          # CLI + exported function
│   ├── review.ts                  # CLI + exported function
│   └── complete.ts                # CLI + exported function
├── config.ts                      # unchanged
├── output.ts                      # unchanged
├── status.ts                      # unchanged
├── validate.ts                    # unchanged in this decision
├── completion-gate.ts             # unchanged
├── plan.ts                        # library kept; CLI surface trimmed
└── execute.ts                     # library kept; CLI surface trimmed
```

### What gets deleted

Nothing in the first pass. Migration is additive: new modules under `pipeline/` and `lifecycle/`, with the existing `tools/*.ts` files updated to delegate to them. Once the new structure is proven and tested, a follow-up cleanup deletes the old monolith.

### What gets tested

Every module under `pipeline/` and `lifecycle/` must have unit tests for its pure logic before merge. The imperative wrappers (the parts that touch disk or shell out) can remain untested in the first pass, but the testable surface area must be larger than today.

Specifically, **before this decision is implemented**:

- The dev-phase state machine has no tests
- Recovery has no tests (because it doesn't exist)
- Multi-spec sequencing has no tests (because it doesn't exist)

**After implementation**, all three must have tests covering the happy path and at least one failure path each.

## What this decides

1. `run.ts` is the only user-facing CLI for pipeline runs.
2. Lifecycle scripts (`start`, `request-review`, `review`, `complete`) are agent-facing protocol; humans don't invoke them.
3. All lifecycle scripts become properly idempotent (the `start.ts` pattern extended).
4. The pipeline is decomposed into four layers (driver / phases / lifecycle / recovery) plus prompt and agent-invocation modules.
5. Multi-spec runs are sequential and dependency-aware in the first pass.
6. Recovery is scenario-recipe based with a defined scope of eight scenarios. Auto-recoverable: `ProviderTransient`, `ProviderUnavailable` (via cross-CLI and within-CLI model failover), `BuildFailed` (with guardrail prompt), `StaleBranch`, `AgentNonResponsive`. Escalate-only: `LintFailed`, `TestFailed`, `CompletionGateBlocked`. The `LintFailed` and `TestFailed` scenarios are deliberately NOT auto-recoverable — auto-recovery invites agents to disable rules or mutilate tests rather than fix code.
7. Provider failover operates at two layers: cross-CLI (`persona_providers` becomes an ordered list) and within-CLI (`model_failover` is an optional list of model IDs on abstraction providers like copilot).
8. The new modules ship with unit tests; the imperative shells may remain untested in the first pass but the testable surface must grow substantially.

## What this does NOT decide

- **Parallel execution.** Designed-for, not committed-to.
- **Validate.ts replacement with ajv.** Separate concern; flagged in the audit; deferred.
- **PRD/roadmap views.** Out of scope.
- **Memory write-side and consolidation.** Per [`memory_scope_split.md`](memory_scope_split.md), deferred.
- **Specific failure detection heuristics.** The recipes need detection logic; the exact regex/string-match for "this is API 5xx" vs "this is rate limit" is implementation detail, not architecture.
- **Hook system surface.** This decision establishes that hooks have a natural surface (CLI vs library entry); it does not commit to building a hook system. Hooks are a future-allowed feature, not in-scope for this work.
- **Implementation order.** A separate plan will sequence the work into reviewable steps.

## References

- [`research/factory_script_audit.md`](../research/factory_script_audit.md) — diagnosis of run.ts and the script surface
- [`research/claurst_audit.md`](../research/claurst_audit.md) — manager-executor / worktree isolation / single-loop patterns
- [`research/claw_code_audit.md`](../research/claw_code_audit.md) — recovery recipes / lane events / failure classification
- [`spec_artifact_model.md`](spec_artifact_model.md) — companion decision establishing the spec layer
- [`memory_scope_split.md`](memory_scope_split.md) — pipeline-scope vs project-scope boundary that this design respects
