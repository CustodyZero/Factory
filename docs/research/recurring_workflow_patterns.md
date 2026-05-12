---
name: Recurring workflow patterns — recognition signals from session work that should govern future sessions
description: >-
  Meta-lesson recorded 2026-05-12 generalizing from the two concrete revert lessons ([ajv_migration_attempt](ajv_migration_attempt.md), [phase_6_recovery_attempt](phase_6_recovery_attempt.md)) and the session experience that produced Phases 1-8, the post-5.7 orchestrator decomposition, the convergence pass, the backlog cleanup, DEP0190, the host-project memory graph-RAG decision, and the Tier 1 memory alignment. Eight named recognition signals an orchestrator/reviewer should watch for during architectural work, each with concrete session examples and the corrective move when the signal fires. The patterns are not a workflow document — they're a checklist of failure shapes that recur across architectural work, captured so the next session can recognize the signal before it costs a round. Patterns covered: bounded-iteration model (3 rounds → revert), test-pins-the-bug (test name vs assertion mismatch), doc-creates-inconsistency (documenting a contract surfaces silent fallbacks), observable-vs-controlling (signals must be both visible and dispatched on), state-machine-integration-is-architecture (cross-cutting layer wiring is the load-bearing design concern), reverted-lesson preservation (force-delete branch + write research note), codex hang-and-restart (SIGKILL watchdog around `codex exec` because process hangs 5/8 dispatches at startup), and FI-7 distinct identity (orchestrator / developer / QA / reviewer separation). Authored as Tier 1 memory loaded into every factory-development session; referenced by `docs/decisions/QUEUE.md` and indexed in `docs/decisions/MEMORY.md`.
type: lesson
---

# Research Note — Recurring Workflow Patterns

**Date:** 2026-05-12
**Context:** Meta-lesson generalizing recognition signals across the session that produced Phases 1-8, the post-5.7 orchestrator decomposition, the convergence pass, the backlog cleanup pass, DEP0190, the host-project memory graph-RAG decision, and the Tier 1 memory alignment.
**Status:** Loaded into every factory-development session. Patterns are appended here as new signals surface.

---

## How to read this doc

Each section names a recurring failure shape and gives:

1. **Pattern statement** — the underlying mechanism.
2. **Session examples** — 2-3 concrete instances with citations.
3. **Recognition signal** — what a reviewer or orchestrator should watch for.
4. **Corrective move** — what to do when the signal fires.

The patterns are not exhaustive. New patterns get appended at the bottom as they surface.

---

## 1. Bounded-iteration model

**Pattern.** Three review rounds maximum per architectural change. After the third REQUEST-CHANGES, the verdict is RECOMMEND-REVERT: force-delete the branch and write a `type: lesson` research note recording what was tried, what went wrong per round, what's salvageable for the next attempt, and the reverted branch name.

**Examples.**

- Phase 4.6 ajv migration revert. Three rounds produced regressions, lax-mode filters, and a drop-rule mini-DSL that grew 785 lines into 1,396 across three files plus the new dependency. Round 3 verdict was RECOMMEND-REVERT; the integrity-layer extraction shipped instead (Phase 4.6 revised, commit `192e971`). Lesson at [ajv_migration_attempt.md](ajv_migration_attempt.md).
- Phase 6 recovery layer revert. Three rounds: R1 found facade labels (CLAUDE.md §3.5), R2 found production-unreachable + wrong-packet bugs, R3 found that `StaleBranch` escalation was observable but not controlling. RECOMMEND-REVERT; revised Phase 6 shipped at commit `2f86856`. Lesson at [phase_6_recovery_attempt.md](phase_6_recovery_attempt.md).

**Recognition signal.** At review round 3, the reviewer should ask: "does another round actually converge on something correct, or is the brief architecturally wrong?" If R1 and R2 surfaced increasingly deep correctness gaps (not just disciplinary fixes), the brief is the bug, not the implementation.

**Corrective move.** Revert and write the lesson before the branch is deleted. The next attempt's brief incorporates what the lesson taught — re-write the brief, don't re-dispatch the same scope.

