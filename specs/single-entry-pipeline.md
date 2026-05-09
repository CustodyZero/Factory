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

### Phase 5 — Multi-spec dependency-aware orchestrator ✅ COMPLETE

**Status:** Merged in commit `edcf0da` (2026-05-02). 4-layer architecture (entry/driver/phases/lifecycle) is now complete.

**Goal:** `run.ts <spec-1> <spec-2> <spec-3>` runs each spec's pipeline in topological order based on `depends_on`.

**What shipped:**

- New `tools/pipeline/orchestrator.ts` (591 lines) — driver layer owning the multi-spec gate sequence (resolve → missing-deps → cycles → topo → execute) plus the per-spec runner that delegates to `runPlanPhase` / `runDevelopPhase` / `runVerifyPhase`.
- `tools/run.ts` reduced from 315 → 203 lines — pure entry/dispatcher (argv parse, render, exit).
- Public surface: `runOrchestrator`, `OrchestratorOptions`, `OrchestratorResult`, `SpecOutcome` (discriminated union: `completed` | `failed` | `blocked`). Internal helpers `_resolveAll`, `_detectCycles`, `_findMissingDeps` exported under `_` prefix for test pinning.
- Cycles and missing transitive deps fail upfront before any agent invocation. Per-spec failures mark dependents `blocked`; independents continue.
- Single-arg legacy contract preserved: same exit codes, `--dry-run` exits 0 on planning preview, `--json` emits the legacy flat shape (`{ intent_id, feature_id, packets_completed, packets_failed, success, message }`). Multi-arg uses the new `{ specs, success, message }` envelope.
- 47 new tests (311 → 358). Subprocess CLI tests pin the legacy `--dry-run` exit code and `--json` shape end-to-end.
- No new dependencies. No schema changes.

**What this does NOT include (still deferred):**

- Per-spec recovery / retry — Phase 6.
- Parallel execution — out of scope until Phase 6+ proves recovery is stable in sequential mode.
- Auto-resolution of transitive deps — user must pass all transitive deps explicitly; missing-dep detection catches this upfront.

**Iteration record:**

- 2 review rounds used (codex GPT-5.5): Round 1 REQUEST-CHANGES (legacy `--dry-run` exit-code regression and `--json` shape regression for single-arg); Round 2 APPROVE after a focused 12-line shim in `runSingleSpec` and a new `formatJsonOutput` helper in `run.ts`.
- Independent QA verification (separate Opus identity, FI-7) APPROVE on all 10 acceptance criteria.

### Phase 5.5 — Event observability ✅ COMPLETE

**Status:** Merged in commit `86e647c` (2026-05-02). Phase 6 recovery now has its event substrate.

**Goal:** Implement [`event_observability`](../docs/decisions/event_observability.md). Add typed events emitted during pipeline execution with provenance labels. Foundational for Phase 6 (recovery operates on events) and the future memory write-side.

**What shipped:**

- New `tools/pipeline/events.ts` (582 lines, pure): closed `EventType` string-literal union (17 variants); `EventPayload` discriminated union keyed on `event_type`; `Event<P>` envelope; `BaseInputs` accepts `{ run_id, dry_run?, timestamp? }` — provenance is computed inside `envelope` via `deriveProvenance({ dryRun })` and is **unspoofable** from caller input. `make*` constructors per event type; `newRunId(clock?)` with injectable clock for tests.
- New `tools/events.ts` (179 lines, I/O): `appendEvent` (append-only via `appendFileSync`, best-effort — errors swallowed); `readEvents` (per-line `JSON.parse` try/catch — tolerates truncated/corrupt last lines); `appendLifecycleEvent` (no-op when `FACTORY_RUN_ID` env var unset).
- New `schemas/event.schema.json` — documentation only, NOT wired into `validate.ts` (per the Phase 4.6 schemas-as-documentation decision).
- Orchestrator + 3 phase modules + 4 lifecycle scripts emit events at every meaningful transition. Provenance derived once at orchestrator entry (`VITEST > dryRun > live_run`). Tests get `provenance: 'test'` automatically — they cannot lie.
- `FACTORY_RUN_ID` is scoped to the orchestrator's lifetime via try/finally (captured before set; restored or deleted on exit, including early returns and exception paths). Lifecycle scripts read it from env; emit nothing when unset; never invent a run_id.
- Try/catch around the orchestrator body ensures `pipeline.failed` is always emitted on failure — including unexpected exceptions. `run.ts` top-level catch translates rethrows to a clean non-zero exit without leaking raw stacks.
- Dry-run planning emits `phase.completed(plan)` with `outcome: 'ok'` (successful preview) — distinct from a real planning failure (`outcome: 'failed'`).

