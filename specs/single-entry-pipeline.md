---
id: single-entry-pipeline
title: Decompose run.ts and implement the four-layer pipeline architecture
depends_on: []
---

# Single Entry Pipeline

## Context

Factory at v0.2.0 runs through a single 798-line `run.ts` script with no automated tests on its imperative core. The [`factory_script_audit`](../docs/research/factory_script_audit.md) identified this as the load-bearing weakness: every other reliability concern in the toolkit is downstream of `run.ts`.

Three architectural decisions ([`memory_scope_split`](../docs/decisions/memory_scope_split.md), [`spec_artifact_model`](../docs/decisions/spec_artifact_model.md), [`single_entry_pipeline`](../docs/decisions/single_entry_pipeline.md)) committed factory to:

- One human entry point (`run.ts <spec-id> [<spec-id>...]`)
- Four-layer architecture (driver / phases / lifecycle / recovery)
- CLI scripts as the agent-facing protocol
- Idempotent lifecycle scripts (no error on re-run)
- Sequential dependency-aware multi-spec runs
- Scenario-recipe based recovery with two-layer provider failover
- Specs as new human-authored artifacts at a higher level than intents
- Project-scope memory; worker-scope statelessness

This spec is the implementation work to land those decisions.

## Goal

End state: factory has the architecture above. Specifically:

1. The pipeline lifecycle is decomposed into testable modules under `tools/pipeline/` and `tools/lifecycle/`; the four-layer architecture (entry / driver / phases / lifecycle) is fully realized.
2. `run.ts` is reduced to entry-point glue (target: under 200 lines after Phase 4.5)
3. Lifecycle scripts are individually idempotent
4. `run.ts` calls lifecycle functions directly; agents call lifecycle CLIs
5. Specs are first-class: `specs/<id>.md` files, frontmatter-validated, translated to intents at run time
6. Multi-spec runs work with `depends_on` topo-sort
7. Pipeline emits typed events with provenance labels (live_run / test / healthcheck / replay / dry_run)
8. Per-invocation cost is tracked, surfaced, and capped (per-run / per-packet / per-day)
9. Failures route through the recovery layer; the eight defined scenarios behave per spec; recovery operates on events and respects cost caps
10. Provider failover works at both the cross-CLI and within-CLI layers
11. Documentation reflects the single-entry-point reality

## Acceptance criteria for the spec as a whole

- All 98 baseline tests still pass; test count grows substantially across all phases
- `run.ts <spec-id>` produces the same end-state artifacts as `run.ts <intent-id>` did before, given the same input work
- `npx tsx tools/run.ts spec-a spec-b` with `spec-b.depends_on: [spec-a]` runs spec-a to completion before starting spec-b; if spec-a fails, spec-b is reported blocked and not attempted
- After Phase 5.5, every pipeline run produces a typed event stream under `factory/events/<runId>.jsonl`
- After Phase 5.7, every pipeline run produces a cost record stream under `factory/cost/<runId>.jsonl`; configurable caps abort at the right scope
- A simulated provider 5xx error triggers `ProviderTransient` retry; persistent failure escalates to `ProviderUnavailable` failover; all-providers-down escalates with a structured failure record
- A test failure during `complete.ts` does not trigger an auto-retry; it surfaces as an escalation
- A build failure during `complete.ts` triggers one auto-retry with the guardrail prompt; second failure escalates
- The `request-review.ts`, `review.ts`, and `complete.ts` scripts can each be invoked twice in a row without error (printing "already done" the second time)

## Out of scope (explicitly NOT in this spec)

The following research-derived patterns are deliberately deferred. Each has its own decision doc in `docs/decisions/` recording the deferral rationale:

