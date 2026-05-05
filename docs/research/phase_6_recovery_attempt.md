# Research Note — The Phase 6 Recovery Attempt That Wasn't

**Date:** 2026-05-05
**Context:** Phase 6 of `specs/single-entry-pipeline.md` — recovery layer; reverted after 3 review rounds.
**Status:** Lesson learned, recorded for the Phase 6 (revised) attempt.

---

## What we tried

Phase 6 was scoped as the recovery layer per `docs/decisions/recovery_recipes_not_dsl.md`:

- 8 failure scenarios with scenario-keyed recipes (no DSL)
- Per-scenario per-packet retry budget (2/2/1/1/0/0/0/0)
- 4 new event types (`recovery.attempt_started/succeeded/exhausted/escalated`)
- Cap-vs-retry interaction: cost cap check before each retry
- Wiring at every `invokeAgent` call site + every `complete.ts` lifecycle boundary
- Pure/I-O/orchestration split mirroring Phases 5.5 and 5.7

Module shape:
- `tools/pipeline/recovery.ts` (pure: types, classifier, recipes)
- `tools/recovery.ts` (I/O: writeEscalation)
- `tools/pipeline/recovery_loop.ts` (orchestration: runWithRecovery wrapper)

Three rounds of codex GPT-5.5 review surfaced increasingly deep correctness gaps:

**Round 1 — REQUEST-CHANGES.** Three findings, all the same shape — recipe action labels propagated through the system but the actions themselves never executed:

1. `ProviderUnavailable` was unreachable in the classifier (recipe registered but no input ever dispatched to it).
2. `BuildFailed` recovery at `completePacket` boundaries didn't invoke the dev-agent remediation step (`attempt.action === 'retry_with_guardrail_prompt'` was passed through but the closures ignored it).
3. `StaleBranch` never actually ran `git fetch && git rebase origin/main` (recipe returned the action label, no code anywhere executed git).

Tests pinned the labels, not the behavior. CLAUDE.md §3.5 facade pattern.

**Round 2 — REQUEST-CHANGES.** Round 1's fixes wired the actions correctly, but two new findings emerged:

1. `StaleBranch` was still production-unreachable. Round 1's classifier check on `context.kind === 'git'` was correct, but no production code path produced `kind: 'git'` failures. The recovery layer was wired but never engaged on real stale-branch conditions.
2. QA completion BuildFailed remediation passed the QA packet to `buildDevPrompt` instead of the dev packet referenced by `packet.verifies`.

Round 2's tests still confirmed only that labels propagated; reaching production required new detection in `request_review.ts` and `complete.ts`.

**Round 3 — RECOMMEND-REVERT.** Round 2's fixes added stale-branch detection at the lifecycle boundary AND fixed the QA dev-packet bug. But codex found a deeper architectural issue:

> `StaleBranch` escalation at `request_review` is observable but not controlling.
>
> In `tools/pipeline/develop_phase.ts:582`, a failed `runWithRecovery` result is only logged, then the state machine unconditionally advances to `review` at line 586. That means a stale-branch rebase conflict can emit `recovery.escalated` and still proceed into review/finalize. Since `completePacket` only requires `started_at`, not `review_approved`, this can still complete the packet after the failed request-review/rebase path. That violates the Phase 6 contract: "rebase conflict escalates without retry" must stop the packet, not just write an escalation event and continue.

The round 3 test missed the bug because it queued a successful `completePacket` next, masking the bad fallthrough.

## Comparison at the rejection point

| | Pre-Phase-6 (main) | Post-round-3 (rejected) |
|--|---|---|
| Recovery code | None | ~1300 new lines across 3 modules + lifecycle helper |
| Tests pinning recovery behavior | None | 96 new tests (485→596) |
| External dependencies | None | None |
| Round 1 verdict | — | REQUEST-CHANGES (3 findings: action-not-executed) |
| Round 2 verdict | — | REQUEST-CHANGES (2 findings: production-unreachable + QA packet) |
| Round 3 verdict | — | RECOMMEND-REVERT (escalation observable not controlling) |

## What went wrong

**Pattern:** the recovery layer was treated as a separable orthogonal subsystem — typed events, recipes, budgets, classifier, all as one design problem. The integration with the per-packet state machines in `develop_phase.ts` and `verify_phase.ts` was treated as wiring, not as a first-class design problem.