**Iteration record:**

- 2 review rounds used (codex GPT-5.5):
  - Round 1 REQUEST-CHANGES: 4 findings — provenance was spoofable through `BaseInputs.provenance`; `FACTORY_RUN_ID` leaked after orchestrator return; dry-run plan emitted `outcome:'failed'` inside a successful spec; `pipeline.failed` was not guaranteed on unexpected exceptions.
  - Round 2 APPROVE after a single fixup commit (`6d347d9`) addressing all four findings + 7 contract tests.
- Independent QA verification (separate Opus identity, FI-7) APPROVE on all 14 acceptance criteria. Facade-risk check: the test-only `__R2_FORCE_PLAN_THROW` env var is read only inside `vi.mock` factory, never in production code — not a facade.
- One operational note: round-2 codex invocation hung once (6 hours, 0 CPU time, stalled network handshake). Killed and re-dispatched with a tighter timeout — completed cleanly.

**What this does NOT include (still deferred):**

- Recovery events (`recovery.attempt_started`, `recovery.succeeded`, `recovery.exhausted`, `recovery.escalated`) — Phase 6 will extend the closed enum.
- Cost events (`cost.cap_crossed`) — Phase 5.7 will extend the closed enum.
- Provider events (`provider.unavailable`, `provider.failover_attempted`) — Phase 7.
- Event compaction / rotation — out of scope per the decision doc.

### Phase 5.7 — Cost visibility ✅ COMPLETE

**Status:** Merged in commit `192b172` (2026-05-03). Phase 6 recovery now has its retry-budget substrate.

**Goal:** Implement [`cost_visibility`](../docs/decisions/cost_visibility.md). Per-invocation cost tracking with caps.

**What shipped:**