- **Parallel multi-spec execution and worktree isolation** — designed-for, not committed-to (per `single_entry_pipeline.md`)
- **Memory write-side and consolidation** (session_memory + AutoDream analogs) — per `memory_scope_split.md`
- **Graded verification** ("Green Contract" — TargetedTests/Package/Workspace/MergeReady tiers) — per `verification_grading_deferred.md`
- **Unified preflight diagnostic** (`factory doctor`) — per `doctor_diagnostic_deferred.md`
- **Manager-Executor with budget splitting** — depends on cost visibility (Phase 5.7); revisit afterward; flagged in `cost_visibility.md`
- **Configurable policy DSL** for recovery (vs the recipes Phase 6 ships) — per `recovery_recipes_not_dsl.md`

Other items NOT addressed by this spec:

- Replacing `validate.ts`'s hand-rolled validators with `ajv`
- PRD/roadmap views in `status.ts`
- Hook system implementation (the architecture allows for it; building it is separate)
- MCP integration changes

These are real improvements but each is its own spec.

## Implementation phases

The phases below are listed in the order they should land. Each phase is a candidate dev/qa packet pair when the planner decomposes this spec.

### Phase 1 — Extract testable cores from `run.ts` (no behavior change)

**Goal:** Pull pure logic out of `run.ts` into `tools/pipeline/` modules with unit tests. No behavior change visible at the CLI.

**Specifically:**

- Move `topoSort` to `tools/pipeline/topo.ts` with tests
- Move all prompt builders (`buildDevPrompt`, `buildReviewPrompt`, `buildReworkPrompt`, `buildQaPrompt`, planner prompt) to `tools/pipeline/prompts.ts` with snapshot tests
- Move `deriveDevResumePoint` and the dev state machine transitions to `tools/pipeline/develop_phase.ts` as pure functions: `(packet, hasCompletion) -> ResumePoint` and `(currentPoint, runOutcome) -> NextPoint | Done | Failed`
- Move provider invocation argument building (`buildProviderArgs`) to `tools/pipeline/agent_invoke.ts`
- `run.ts` keeps orchestration but delegates the pure logic to the new modules

**Acceptance:**

- All existing tests still pass
- New modules have unit test coverage of the extracted logic (target: +30 tests)
- `run.ts` line count reduced from 798 to under 400
- Manual smoke test: a known-good intent runs through to completion identically to before

**Risk:** Behavior change leaks during extraction. Mitigation: do this phase first when the surface is small, with snapshot tests on prompt output, and run an end-to-end pipeline against a known-good fixture before merging.

### Phase 2 — Make lifecycle scripts idempotent

**Goal:** `request-review`, `review`, and `complete` follow the `start.ts` pattern: detect "already done" state and exit 0 silently with an informative message.

**Specifically:**

- `request-review.ts`: if status is already `review_requested`, print "review already requested for this branch/iteration" and exit 0
- `review.ts`: if status matches the requested decision (`review_approved` for `--approve`, `changes_requested` for `--request-changes`), print "decision already recorded" and exit 0; mismatched re-decision (e.g., approve after request-changes) is still an error
- `complete.ts`: if completion record exists, print "already complete" and exit 0 *without re-running build/lint/test*; the FI-1 invariant (one completion per packet) is preserved by refusing to *create* a duplicate, not by erroring on re-invocation

**Acceptance:**

- Each lifecycle script can be invoked twice in a row from a fresh state without error
- Tests cover each "already done" detection path
- The FI-1 invariant tests in `validate.ts` still pass (only one completion file per packet)

**Risk:** Mismatched re-decisions in `review.ts` could mask reviewer intent (e.g., reviewer changes their mind from `--approve` to `--request-changes`). Mitigation: the spec'd behavior is to error on mismatched re-decision and require the human/agent to reset state explicitly.

### Phase 3 — Library-ize lifecycle scripts

**Goal:** Each lifecycle script exposes a typed function that `run.ts` (and the new orchestrator) calls directly. The CLI becomes a thin wrapper. Agents continue to call the CLI; only the orchestrator switches to library calls.

**Specifically:**

