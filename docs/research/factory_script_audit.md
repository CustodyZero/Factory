---
name: Factory script audit — honest evaluation of tools/ on idempotency and usefulness, ahead of the pipeline redesign
description: Self-audit of factory at v0.2.0 (post-pipeline-redesign in commit `5a6df82`), surveyed 2026-04-30. Honest evaluation of all 12 TypeScript files in `tools/` (3,544 lines total) plus `setup.sh`, `setup.ps1`, and `hooks/pre-commit`, scored on two dimensions: idempotency (idempotent / strict-with-resume / N/A) and usefulness (load-bearing / useful / marginal). The audit's headline finding — `run.ts` at 798 lines with zero tests doing seven distinct jobs, while pipeline-idempotent in the orchestrator sense, is the load-bearing weakness in the script surface — drove the four-layer decomposition committed in [single_entry_pipeline.md](../decisions/single_entry_pipeline.md). The "strict scripts + idempotent orchestrator" coupling identified here is what the post-decision idempotency rewrite of `start.ts`/`request-review.ts`/`review.ts`/`complete.ts` was designed to dissolve. Secondary findings that shaped the spec layer: `plan.ts` and `execute.ts` are useful as libraries with marginal CLI surfaces (the CLI is mostly bypassed by `run.ts`), and the `start.ts` "already-done → exit 0" pattern is the cleanest of the imperative scripts and worth generalizing. The audit explicitly precedes any further significant changes, and is therefore the canonical input to the architecture move that followed.
type: reference
---

# Research Audit — Factory Scripts

**Surveyed:** 2026-04-30
**Surface:** 12 TypeScript files in `tools/` (3,544 lines total) plus `setup.sh`, `setup.ps1`, and `hooks/pre-commit`
**Scope:** Honest evaluation of each script on two dimensions — *idempotency* (is re-running safe?) and *usefulness* (does the script earn its place?)
**Self-audit context:** Factory at v0.2.0, post-pipeline-redesign. The previous orchestrator/supervisor architecture was deleted in commit `5a6df82` and replaced with a single pipeline runner (`run.ts`). This audit is performed before any further significant changes.

---

## 1. Per-script evaluation

Idempotency rubric:
- **✅ Idempotent** — re-runs are safe and produce the same state
- **⚠️ Strict-with-resume** — script errors on re-run by design; orchestrator compensates by skipping already-done work
- **N/A** — pure library, no side effects

Usefulness rubric:
- **🟢 Load-bearing** — factory wouldn't function without it
- **🟡 Useful** — used by something but not strictly required
- **🔴 Marginal** — could be deleted with little impact

| Script | Lines | Idempotency | Usefulness | Tests | Notes |
|--------|-------|-------------|------------|-------|-------|
| `run.ts` | 798 | ✅ Pipeline-idempotent | 🟢 Load-bearing | ✗ None | Reads packet status and completion files on disk each iteration; resumes wherever left off. No automated verification of any of its 800 lines. |
| `status.ts` | 364 | ✅ Read-only | 🟢 Load-bearing | ✓ | Per CLAUDE.md "run at start of every session." Tested. |
| `plan.ts` | 303 | ✅ Read-only | 🟡 Library; CLI marginal | ✓ (lib) | Library functions used by `run.ts`. CLI surface is mostly bypassed. |
| `execute.ts` | 360 | ✅ Read-only | 🟡 Library; CLI marginal | ✓ (lib) | Same shape as `plan.ts`. |
| `start.ts` | 62 | ✅ Properly idempotent | 🟡 Useful | ✗ | Checks if already started, prints message and exits 0. Cleanest of the imperative scripts. |
| `request-review.ts` | 144 | ⚠️ Strict | 🟡 Useful | ✗ | Errors if status is already `review_requested`. `run.ts` swallows the error. |
| `review.ts` | 117 | ⚠️ Strict | 🟡 Useful | ✗ | Errors if status is not `review_requested`. `run.ts` only invokes if status hasn't transitioned. |
| `complete.ts` | 172 | ⚠️ Strict (FI-1) | 🟢 Load-bearing | ✗ | Errors if completion exists. `run.ts` skips already-completed packets. |
| `validate.ts` | 606 | ✅ Read-only | 🟢 Load-bearing | ✗ | Pre-commit + manual. 606 lines of hand-rolled schema validators. |
| `completion-gate.ts` | 219 | ✅ Read-only | 🟢 Load-bearing | ✓ | Pre-commit FI-7 enforcement. Tested. |
| `output.ts` | 155 | N/A library | 🟢 Used everywhere | ✓ | Color/symbol/log helpers. |
| `config.ts` | 244 | N/A library | 🟢 Used everywhere | ✓ | Config loader. |