---

## 2. Test-pins-the-bug

**Pattern.** When a test's name describes one behavior but its assertions pin a different behavior, the test is pinning the bug under a misleading name. The bug is no longer a bug — it's the contract, by virtue of being asserted. Future readers (and the next reviewer) trust the test name and miss the divergence.

**Examples.**

- DEP0190 round 1. `tools/test/config.test.ts:354` was named "preserves..." but asserted the broken whitespace split. Round 2 (commit `6b68f29`) rewrote the assertion to pin the actual contract (preserving POSIX paths with spaces); the underlying loader code then needed fixing.
- Convergence pass round 2. Review-fallback tests asserted that events fired but did not assert packet state was preserved. The events were the facade; the state machine was the real contract. The fix landed in the merge at `a54322e` (convergence pass) under the new `ReviewDecisionMissing` scenario.
- Phase 6 R2/R3. Escalation tests asserted `recovery.escalated` event fired but didn't pin "state machine stopped" or "no `packet.completed` event followed." Those tests certified label propagation; the production state machine ignored the escalation and advanced anyway. See [phase_6_recovery_attempt.md](phase_6_recovery_attempt.md).

**Recognition signal.** The test name does not match the assertion. Read the `it(...)` description, then read the `expect(...)` calls. If the description names a property and the assertions check a different (often weaker) property, the test is pinning the wrong thing.

**Corrective move.** Rewrite the assertion to pin the actual contract named by the description. If the test then fails, the underlying code is the bug — the test caught it. If the test was structurally unable to assert the named contract, the design needs to expose the controlling signal as observable state (typed return, packet status, missing-event invariant).

---

## 3. Doc-creates-inconsistency

**Pattern.** Documenting a mechanism as load-bearing surfaces silent-fallback bugs that were previously invisible. The doc didn't create the bug — it made the inconsistency visible. The right response is to fix the silent fallback to match the doc, not to soften the doc.

**Example.**

- Convergence pass. Documenting `review.ts` as the reviewer's verdict channel ([reviewer_cli_exception.md](../decisions/reviewer_cli_exception.md), commit `6c6c27f`) made the silent `recordReview(approve)` fallback architecturally inconsistent. The doc said the reviewer's verdict channel was `review.ts`; the code silently force-approved when `review.ts` wasn't called. The fix was the `ReviewDecisionMissing` recovery scenario at convergence-pass merge `a54322e` — the recipe escalates with budget 0 when the marker fires; no silent force-approve. The prompt-exception and the failure-path are coupled by design.

**Recognition signal.** Writing documentation that names a contract surfaces something the code was silently working around. The doc-author thinks "this is just describing what's already true" and finds it isn't.

**Corrective move.** The documentation is right. Fix the silent fallback to match. Typically this means adding a failure path (a recovery scenario, a typed error, an explicit `throw`) and pinning it with a test that asserts the failure path engages.

---

## 4. Observable-vs-controlling

**Pattern.** Signals from cross-cutting layers (recovery, tracing, auth, escalation) must be BOTH visible (events fire, audits accumulate) AND controlling (the calling loop dispatches on them). Documentation must verify both. An observable-but-not-controlling signal is the CLAUDE.md §3.3 violation: failure must be visible AND controlling. Truthful signals emitted into a void are the dishonest-system pattern.

**Examples.**

- Phase 6 R3. Recovery escalation was observable (`recovery.escalated` event fired, escalation file written) but not controlling — the per-packet state machine in `develop_phase.ts:582` logged the failed `runWithRecovery` result and unconditionally advanced to `review` at line 586. The packet could still complete through the bad fallthrough. RECOMMEND-REVERT verdict. See [phase_6_recovery_attempt.md](phase_6_recovery_attempt.md) and the revised Phase 6 design at commit `2f86856`, which returns a typed discriminator (`{ ok: true, value } | { escalated: true, reason }`) the caller must match on.
- Convergence pass `ReviewDecisionMissing`. Without the recipe escalating with budget 0, the marker (`REVIEW_DECISION_MISSING_MARKER`) would be observable in events but not controlling in the lifecycle — the packet would still complete. The convergence-pass merge `a54322e` made the marker controlling: the recipe + classifier branch fail the packet outright.