- `tools/lifecycle/start.ts` exports `startPacket(opts: StartPacketOptions): StartPacketResult`
- `tools/lifecycle/request_review.ts` exports `requestReview(opts: RequestReviewOptions): RequestReviewResult`
- `tools/lifecycle/review.ts` exports `recordReview(opts: RecordReviewOptions): RecordReviewResult`
- `tools/lifecycle/complete.ts` already exports `completePacket`; ensure it stays in shape
- `run.ts` (and the new orchestrator from Phase 5) calls these functions directly; no `execSync` to lifecycle scripts from internal code
- The CLI entrypoints become thin wrappers that parse args, call the function, render output, and exit with the right code

**Acceptance:**

- No `execSync('npx tsx tools/start.ts ...')` or equivalent for lifecycle scripts inside `run.ts` or `pipeline/*` modules
- Agents continue calling lifecycle CLIs (no agent-facing change)
- Lifecycle library functions have unit tests covering preconditions, the success path, and the "already done" path

### Phase 4 — Spec artifact and spec→intent translation

**Goal:** Implement the [`spec_artifact_model`](../docs/decisions/spec_artifact_model.md) decision.

**Specifically:**

- Add a `specs/<id>.md` parser in `tools/specs.ts` (or `tools/pipeline/specs.ts`) — reads frontmatter (`id`, `title`, `depends_on`) and the markdown body
- Add a JSON schema for spec frontmatter; validate as part of `validate.ts`
- Add `depends_on: string[]` to the intent JSON schema (additive, default `[]`)
- Implement `specToIntent(spec): Intent` that produces an intent artifact with the spec's metadata copied over
- Update `run.ts` argument handling: `<spec-id>` is now the canonical input. If `intents/<id>.json` exists, validate its `id` matches the spec; if not, generate from the spec.
- Existing `intents/<intent-id>.json` files without specs continue to work (compatibility mode — flagged for deprecation in a future spec)

**Acceptance:**

- A new `specs/example.md` with valid frontmatter generates `intents/example.json` on first `run.ts example`
- Re-running `run.ts example` does not regenerate the intent (idempotent)
- Frontmatter validation rejects bad specs with clear error messages
- `validate.ts` validates spec frontmatter and the new intent `depends_on` field

### Phase 4.5 — Phase-loop extraction (pure refactor)

**Goal:** Move `planPhase`, `devPhase`, `qaPhase` from `tools/run.ts` into dedicated modules. Pure refactor; no behavior change. This addresses the run.ts size discipline concern surfaced after Phase 4 (run.ts at 773 lines, trending up).

**Why this is its own phase:** the 4-layer architecture in `docs/decisions/single_entry_pipeline.md` calls for a "phases" layer separate from the entry, driver, and lifecycle layers. Today the imperative phase loops still live in run.ts. Phase 1 extracted only the *pure decision logic* from these loops; the imperative bodies stayed put. This phase moves them.

**Specifically:**

- Move `planPhase` to `tools/pipeline/plan_phase.ts`. Exposes `runPlanPhase(opts: PlanPhaseOptions): PlanPhaseResult`.
- Move `devPhase` to `tools/pipeline/develop_phase.ts`. The file already exists from Phase 1 (containing pure decision functions like `deriveDevResumePoint`); this phase adds the imperative loop alongside the existing pure functions.
- Move `qaPhase` to `tools/pipeline/verify_phase.ts`. Exposes `runVerifyPhase(opts: VerifyPhaseOptions): VerifyPhaseResult`.
- Each phase's I/O boundary is the imported function. Internally, phases continue to use the lifecycle library functions (Phase 3) and pure helpers (Phase 1).
- `run.ts` becomes a thin coordinator: parse args, resolve spec/intent, call planPhase, then devPhase, then qaPhase, render summary.

**Acceptance:**

- All existing tests pass (≥253 baseline from Phase 4).
- New phase modules have unit tests where pure logic exists; imperative wrappers may rely on existing integration tests.
- `tools/run.ts` line count under **350 lines** (down from 773 at end of Phase 4).
- No behavior change — same agent invocations, same lifecycle calls, same output for any input.
- Phase boundary is testable: each phase can be invoked independently in tests with fixture inputs.