---

## 2. The layered idempotency pattern

Factory's idempotency story is **layered**:

- **Strict scripts.** `request-review`, `review`, `complete` (and to a lesser extent `start`) all error on re-run by design. Calling `complete.ts p1` twice fails the second time with "Completion already exists (FI-1)." Same for review and request-review with their state guards.
- **Idempotent orchestrator.** `run.ts` reads packet status and completion files from disk before invoking any of the strict scripts and skips when work is already done.

The pattern works. Re-running `npx tsx tools/run.ts <intent-id>` after a partial pipeline does the right thing. But the pattern is **implicit** — nothing in the codebase or docs explains why the strict scripts are deliberately not idempotent or how the orchestrator compensates.

The honest framing of run.ts's idempotency claim is:

> *"`run.ts` is idempotent because `run.ts` knows how to skip work that's already done. The scripts it calls are not."*

Two real risks follow from this implicit coupling:

1. **External callers inherit the failure surface.** If a human runs the lifecycle manually, or if a different orchestrator (a future LSP integration, a CI runner, anything else) calls these scripts, error handling falls on the caller. The scripts return exit 1 with informative messages, but they do not auto-recover.
2. **Status-reading logic and precondition logic must stay in lockstep.** If `run.ts`'s `deriveDevResumePoint` and the strict scripts' precondition checks ever drift apart, the pipeline becomes fragile in subtle ways. Today they happen to match because the same person wrote both; nothing enforces that they continue to match.

This pattern is not wrong, but it is **un-stated architecture** that should be either documented or refactored.

---

## 3. CLI surfaces that are mostly bypassed

`plan.ts` and `execute.ts` have CLI entry points that nothing in the live workflow shells out to. `run.ts` imports their library functions directly (`hydrateIntent`, `resolvePlanAction`, `resolveExecuteAction`).

The CLI wrappers exist for two reasons:
- *Inspection mode* — "show me what the planner would do for this intent right now"
- *Manual mode* — humans driving the lifecycle without `run.ts`

Both are real but neither is load-bearing. Cost: ~200 lines of CLI scaffolding + arg parsing + human-readable rendering across the two files combined.

If the CLI surfaces were deleted and only the library exports kept, `run.ts` would be unaffected. The published `AGENTS.md` documentation would need updates.

These CLIs are not dead. They are **marginal**.

---

## 4. The test coverage gap

The split is clean:

- **Tested (6 scripts):** `completion-gate`, `config`, `execute`, `output`, `plan`, `status` — all *pure functions* or libraries
- **Untested (6 scripts):** `complete`, `request-review`, `review`, `run`, `start`, `validate` — all *imperative I/O*

The boundary is exactly where you'd expect it. The pure side has unit tests; the side-effecting side does not. This matches a pattern that's defensible at first glance ("you can't easily test things that touch the disk") but **fails the test** in CLAUDE.md §3.5:

> "An inability to test behavior is an architectural deficiency, not a justification for weaker tests. If behavior cannot be tested deterministically, the design must be changed."

Concretely:
- `run.ts` is the entire pipeline — and it has zero automated verification
- `complete.ts` is the FI-1 enforcement point — and it has zero automated verification
- `validate.ts` is the FI-* enforcement point — and it has zero automated verification

The pure-side tools were factored to be testable. The imperative tools were factored to be **un-testable**. That is a design choice; it could be reversed by extracting the pure logic into testable functions and reducing the imperative scripts to thin I/O wrappers.

---

## 5. `run.ts` as the load-bearing weakness

If exactly one thing in factory is the highest-priority concern, it is `run.ts`.

798 lines doing seven distinct jobs:

1. Loading config and the intent artifact
2. Invoking the planner agent (with retry logic embedded inline)
3. Reading feature artifacts back from disk
4. Topological sort of packets by dependencies
5. Dev state machine (`implement` → `request_review` → `review` → [`rework` | `finalize`])
6. QA loop (start → invoke → complete)
7. Prompt building — four separate prompt builders inlined as functions at the bottom

The state machine is implemented as a `while` loop wrapping a `switch`, where each case mutates `currentPoint` and `ok`. Failures `break` out of the switch with `ok = false`. State transitions aren't testable today because they're entangled with shell-outs to `start.ts`, `request-review.ts`, and `review.ts` (and each of those has its own error path that `run.ts` swallows).

This is the script most likely to break in interesting ways. It is the script we have **no automated way to verify**. It is the script users invoke first.

Every other reliability concern in the toolkit is downstream of this one.

---

## 6. Other cross-cutting observations

### 6.1 Duplicate validation runs

Between a developer running `complete.ts` and the commit landing:

- `complete.ts` runs build, lint, test, then re-runs `validate.ts`
- pre-commit hook runs `completion-gate`, then `validate.ts` again

`validate.ts` runs twice in a tight window. It reads a small handful of JSON files; not expensive. But the second invocation cannot catch anything the first one wouldn't, because nothing has changed between them in the normal flow.

This is not broken. It is overhead.

### 6.2 `validate.ts` is 606 lines of hand-rolled schema validation

Four separate validator functions (`validatePacketSchema`, `validateCompletionSchema`, `validateFeatureSchema`, `validateIntentSchema`), each ~30-50 lines, manually checking required fields, types, and constraints. The JSON schemas in `schemas/` describe the same shape declaratively.

When we set up the convention alignment earlier this session, we used `ajv-cli` to validate `factory.config.json` against `factory-config.schema.json`. The same library could replace the bulk of the hand-rolled validators in `validate.ts`.

Cost of the current approach: ~300+ lines of imperative validation logic that drifts out of sync with the schemas it duplicates.

### 6.3 Shell-outs vs library calls

`run.ts` shells out to `start.ts`, `request-review.ts`, `review.ts` via `execSync` — even though those scripts run in the same Node.js installation and could be library calls.

`complete.ts` is the exception: it exports a `completePacket(options)` function and `run.ts` could (but does not currently) import it. The CLI wrapper at the bottom of `complete.ts` is a thin shell over the function. The other state-mutating tools have no such split.

Cost of the current approach:
- Process spawn overhead per call (small, but real)
- String-based error handling at the boundary (less robust than typed errors)
- Inconsistency: `complete.ts` is library-shaped, the others are not

### 6.4 What `start.ts` gets right

`start.ts` is 62 lines and properly idempotent. If the packet is already started, it prints `Packet already started: <id>` and exits 0. This is the only state-mutating script that handles re-entry gracefully.

It is also the simplest. The pattern scales: if `request-review.ts`, `review.ts`, and `complete.ts` followed the same approach (detect "already done" state and return success silently), the orchestrator wouldn't need to read state defensively before each call.

---

## 7. Issues summary table

| Issue | Where | Severity |
|-------|-------|----------|
| `run.ts` is the pipeline and has no tests | `tools/run.ts` | High |
| Imperative scripts have no tests (6 of 12) | `complete`, `request-review`, `review`, `run`, `start`, `validate` | High |
| Strict-script + idempotent-orchestrator pattern is implicit | All state-mutating scripts | Medium |
| `validate.ts` is hand-rolled schema validation duplicating the JSON schemas | `tools/validate.ts` | Medium |
| `run.ts` shells out to scripts that could be library calls | `start`, `request-review`, `review` invoked via `execSync` | Medium |
| `validate.ts` runs twice per commit | end of `complete.ts` + pre-commit hook | Low |
| `plan.ts` and `execute.ts` CLI surfaces are mostly bypassed | both | Low |

---

## 8. The one most-load-bearing weakness

`run.ts` has no tests and is the pipeline.

If `run.ts` breaks, factory breaks. Every other reliability concern in the toolkit is downstream of this one. The first reliability investment that pays off is making `run.ts` testable — which means extracting its pure decision logic (state derivation, prompt building, packet sorting, retry policies) out of the I/O loop and into testable functions.

---

## 9. Suggested next moves (opinions, not commitments)

The following are **opinions** flagged as such per CLAUDE.md §9.3. They are not decided; they are inputs to a decision.

1. **Capture the layered-idempotency pattern as an explicit decision.** Whether or not we keep the pattern, it should not remain unstated architecture.
2. **Extract `run.ts`'s testable core.** Pull state derivation, prompt building, and packet sorting into pure functions; test those. Keep the I/O wrapper thin.
3. **Replace `validate.ts`'s hand-rolled validators with `ajv`.** Cuts ~300 lines and removes a class of schema-drift bugs.
4. **Library-ize the imperative scripts.** `start`, `request-review`, `review` should expose typed functions; the CLIs become thin wrappers. `run.ts` calls library functions instead of shelling out.
5. **Make all state-mutating scripts properly idempotent** (the `start.ts` pattern). Detect "already done" state and return success silently. The orchestrator no longer has to read state defensively.
6. **Trim `plan.ts` / `execute.ts` CLI surfaces** to the minimum useful, or merge their inspection capabilities into `status.ts --feature <id>` and delete the standalone CLIs.

Items 2 and 5 together would solve the "no tests for imperative side" problem at the source: the imperative side becomes a thin shell over tested pure functions.

These suggestions are listed in *priority order based on observed risk* (item 2 addresses the highest-severity issue), not in implementation order. Implementation order depends on which suggestions get adopted.