- New `tools/pipeline/cost.ts` (441 lines, pure): `RateCard` + `DEFAULT_RATE_CARD` per provider/model; `computeCost` (returns `dollars: null` when tokens are null OR rate-card entry missing — never silent zero); `extractTokens` (provider-specific parsers for codex / claude / copilot; null on unrecognized format; defensive — never throws on garbage input); `aggregateDollars`, `checkCap`, `mergeRateCard`, `localDateFromTimestamp`, `utcDateWindow`, `CostRecord` interface.
- New `tools/cost.ts` (322 lines, I/O): `recordCost` (append-only JSONL); `readCostRecords` (defensive — tolerates truncated final line); `aggregateRunCost`; `readDayCost` (filters records by `localDateFromTimestamp(record.timestamp) === date` after a bounded UTC-window candidate scan — fixes silent under-reporting in non-UTC timezones); `recordDayCapBlock`/`isDayCapBlocked` for the per-day cap state file.
- New `schemas/cost_record.schema.json` — documentation only, NOT wired into `validate.ts`.
- `InvokeResult` extended with `cost: { provider, model: string | null, tokens_in, tokens_out, dollars: number | null }`. Token extraction + dollar computation happen in the spawn path of `agent_invoke.ts`. All early-return paths use `nullCost` so the field is always populated.
- Cost recording wired at every agent invocation: planner (1×), developer/reviewer/rework (3×), QA verifier (1×). All call sites pass `run_id`, `packet_id` (or null for planner), `spec_id`.
- Cap enforcement: `cost.cap_crossed` events emitted BEFORE the abort propagates. Per-run cap aborts the entire run with `pipeline.failed`. Per-packet cap fails just that packet (orchestrator continues to the next independent packet, no `pipeline.failed`). Per-day cap aborts the run AND calls `recordDayCapBlock(today, ...)` so subsequent same-day runs are rejected at orchestrator entry (no `pipeline.started`).
- Per-day cap uses **local date** (operator's wall clock) consistently: `localDateString` and `localDateFromTimestamp` both use local-time accessors. Documented at every reference so future contributors don't assume UTC.
- `run.ts` summary line includes `total cost: $X.XX` and `(N unknown-cost invocations)` when any invocation reported null dollars. Honest unknowns surface to the operator.
- `factory.config.json` schema adds optional `pipeline.cost_caps: { per_run?, per_packet?, per_day? }` and optional `pipeline.rate_card` partial override.

**Iteration record:**

- 3 review rounds used (codex GPT-5.5):
  - Round 1 REQUEST-CHANGES: planner invocations not in cost stream (violates "every agent invocation"); `readDayCost` filtered by filename UTC prefix instead of record local date (silent under-reporting in non-UTC TZs).
  - Round 2 REQUEST-CHANGES: round-2 regression tests still TZ-fragile in extreme east timezones (UTC+14 hole — `T12:00:00.000Z` literals map to next local day in Pacific/Kiritimati).
  - Round 3 APPROVE after fixture-only commit replacing 25 UTC-anchored timestamp literals with local-time `Date(y, m, d, h)` constructors and deriving `localDay` from each fixture rather than hardcoding.
- Independent QA verification (separate Opus identity, FI-7) APPROVE on all 14 acceptance criteria. TZ-invariance independently verified under `TZ=Pacific/Kiritimati` (UTC+14): 485/485 pass.
- Operational note: codex CLI hung 4 of 6 times during the review chain (process startup network stall — 0% CPU, 0 bytes output). Kill+retry succeeded every time. External issue (codex CLI/network), not factory. Worth flagging at the post-5.7 orchestrator review checkpoint.

**What this does NOT include (still deferred):**

- Manager-Executor tiering (claurst's `ManagedAgentConfig` budget splitting) — natural follow-up after cost tracking is operational; deferred to a separate decision.
- Cost persistence and consolidation into long-term memory — follows from the future memory-write-side spec.

### Checkpoint after Phase 5.7 — Orchestrator review ✅ COMPLETE

**Status:** Merged in commit `6a30b26` (2026-05-03). The orchestrator was decomposed before Phase 6 begins.

**Why this happened:** by end of Phase 5.7 the orchestrator was 934 lines spanning 4 mixed concerns from Phase 5 (multi-spec sequencing) + Phase 5.5 (event emission) + Phase 5.7 (cost-cap enforcement) layered together. The user called for decomposition (not just minor refactor) before Phase 6 lands recovery on top.

**What shipped:**

`tools/pipeline/orchestrator.ts` (934 lines, single file) → `tools/pipeline/orchestrator/` directory containing 4 single-concern files:

| File | Lines | Concern |
|------|-------|---------|
| `index.ts` | 551 | Slim driver: try/catch/finally bracket, day-cap pre-flight, gate sequencing, per-spec loop, aggregation, exception handler. Public types re-exported. |
| `resolution.ts` | 169 (pure) | `_resolveAll`, `_detectCycles`, `_findMissingDeps` + types. Underscore-prefixed for test pinning, retained. |
| `spec_runner.ts` | 267 | `runSingleSpec` + `RunSingleSpecContext` + `RunSpecOutcome` + 4 fs helpers. **Phase 6's natural hook point for per-packet recovery.** |
| `cost_caps.ts` | 113 | `checkPerRunCap`, `checkPerDayCap`. Atomic encapsulation of event-emit + (for day-cap) `recordDayCapBlock`. Returns `{ crossed: boolean, running_total: number \| null }`; the driver guards with `crossed && running_total !== null` to defensively reject "no aggregation work" from "$0 crossed." |

Pure refactor. Behavior unchanged at every event/cap/gate site. Tests 485 (no count delta). `package.json` unchanged. All 7 importers updated to `./pipeline/orchestrator/index.js`. Regex assertion in `run.test.ts:290` updated to match.

**Iteration record:** 1 review round (codex APPROVE on round 1). Independent QA (separate Opus, FI-7) APPROVE on all 10 acceptance criteria + 17 specific checks including behavior-preservation diff.

**On `index.ts` at 551 lines:** codex's verdict — "the 551-line driver is still long, but the remaining substance is the orchestration transaction itself. Pulling out the per-spec loop or post-loop close would require a large context object carrying event state, maps, caps, totals, root paths, run id, and display behavior. That would mostly move complexity sideways and make the event ordering less obvious." Endorsed.

**Operational note across the Phase 5-series + this checkpoint:** codex CLI hung 5 of 8 review dispatches in this session (process startup network stall — 0% CPU, 0 bytes output, never times out client-side). Kill+retry succeeded every time. External issue (codex CLI/network reliability), not factory. Worth carrying into a future workflow-reliability discussion separate from the pipeline architecture itself.

### Phase 6 — Recovery layer ✅ COMPLETE (revised attempt)

**Status:** Merged in commit `2f86856` (2026-05-05). Phase 7 (provider failover) and Phase 8 (docs) remain.

**Iteration:** This phase took two attempts. The first attempt (branch `phase-6-recovery`, force-deleted) was reverted after 3 review rounds for the *logged-then-advances* bug class — recovery escalation was observable but not controlling. The lesson is captured in [`docs/research/phase_6_recovery_attempt.md`](../docs/research/phase_6_recovery_attempt.md).

The revised attempt's architectural breakthrough: typed `RecoveryResult<T>` discriminator that forces compile-time dispatch on escalation. Every wrap site MUST handle `kind === 'escalated'` to typecheck.

**What shipped:**

- New `tools/pipeline/recovery.ts` (630 lines, pure): closed `FailureScenario` enum (8 variants); classifier `classifyFailure(error, exitCode, output, context)` returning `FailureScenario | null`; `RECIPES: Record<FailureScenario, RecoveryRecipe>`; per-scenario retry budgets; `RecoveryResult<T>` discriminator type; `BUILD_GUARDRAIL_PROMPT` constant. Zero fs imports.
- New `tools/pipeline/recovery_loop.ts` (690 lines, orchestration): `runWithRecovery<T>(operation, context, options) → RecoveryResult<T>`. Per-packet budget tracking via `PacketRecoveryBudget`. Cap-vs-retry checks (`cost.cap_crossed` BEFORE `recovery.escalated`). `runGitRebase` execution with injectable `GitRunner` (default uses `spawnSync`).
- New `tools/recovery.ts` (118 lines, I/O): `writeEscalation(record, artifactRoot)` → `<artifactRoot>/escalations/<spec-id>-<timestamp>.json`. Best-effort, mirrors `appendEvent`.
- New `tools/lifecycle/git_check.ts` (211 lines): stale-branch detection patterns shared between `request_review.ts` and `complete.ts`. Cross-layer pattern drift test prevents regex divergence between the lifecycle detector and the pipeline classifier.
- 4 new event types extending the Phase 5.5 closed enum: `recovery.attempt_started`, `recovery.succeeded`, `recovery.exhausted`, `recovery.escalated`. The `attempt_started` event fires only on retry attempts (not on initial invocation) — streams without `recovery.*` events mean "everything went normally."
- **Atomic `completePacket`** in `tools/lifecycle/complete.ts`: completion records exist only when ALL of `{build_pass, lint_pass, test_pass, ci_pass}` pass. CI-failed invocations write no record and don't mutate `status`. The false-success short-circuit (`already_complete: true && ci_pass: false`) is structurally impossible.
- **`status: "failed"` is a first-class terminal state.** Added to `schemas/packet.schema.json` and `tools/validate.ts:validStatuses`. `tools/execute.ts` and `tools/status.ts` classify failed packets correctly (mutually exclusive with ready/in_progress/completed/blocked).
- **Optional `failure` object on packet artifacts** (`packet.schema.json`, `additionalProperties: false`): required `scenario` (string) + `reason` (string), optional `attempts` (non-negative integer) + `escalation_path` (string-or-null). Schema description names `CascadedFromDependency` and `Unclassified` as label strings, NOT 9th/10th `FailureScenario` enum variants.
- Recovery wiring at every fail-prone call site: `plan_phase.ts` (planner invocation), `develop_phase.ts` (implement / review / rework / finalize / requestReview), `verify_phase.ts` (QA agent / completePacket boundary). 8 wrap sites total, all dispatching on `kind === 'escalated'` with the `markPacketFailed + break/continue` pattern.
- **Develop finalize retry path invokes the dev agent with `attempt.guardrailPrompt` BEFORE re-running completePacket.** The previous attempt's regression on this is fixed.
- **QA cascade**: a QA packet whose dev `verifies` dependency failed is itself terminated with `failure.scenario: "CascadedFromDependency"`. The QA agent is NOT invoked (no wasted cost on a doomed verification).

**Recovery scenarios (per the decision doc):**

| Scenario | Retries | Recipe |
|----------|---------|--------|
| `ProviderTransient` | 2 | retry same provider/model |
| `AgentNonResponsive` | 2 | treated as ProviderTransient |
| `BuildFailed` | 1 | retry once with guardrail prompt forbidding test/build/lint config modification |
| `StaleBranch` | 1 | `git fetch origin → git rebase origin/main → retry op`; on conflict: `git rebase --abort` + escalate |
| `ProviderUnavailable` | 0 | escalate (Phase 7 will replace with cross-CLI / within-CLI cascade) |
| `LintFailed` | 0 | escalate (auto-recovery would invite agents to disable rules) |
| `TestFailed` | 0 | escalate (auto-recovery would invite agents to mutilate tests) |
| `CompletionGateBlocked` | 0 | escalate (intentional human gate per FI-7) |

**Iteration record (revised attempt):**

- 3 review rounds used (codex GPT-5.5):
  - Round 1 REQUEST-CHANGES: `status: "failed"` was schema-invalid and read-paths ignored it; `BuildFailed` recovery at completePacket boundary could falsely succeed; develop finalize ignored guardrail; tests pinned events without lifecycle side effects.
  - Round 2 REQUEST-CHANGES: `validate.ts:validStatuses` missed `"failed"`; recovery-written `failure` object rejected by schema's `additionalProperties: false`. (Codex explicit: "I do not recommend revert.")
  - Round 3 APPROVE.
- Independent QA verification (separate Opus, FI-7) APPROVE on all 17 acceptance criteria + 17 specific checks. TZ-invariance independently verified under `TZ=Pacific/Kiritimati` (630/630 pass).

**Tests:** 485 → 630 (+145 across 12 commits). All existing tests still pass.

**What this does NOT include (still deferred):**

- `ProviderUnavailable` cross-CLI / within-CLI cascade — Phase 7 replaces the recipe.
- Recovery state persistence across runs (today's budget is in-memory per-run; recovery state for resumed runs is out of scope).
- DSL-style policy composition (per [`recovery_recipes_not_dsl`](../docs/decisions/recovery_recipes_not_dsl.md), recipes stay as TypeScript functions).

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