**Risk:** Behavior leaks during refactor. Mitigation: same playbook as Phase 1 — run a known-good intent through end-to-end before and after, snapshot the output, compare.

### Phase 4.6 — Extract integrity layer (pure refactor) ✓ SHIPPED

**Originally proposed scope (rejected):** migrate hand-rolled validators to ajv. After 3 rounds of codex review on the original attempt, the migration premise was determined to be wrong: hand-rolled validators were not schema-driven validation waiting for ajv; they were custom semantic checks with schemas nearby. The migration would have added complexity (785 → 1,396 lines + new dependency + custom drop-rules mini-DSL) rather than removing it. See [`research/ajv_migration_attempt.md`](../docs/research/ajv_migration_attempt.md) for the full lesson.

**Actual scope (shipped):** extract the cross-cutting integrity layer to a dedicated module; add compatibility tests pinning current hand-rolled validator behavior. No ajv. No new dependencies. No schema changes.

**What shipped:**

- New module `tools/pipeline/integrity.ts` (467 lines) owns:
  - FI-1 (unique completion per packet)
  - FI-7 (distinct dev/QA identities)
  - FI-8 (every dev packet has a QA counterpart)
  - FI-9 (no cyclic packet dependencies)
  - Orphaned completions detection
  - Feature ↔ packet referential integrity
  - Intent → feature linkage status rules
  - Spec dependency cycles + missing-target deps
  - Typed snapshot types (PacketSnapshot, CompletionSnapshot, FeatureSnapshot, IntentSnapshot, ArtifactIndex, DiscoveredSpec, ValidationResult)
- `tools/validate.ts` shrunk from 785 to 423 lines. Per-artifact validators (validatePacketSchema, validateCompletionSchema, validateFeatureSchema, validateIntentSchema, readSpecFiles, validateSpecFile) remain hand-rolled. CLI rendering and error reporting unchanged.
- 29 new compatibility tests in `tools/test/validate.test.ts` pin the EXISTING hand-rolled validator behavior. These tests are the safety net for any future change to validate.ts (including a possible future re-attempt at schema-driven validation with a different approach).

**Acceptance (what was verified):**

- 311 tests pass (282 baseline + 29 new)
- `tools/validate.ts` at 423 lines (down from 785)
- `npx tsx tools/validate.ts` reports PASS on this repo
- Per-artifact validators preserved with no semantic changes
- Cross-cutting integrity validations moved cleanly to integrity.ts
- CLI output format preserved
- Zero new dependencies (no ajv)
- Zero schema changes

**What this does NOT include:**

- Schema-driven validation via ajv or any other engine. Deferred indefinitely; the existing hand-rolled validators stay authoritative. If a future need surfaces, the compatibility tests added here will pin the behavior and a different migration approach can be considered.

### Phase 5 — Multi-spec dependency-aware orchestrator

**Goal:** `run.ts <spec-1> <spec-2> <spec-3>` runs each spec's pipeline in topological order based on `depends_on`.

**Specifically:**

- New `tools/pipeline/orchestrator.ts` module
- Parse all spec arguments; load each spec's frontmatter; topo-sort by `depends_on`
- Reject cyclic dependencies upfront with a clear error
- Process specs sequentially in topo order
- If a spec fails (after recovery), mark all dependent specs as blocked and skip them
- Independent specs continue regardless of other specs' failures
- Final summary report covers all specs: completed, failed, blocked

**Acceptance:**

- `run.ts a b` where `b.depends_on: [a]` runs a first, then b
- `run.ts a b` where `a` fails: `b` reported blocked, not attempted
- `run.ts a b c` where `a` and `b` are independent and `b` fails: `a` and `c` still complete
- Cyclic dependency (`a depends on b, b depends on a`) errors before any agent invocation
- Tests cover the topo sort and the blocked-on-failure logic

### Phase 5.5 — Event observability

**Goal:** Implement [`event_observability`](../docs/decisions/event_observability.md). Add typed events emitted during pipeline execution with provenance labels. Foundational for Phase 6 (recovery operates on events) and the future memory write-side.