The actual integration concern: when recovery escalates, the state machine that called the wrapped operation must HONOR the escalation as a stopping signal. The per-packet loop must:

- Mark the packet as `failed`
- Skip remaining transitions for this packet
- Continue to the next independent packet

Round 3 made the recovery layer's escalation **observable** (the event fired, the file was written) but the state machine ignored it and kept advancing. That's a recovery layer that emits truthful signals into a void — exactly the dishonest-system pattern from CLAUDE.md §3.3 (failure must be visible AND controlling).

## What's salvageable for Phase 6 (revised)

The pure surface and the foundational pieces all worked:

- `tools/pipeline/recovery.ts` (pure types, classifier, recipes, retry budgets) — design correct, code correct
- `tools/recovery.ts` (writeEscalation I/O) — correct
- 4 new event types in `pipeline/events.ts` (recovery.*) — correct, follows Phase 5.5 extension pattern
- `runGitRebase` execution in the impure layer — correct
- BuildFailed dev-agent remediation invocation logic — correct (round 2 fix)
- QA BuildFailed dev-packet resolution — correct (round 3 fix)
- Cross-layer pattern drift test — correct, valuable
- Boundary discipline — preserved (recovery.ts pure)
- Cap-vs-retry interaction order (cost.cap_crossed → recovery.escalated) — correct

What needs re-design in Phase 6 (revised):

- **State-machine integration as a first-class concern.** The per-packet loops in develop_phase / verify_phase must stop on escalation, not log-and-continue. This means the recovery layer's return type must be inspectable by the caller AND the caller's loop must dispatch on it.
- **Test discipline that catches "observable but not controlling".** Tests that drive the state machine end-to-end and assert NOT just "the escalation event fired" but "the packet was marked failed AND no further state transitions occurred."
- **Possibly: `runWithRecovery` returning a discriminator the caller can match on (`{ ok: true, value } | { escalated: true, reason }`) instead of just emitting events and returning a value.**

## The lesson

**Pattern:** when adding an orthogonal cross-cutting layer (recovery, tracing, auth, etc.) to an existing state machine, the integration is the architecture, not the wiring. The cross-cutting layer's signals must be both **observable** (events fire, audits accumulate) AND **controlling** (the calling loop dispatches on them). Tests must drive the calling loop to confirm BOTH.

The specific tell here: the brief listed "wire recovery into phases" as the last commit in the suggested sequence and named it as wiring, not as integration. The phase modules each have packet-state-machine logic that the brief did not analyze. The recovery layer was correct in isolation; the test suite confirmed it; the production state machine ignored it.

A clean recovery integration requires:
- The recovery layer to expose its terminal states (escalation, exhaustion) as inspectable return types, not just events
- The calling state machine to have explicit dispatch on those terminal states
- Integration tests that drive the calling state machine end-to-end and assert post-escalation invariants (packet marked failed, no further transitions)

## Iteration record (informational)

The original attempt's branch was `phase-6-recovery`. 10 commits, 3 review rounds, force-deleted after the recommend-revert verdict. Total developer effort: meaningful but not wasteful — the failed iteration produced the codex analysis that informed the correct shipping scope and the lesson recorded here.

This is the second case (after `ajv_migration_attempt.md`) where the bounded-iteration model surfaced an architectural error in the brief itself, not in the implementation. The right move was to honor the signal rather than push to a fourth round.

## What's preserved for Phase 6 (revised)

A new attempt should:

1. Salvage the pure recovery module + I/O wrapper + recovery_loop's `runWithRecovery` (with the typed return value addition).
2. Salvage the cross-layer pattern drift test, the QA dev-packet fix, the lifecycle stale-branch detection.
3. Re-write the per-packet state machines in develop_phase and verify_phase to dispatch on escalation, with integration tests that assert post-escalation invariants.
4. Consider whether the per-packet state machine itself needs a small refactor (e.g., exposing the loop body as a function returning an explicit "next state | failed" discriminator) to make the dispatch surface clean.

## References

- `specs/single-entry-pipeline.md` — Phase 6 section (the original brief)
- `docs/decisions/recovery_recipes_not_dsl.md` — design choice (still correct)
- `docs/research/ajv_migration_attempt.md` — the prior precedent for bounded-iteration revert
- Git history: the `phase-6-recovery` branch was force-deleted; the round-by-round verdicts and the orchestrator's review notes are in the session transcript
