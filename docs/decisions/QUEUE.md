# Factory — Work Queue

Authoritative state of in-flight, planned, and accepted work items for factory development. Future sessions enter via this file alongside [`workflow.md`](workflow.md) (the factory-development procedure) and [`MEMORY.md`](MEMORY.md) (decision-doc + research index).

---

## In flight

### 1. Thin host-project memory follow-up — promotion workflow and retrieval tuning

- **Status:** in progress.
- **Why:** The thin layer is implemented. The next work is to tighten how suggestion artifacts are promoted into durable memory and how category selection/ranking works for prompt injection.
- **References:**
  - `docs/decisions/host_project_memory_thin_layer.md`
  - `docs/research/host_project_memory_reconsideration.md`
  - `docs/decisions/memory_scope_split.md`

---

## Planned (next up)

### 1. `factory doctor` sister spec (post-Phase-8 trigger)

- **Status:** scoped pending accumulated host-project experience.
- **Why:** Unified preflight diagnostic command per `docs/decisions/doctor_diagnostic_deferred.md`. Replaces today's fragmented health-checking across `tools/status.ts`, `tools/validate.ts`, manual provider checks, and the pre-commit completion-gate hook.
- **References:**
  - `docs/decisions/doctor_diagnostic_deferred.md` — deferral rationale (locked 2026-05-01)
  - `docs/research/claw_code_audit.md` §10 — `claw doctor` precedent
- **Waiting on:** accumulated host-project experience to inform the full check list (multi-spec sequencing state, recovery state, cost-cap status, event-stream health, worktree state). The deferral is deliberate; Phase 8 just landed (commit `4472b7f`).

### 2. Verification grading sister spec (post-Phase-8 trigger)

- **Status:** scoped pending accumulated host-project experience.
- **Why:** Green Contract tiered verification per `docs/decisions/verification_grading_deferred.md` (`TargetedTests` / `Package` / `Workspace` / `MergeReady`). Factory's current binary build/lint/test pass-or-fail is over-rigorous (every packet runs every check); the tier vocabulary depends on host-project tooling shape.
- **References:**
  - `docs/decisions/verification_grading_deferred.md` — deferral rationale (locked 2026-05-01)
  - `docs/research/claw_code_audit.md` §7 — claw-code's Green Contract model
- **Waiting on:** accumulated host-project experience to inform whether binary pass/fail is genuinely insufficient. Additive change (optional `required_verification_level` field on packet schema); not blocked architecturally.

---

## Accepted (recent)

Most recent first. Each line: title — merge commit — outcome.