**Specifically:**

- New `tools/pipeline/events.ts` (pure logic): event-type definitions (TypeScript union of `event_type` string literals), `Event` interface (`{ event_type, timestamp, provenance, payload }`), pure helpers for constructing events from typed inputs, event-payload schemas per type.
- New `tools/events.ts` (I/O wrapper): `appendEvent(event, runId, artifactRoot)` that writes to `factory/events/<runId>.jsonl`. Uses append-only writes; no mid-run rewrites.
- Provenance values: `live_run | test | healthcheck | replay | dry_run`. Defaults are derived from invocation context (e.g., `--dry-run` → `dry_run`, vitest test environment → `test`).
- Initial event taxonomy (closed enum): `pipeline.started`, `pipeline.spec_resolved`, `pipeline.finished`, `pipeline.failed`, `spec.started`, `spec.blocked`, `spec.completed`, `phase.started`, `phase.completed`, `packet.started`, `packet.review_requested`, `packet.review_approved`, `packet.changes_requested`, `packet.completed`, `packet.failed`, `verification.passed`, `verification.failed`. Recovery and cost events arrive in Phase 6 / Phase 5.7 respectively.
- Each phase from Phase 4.5 emits events at its key transitions. Implementation is consistent: phases call `appendEvent(...)` after each meaningful transition; events are not blocking (best-effort write).
- Tests cover: event schema, provenance filtering, write-to-disk under tmpdir fixtures, recovery-from-truncated-jsonl reads (defensive).

**Acceptance:**

- All existing tests pass.
- A live run produces a JSONL file under `factory/events/<runId>.jsonl` with at least the lifecycle events.
- Vitest test runs use `provenance: "test"` so they don't pollute live event streams (verifiable by inspecting test fixtures).
- Schema added at `schemas/event.schema.json` validates the event format.
- run.ts emits `pipeline.started` and `pipeline.finished` minimum.
- The implementation is small enough that Phase 6 can extend it cleanly (recovery scenarios become events without restructuring).

### Phase 5.7 — Cost visibility

**Goal:** Implement [`cost_visibility`](../docs/decisions/cost_visibility.md). Per-invocation cost tracking with caps. Lands before Phase 6 because recovery retry budgets need cost visibility to operate safely.

**Specifically:**