**Recognition signal.** State-machine loops that read or call a cross-cutting layer but don't branch on its return value. The pattern: `await runX(); advanceToNextState();` — the result of `runX` is discarded.

**Corrective move.** Type the return value as a discriminator the caller must match on (TypeScript's exhaustive `switch` is the right tool — uncovered variants fail the build). Add integration tests that drive the state machine end-to-end and assert post-signal invariants: packet marked failed, no further transitions, no `packet.completed` event followed.

---

## 5. State-machine-integration-is-architecture

**Pattern.** When adding an orthogonal cross-cutting layer (recovery, tracing, auth) to an existing state machine, the integration IS the architecture, not the wiring. Treating integration as wiring leads to (4) above: the new layer is correct in isolation, the test suite confirms it, and the production state machine ignores it.

**Example.**

- Phase 6's first attempt. The brief listed "wire recovery into phases" as the last commit in the suggested sequence and named it wiring. Phases each have packet-state-machine logic the brief did not analyze. The recovery layer was correct in isolation; the unit tests confirmed it; the state machines kept advancing past escalation. See [phase_6_recovery_attempt.md](phase_6_recovery_attempt.md). Phase 6 (revised) at commit `2f86856` made the integration first-class: typed discriminator return from `runWithRecovery`, per-packet loops dispatch on it, integration tests assert post-escalation invariants.

**Recognition signal.** A brief uses "wire" or "hook into" for the load-bearing integration point. The integration is being framed as mechanical follow-through to a separable design problem.

**Corrective move.** Name the integration as a first-class design concern, with its own design discussion, its own commit, and tests pinning the controlling-not-just-observable invariant. The cross-cutting layer and the state machine are co-designed; one returns what the other dispatches on.

---

## 6. Reverted-lesson preservation

**Pattern.** When a phase reverts (bounded-iteration round 3 RECOMMEND-REVERT), the branch is force-deleted from the repo BUT the lesson is captured as a `type: lesson` research note in `docs/research/`. The note records: what was tried, what went wrong (per round), comparison stats at rejection, the meta-pattern (this is bound to (1) above), what's salvageable for the next attempt, the reverted branch name. Without preservation, the lesson is lost and the next attempt repeats the mistake.

**Examples.**

- [ajv_migration_attempt.md](ajv_migration_attempt.md). Captures the four-validator ajv migration revert. Records: 785 → 1,396 lines, no dependency reduction, lax-mode mini-DSL, semantic-checks-dressed-as-schema-validation lesson, what shipped instead (integrity extraction at commit `192e971`), branch `worktree-agent-aa2a30d634d859b5c` force-deleted.
- [phase_6_recovery_attempt.md](phase_6_recovery_attempt.md). Captures the Phase 6 first-attempt revert. Records: ~1300 new lines, 96 tests pinning labels-not-behavior, observable-vs-controlling discovery, what's salvageable (pure module, classifier, recipes, events, `runGitRebase`, BuildFailed remediation, QA dev-packet fix), what needs redesign (state-machine integration), branch `phase-6-recovery` force-deleted.

**Recognition signal.** A revert decision with no preservation surface — "we'll remember this." Tribal memory is not memory. Without a note, the next attempt's brief is the same brief.

**Corrective move.** Every revert produces a `type: lesson` research note before the branch is deleted. The note is short (100-150 lines), structured (what was tried / what went wrong per round / comparison stats / what's salvageable / what needs redesign / iteration record / references), and indexed in `docs/decisions/MEMORY.md` under "Research and lessons."

---

## 7. Codex hang-and-restart operational pattern

**Pattern.** Across this session, `codex exec -m gpt-5.5` hung at startup (network stall, 0 CPU, 0 bytes output) in 5 out of 8 dispatches. Manual kill + restart succeeded every time but blocked progress until noticed. The fix is operational, not algorithmic: wrap codex dispatches in a SIGKILL watchdog so the OS terminates a hung process at a known time bound.

**The Bash pattern.**

```sh
bash -c 'codex exec ... & CODEX_PID=$!; \
  (sleep 360 && kill -KILL $CODEX_PID 2>/dev/null) & WATCH_PID=$!; \
  wait $CODEX_PID; EXIT=$?; kill $WATCH_PID; exit $EXIT'
```

The 360-second bound is chosen empirically: a successful review typically lands within 3-8 minutes, and a hang is reliably distinguishable from work-in-progress because hung processes show 0 bytes of output the entire time. Hung-but-killed dispatches re-dispatch successfully.

**Alternatives tried and ruled out.**

- `ScheduleWakeup` — fires only in `/loop` mode (the harness's dynamic-pacing variant), not for arbitrary background processes.
- `timeout` — unavailable on macOS by default; introducing a `coreutils` or `gtimeout` dependency is a host-environment leak.

**Recognition signal.** The codex output file is at 0 bytes after the typical 3-8 minute review window. The process is still running but emitting nothing.

**Corrective move.** Kill the hung process. Re-dispatch with the SIGKILL watchdog wrapped around the `codex exec` invocation. The watchdog is the primitive; the kill bound is the contract; the re-dispatch is automatic.

---

## 8. FI-7 distinct identity for orchestrator / developer / QA

**Pattern.** Architectural changes use three distinct Opus identities (separately spawned via the Agent tool, fresh context each) plus codex GPT-5.5 as the reviewer for genuine cross-vendor independence. Same-model instances share blind spots; cross-identity verification catches what one identity would miss.

**The four roles.**

| Role | Identity | Worktree | Reason |
|---|---|---|---|
| Orchestrator | Opus (this conversation) | main / parent | Scopes work, dispatches, integrates verdicts |
| Developer-Agent | Opus, fresh context | isolated worktree | Implements the brief; no orchestrator-conversation context to bias toward "what the orchestrator already believes" |
| Reviewer | codex GPT-5.5 | implementation worktree | Different vendor for genuine model-independence; runs against the freshly-pushed commit |
| QA Verifier | Opus, fresh context | independent worktree | Post-implementation audit against acceptance criteria; no developer-conversation context |

**Example.** Throughout this session, QA independently verified every architectural change's acceptance criteria and caught nuances the developer missed — for instance, the test-pins-bug facade in DEP0190 round 1 (per (2) above) was a QA-surfaced finding.

**Recognition signal.** A single agent identity doing all three roles. The orchestrator implements, then reviews its own implementation, then approves it. Self-review's blind-spots are systematic.

**Corrective move.** Dispatch sub-agents with `isolation: "worktree"` and fresh prompts for each role. Each agent gets the brief plus the necessary context; none gets the others' conversation. The reviewer (codex) and the QA verifier (Opus) are independent verification surfaces, not pipeline stages.

---

## How to use this doc

Orchestrators read this at session start. When a pattern's recognition signal fires during work, the orchestrator should name it explicitly ("this is pattern 4 — observable-vs-controlling"), apply the corrective move, and continue.

The patterns are recognition signals, not a complete workflow. The workflow itself (Coordinator → Developer-Agent → codex review → Opus QA → Orchestrator → merge) is captured separately in `docs/decisions/workflow.md` (TBD per `docs/decisions/QUEUE.md`).

New patterns get appended to this doc when they surface. The threshold is "we've now seen this failure shape twice and named it both times" — not "this happened once and felt notable."

## References

- [ajv_migration_attempt.md](ajv_migration_attempt.md) — Phase 4.6 revert lesson (concrete instance of (1) and (6))
- [phase_6_recovery_attempt.md](phase_6_recovery_attempt.md) — Phase 6 revert lesson (concrete instance of (1), (4), (5), (6))
- [reviewer_cli_exception.md](../decisions/reviewer_cli_exception.md) — the doc that surfaced the silent fallback under (3)
- `docs/decisions/MEMORY.md` — index of decisions and lessons
- `docs/decisions/QUEUE.md` — active work-items queue; `workflow.md` is the first planned item