- **Thin host-project memory layer** — pending commit — durable memory now exists under `factory/memory/` with category directories plus `suggestions/`, transient machine cache exists under `factory/cache/`, planner/developer/reviewer/QA prompts load memory selectively, and the pipeline emits suggestion reports instead of auto-promoting durable memory. Follow-up work remains around promotion workflow and retrieval tuning.
- **Host-project memory documentation note** — `6bcf976` — `docs/research/host_project_memory_documentation_note.md` added as a documentation-only synthesis of the host-project memory posture and later updated to reflect the thin-layer implementation rather than the historical graph-RAG-first direction.
- **Host-project memory reconsideration note** — `6bcf976` — `docs/research/host_project_memory_reconsideration.md` added as an explicit challenge to the graph-RAG-first direction. It reopened the host-project memory question around both public agent-memory patterns and actual downstream failure modes, leading to the current thin-layer implementation path.
- **Factory development workflow doc** — `ab4770d` — `docs/decisions/workflow.md` captures HOW factory development is governed: four roles (Orchestrator + Developer Agent + Reviewer + QA), session-grounded lifecycle, bounded-iteration + role-flip embedded by reference to `recurring_workflow_patterns.md` Pattern 1, W-1 through W-11 defaults table. Round 1 codex REQUEST-CHANGES (docs-only QA-skip carve-out, CLAUDE.md § references unverifiable in-repo, codex described as the notes mutator instead of verdict emitter); round 2 addressed all three; round 2 codex APPROVE; QA APPROVE on all 23 criteria.
- **Recurring workflow patterns + work queue** — `56efaba` — `docs/research/recurring_workflow_patterns.md` (8 patterns, `type: lesson`) and `docs/decisions/QUEUE.md` introduced; MEMORY.md indexes both. Pattern 1 round-3 decision rule (revert vs role-flip) and Pattern 8 FI-7 disambiguation locked in. Follow-up tightening at `d167851` aligned the role-flip corrective-move bullet with the literal-swap mechanism above it (trivial docs alignment, direct-on-main per `workflow.md`).
- **Tier 1 memory alignment** — `c037d8c` — frontmatter convention (sentence-case `name`, `description: >-` folded scalar, `type: <value>`), `MEMORY.md` rewritten with rich bullets + pin-closure preamble + bidirectional links, all decision + research notes brought onto the convention.
- **Host-project memory graph-RAG decision** — `ac8bdea` — architectural commitment that when the host-project memory write-side lands, it will be a graph-based knowledge layer (typed nodes + typed edges + composite weights + semantic+graph retrieval + continuous consolidation), NOT a flat catalog. A-decisions deferred to 4-6 future specs across 3 staging steps.
- **DEP0190 spec completion + Windows decision + R1 lesson** — `31a158f` — marked the DEP0190 mini-spec complete, recorded the Windows-deferral decision, captured the round-1 lesson surfaced by codex review (test-name vs assertion mismatch under `tools/test/config.test.ts:354`).
- **DEP0190 implementation** — `89cb66d` — dropped `shell: true` from spawn; split provider command into `command` + `prefix_args`; threaded through schema + loader + live + template configs across phases 1-3 (`9e4086c`, `1bf4ca1`, `fedb861`); round-2 fix preserved POSIX paths with spaces (`6b68f29`).
- **DEP0190 mini-spec** — `1b6ba5a` — implementation roadmap authored (cross-platform safety after round-1 review at `89e0bad`).
- **Reviewer CLI exception decision** — `6c6c27f` — `review.ts --approve`/`--request-changes` formalized as the deliberate exception to "pipeline manages lifecycle." Coupled to `ReviewDecisionMissing` recovery scenario; without that path the exception would be a facade.
- **Backlog cleanup pass** — `82909a9` — five follow-up items from the convergence pass: extract `resolveHeartbeatInterval` (`b5f4502`), scope finalize-transition log to actual agent invocations (`61956ae`), and the remaining three items merged together.
- **Convergence pass** — `a54322e` — async `invokeAgent` + heartbeats; approval semantics split (spec-driven runs bypass the governance gate, intent-driven runs require `status: approved`/`planned`/`delivered`); `ReviewDecisionMissing` recovery scenario; doc-driven inconsistency fixes surfaced by the reviewer-CLI-exception decision.
- **Phase 8 docs** — `4472b7f` — operator-vs-agent reframing across CLAUDE.md, AGENTS.md, README, and the integration guide; spec-id and lifecycle audience clarified.
- **Phase 7 provider failover** — `83818f5` — two-layer provider failover (cross-CLI ordered `persona_providers` list + within-CLI `model_failover` for abstraction providers like copilot); six implementation steps + three round-2 fixes + one round-3 fix (`6dca466`).
- **Phase 6 (revised) recovery** — `2f86856` — recovery layer with typed discriminator return from `runWithRecovery`, per-packet state-machine dispatch on escalation, integration tests pinning post-escalation invariants. Shipped after the Phase 6 first-attempt revert (lesson at `docs/research/phase_6_recovery_attempt.md`).
- **Phase 5.7 cost visibility** — `192b172` — per-invocation tokens + dollars, configurable caps at run/packet/per-day scope.
- **Post-5.7 orchestrator decomposition** — `6a30b26` — orchestrator decomposition checkpoint.
- **Phase 5.5 event observability** — `86e647c` — typed events with provenance labels (live_run / test / healthcheck / replay / dry_run); closed TypeScript union; append-only to host's artifact tree.
- **Phase 5 multi-spec orchestrator** — `edcf0da` — multi-spec dependency-aware sequencing.
- **Phases 1-4.6 (group summary)** — phases 1-3 (`006bfad`, `bd8e8dc`, `7a7032b`) extracted pipeline modules + made lifecycle scripts idempotent + library-ized them. Phase 4 (`b25aee7`) introduced specs as first-class artifacts with 1:1 spec→intent translation. Phase 4.5 (`9aafb80`) extracted the phase loop as a pure refactor. Phase 4.6 (revised) (`192e971`) extracted the integrity layer to `tools/pipeline/integrity.ts` (785 → 423 lines for `validate.ts`); the ajv migration that motivated 4.6 was reverted (lesson at `docs/research/ajv_migration_attempt.md`).