- New `tools/pipeline/cost.ts` (pure logic): `computeCost(provider, model, tokens_in, tokens_out, rateCard): CostRecord` returning `{ tokens_in, tokens_out, dollars: number | null, provider, model }`. Pure function over rate cards (loaded from a config table) and reported tokens.
- New `tools/cost.ts` (I/O wrapper): `recordCost(record, runId, packetId, artifactRoot)`, `aggregateCost(runId, artifactRoot)`. Writes to `factory/cost/<runId>.jsonl`.
- `tools/pipeline/agent_invoke.ts` updated to capture token counts from each agent's response (provider-specific extraction logic — codex/claude/copilot each report differently or not at all). Where a provider does not report tokens, record `tokens_in: null, tokens_out: null` and `dollars: null`.
- Caps configurable in `factory.config.json` under `pipeline.cost_caps`: `{ per_run, per_packet, per_day }` (each optional, in dollars). Defaults: disabled (no caps).
- Cap-crossing emits a `cost.cap_crossed` event (per Phase 5.5's event system) and triggers escalation: per-run cap aborts the entire run; per-packet cap fails just that packet (continuing to the next independent packet); per-day cap aborts the run AND records the cap-block date so subsequent runs that day are blocked.
- run.ts reports aggregate cost in the final summary output (e.g., "completed; total cost: $0.42").
- Tests cover: cost computation per provider, cap detection at each scope, escalation behavior, no-token-data handling, rate card lookup.

**Acceptance:**

- All existing tests pass.
- Cost records produced by any live run; null fields when provider doesn't report.
- Per-run cap of $1 with a fixture that consumes >$1 triggers an abort with the structured event.
- Per-packet cap of $0.50 with a fixture aborts only that packet.
- Provider-agnostic: codex, claude, copilot all produce normalized records.
- Schema added at `schemas/cost_record.schema.json`.

### Phase 6 — Recovery layer

**Goal:** Implement the eight failure scenarios with their recipes. Builds on Phase 5.5 (events) and Phase 5.7 (cost caps) — recovery operates on events as its substrate, and retry budgets respect cost caps to prevent runaway loops.

Per [`recovery_recipes_not_dsl`](../docs/decisions/recovery_recipes_not_dsl.md), this uses scenario-keyed recipes (TypeScript functions), not a configurable policy DSL.

**Specifically:**

- New `tools/pipeline/recovery.ts` module
- Define `FailureScenario` enum: `ProviderTransient | ProviderUnavailable | BuildFailed | LintFailed | TestFailed | StaleBranch | AgentNonResponsive | CompletionGateBlocked`
- Define `RecoveryAttempt` (action to take) and `EscalateRequest` (failure record) types
- Implement classifier: `(error, exitCode, output, context) -> FailureScenario`
- Implement recipes for each scenario per the decision doc
- Wire recovery insertion points: every agent invocation in phases, every verification step in `complete.ts`
- Recovery emits events: `recovery.attempt_started`, `recovery.succeeded`, `recovery.exhausted`, `recovery.escalated` (per Phase 5.5's event taxonomy)
- Recovery checks cost caps before each retry attempt (per Phase 5.7); if a retry would cross a cap, recovery escalates immediately with the cap-block reason
- Implement escalation: write `factory/escalations/<spec-id>-<timestamp>.json` with structured failure context
- Recovery budget: 1 attempt per scenario per packet per phase; 3 total recovery attempts per packet across all scenarios

**Acceptance:**

- A simulated 5xx response triggers `ProviderTransient` → retry; second 5xx escalates to `ProviderUnavailable`
- A build failure triggers one auto-retry with the guardrail prompt; second failure escalates
- A test failure escalates immediately (no auto-retry)
- A lint failure escalates immediately
- A stale branch is detected, rebased, and the original action retried; conflict aborts and escalates
- Escalations write valid structured records; the orchestrator continues with the next independent spec
- Tests cover the classifier and each recipe

### Phase 7 — Two-layer provider failover

**Goal:** Implement cross-CLI and within-CLI provider failover.

**Specifically:**

- Update `factory-config.schema.json`: `persona_providers.<persona>` accepts `string | string[]`; provider config gains optional `model_failover: string[]`
- Update `config.ts` loader to normalize single-string `persona_providers` to one-element array; default `model_failover` to undefined
- Update `tools/pipeline/agent_invoke.ts` to walk the failover list
- Wire the cascade: `ProviderUnavailable` recipe consults `model_failover` first, then `persona_providers`
- Update template `factory.config.json` and the live `factory.config.json` to use the new shape

**Acceptance:**

- `persona_providers.developer = "codex"` (string) still works (backward compatible)
- `persona_providers.developer = ["copilot", "claude", "codex"]` works; primary failure falls through
- A copilot config with `model_failover: ["claude-opus-4-6", "GPT-5.4"]` falls through to GPT-5.4 when claude-opus-4-6 fails on copilot
- Direct providers (codex, claude) fall through to the next CLI without trying alternate models
- Schema validates both the old and new shapes
- Tests cover the cascade and the backward-compat path

### Phase 8 — Documentation pass

**Goal:** Reflect the single-entry-point reality across all user-facing docs.

**Specifically:**

- `README.md`: lifecycle scripts moved to "agent protocol" section, no longer in "commands you run"
- `AGENTS.md`: same — lifecycle commands described as how agents signal back to the factory, not as commands operators run
- `CLAUDE.md`: Quick Reference shows `run.ts <spec-id>` as the primary entry; lifecycle scripts removed or footnoted
- `docs/integration.md`: spec authoring guide added; lifecycle CLI section moved to "agent protocol" appendix
- New: brief spec-authoring guide (`docs/decisions/` already has the model; the guide is operator-facing)

**Acceptance:**

- A new operator reading the docs runs `run.ts <spec-id>` and never sees a recommendation to invoke a lifecycle script directly
- The docs explicitly note that lifecycle scripts exist for agents, not for humans
- Spec authoring guide covers: file location, frontmatter shape, dependency declaration, body conventions

## Cross-cutting risks and mitigations

| Risk | Phase(s) | Mitigation |
|------|----------|------------|
| Behavior change leaks during refactor | 1, 2, 3, 4.5, 4.6 | End-to-end smoke test against a known-good fixture before/after each phase; snapshot tests on prompt output; for 4.6 specifically, integration tests with known-bad fixtures verify the error-classification mapping |
| ajv error format diverges from hand-rolled format | 4.6 | Tests assert on error_type and structural fields, not free-form message text. Where text assertions exist, update fixtures only after manually verifying the new text is at least as informative |
| New failure modes introduced by recovery logic | 6 | Each recipe has a unit test for at least one happy path and one failure path; recovery budget caps total attempts; cost caps further bound retry loops |
| Schema migration breaks live config | 4, 5.5, 5.7, 7 | Schema changes are additive only; backward compat tested explicitly |
| Multi-spec sequencing has edge cases | 5 | Tests cover: empty `depends_on`, single dep, transitive deps, cycle, mixed independent + dependent |
| Provider failover misclassification | 6, 7 | Classifier tested with realistic error fixtures from each provider; failover decisions logged for observability |
| Event-emission overhead in hot loops | 5.5 | Events are best-effort writes to JSONL, not blocking; performance verified under tmpdir fixture |
| Cost-tracking misses tokens for some providers | 5.7 | Per-provider extraction logic has fallback to `null` cost; tested across codex/claude/copilot fixtures |
| Documentation drift | 8 | Doc pass lands in the same packet as the architectural change it describes; nothing ships with the docs out of sync |

## Migration safety

Phases 1–3, 4.5, and 4.6 are pure refactors with no behavior change. Each lands behind a no-op invariant: same inputs, same outputs, more test coverage. Phase 4.6 adds one direct devDependency (`ajv`); the dependency change is justified in its phase block.

Phases 4, 5, 5.5, 5.7, 6, 7 are additive: new artifact types, new orchestrator, event stream, cost stream, recovery layer, failover. The existing `intents/<id>.json` flow remains supported during this work; we don't break operators mid-migration.

Phase 8 is documentation only.

The whole spec is shippable phase-by-phase. We don't have to land all twelve before any of it is useful.

## References

- [`docs/decisions/single_entry_pipeline.md`](../docs/decisions/single_entry_pipeline.md) — architectural decision
- [`docs/decisions/spec_artifact_model.md`](../docs/decisions/spec_artifact_model.md) — spec layer decision
- [`docs/decisions/memory_scope_split.md`](../docs/decisions/memory_scope_split.md) — memory scope constraint
- [`docs/decisions/cost_visibility.md`](../docs/decisions/cost_visibility.md) — cost visibility decision (Phase 5.7)
- [`docs/decisions/event_observability.md`](../docs/decisions/event_observability.md) — event observability decision (Phase 5.5)
- [`docs/decisions/recovery_recipes_not_dsl.md`](../docs/decisions/recovery_recipes_not_dsl.md) — recipes vs DSL design choice (Phase 6)
- [`docs/decisions/verification_grading_deferred.md`](../docs/decisions/verification_grading_deferred.md) — Green Contract deferral
- [`docs/decisions/doctor_diagnostic_deferred.md`](../docs/decisions/doctor_diagnostic_deferred.md) — doctor command deferral
- [`docs/research/factory_script_audit.md`](../docs/research/factory_script_audit.md) — diagnosis that produced the architecture
- [`docs/research/claurst_audit.md`](../docs/research/claurst_audit.md) — manager-executor / single-loop / spec-as-input patterns
- [`docs/research/claw_code_audit.md`](../docs/research/claw_code_audit.md) — recovery recipes / lane events / failure classification
