---
name: Factory development workflow — Orchestrator, worktree-isolated developer, codex review, FI-7 QA
description: >-
  How factory-development work in this repo is governed — the procedure the recognition signals in `docs/research/recurring_workflow_patterns.md` apply to. Four roles: an Orchestrator (Opus, the host session) scopes work from `QUEUE.md` and integrates verdicts; a Developer Agent (Opus, fresh context, dispatched via the `Agent` tool with `isolation: "worktree"`) implements one work item and stops; a Reviewer (codex GPT-5.5 via `codex exec`, wrapped in a SIGKILL watchdog per Pattern 7) emits an APPROVE / REQUEST-CHANGES / RECOMMEND-REVERT verdict to `refs/notes/reviews`; a QA Agent (Opus, fresh context, identity distinct from the developer per FI-7) verifies acceptance criteria end-to-end. Bounded-iteration + role-flip from Pattern 1 of `recurring_workflow_patterns.md` governs round budgets: three same-chair rounds maximum, then revert (brief architecturally wrong) or role-flip (progress real but slow); rounds 4-5 use swapped chairs; round 6 escalates to user. This workflow governs factory-development; it does NOT govern host-project pipeline runs (those go through `tools/run.ts` per `single_entry_pipeline.md`, with factory's own non-self-hosted posture set by `factory_self_governance.md`). locked 2026-05-12.
type: project
---

# Factory Development Workflow

## Why this exists separately from AGENTS.md / CLAUDE.md

Three documents, three jobs:

| Document | Role |
|---|---|
| `AGENTS.md` (repo root) | The canonical operator profile — the rules every contributor (human + AI) follows when operating in this repo. |
| `CLAUDE.md` (repo root) | The Claude-Code-specific overlay — the critical-rules subset and quick reference Claude reads first. |
| `docs/decisions/workflow.md` (this file) | The orchestration shape — the procedure the rules apply to. How work moves through roles, which agent runs on which model, where verdicts live, what the round budget is, how scope is bounded. |

The rules without the procedure are inert; the procedure without the rules is unmoored. This file makes the procedure explicit and committable, so future sessions read it instead of re-litigating the orchestration shape each time.

## Scope boundary

This workflow governs **factory-development work** — changes to this repo by the Orchestrator session and the agents it dispatches. It is the procedure for evolving the factory itself: decision docs, research notes, `tools/` source, `schemas/`, templates, and the rest of the factory codebase.

It does **not** govern **host-project pipeline runs**. Those run through `npx tsx tools/run.ts <spec-id>`, are governed by [`single_entry_pipeline.md`](single_entry_pipeline.md), and have an entirely different shape (planner → developer → code-reviewer → QA across packets within a feature, all driven by the factory's own deterministic orchestrator, not by a human session).

Factory is **not** self-hosted by its own pipeline. See [`factory_self_governance.md`](factory_self_governance.md): the pipeline runner is not invoked against this repo, specs in `specs/` are read by humans and Claude during design and implementation sessions rather than fed to autonomous runs, and the deferral of self-governance is deliberate. This workflow doc captures what we do *instead* of running factory on itself.

## Roles

| Role | Identity | Dispatch mechanism | Responsibilities | Why this model, not another |
|---|---|---|---|---|
| **Orchestrator** | Opus (this conversation, host environment) | N/A — the host session itself | Scope work from `QUEUE.md`; author the brief; dispatch the developer; run codex review; read the verdict; decide accept / send-back / escalate; dispatch QA when needed; attach the approval note; merge; push; clean up the worktree. | Opus quality bar for design judgment, integration decisions, and final accept/escalate calls. The orchestrator is the only role that touches the merge boundary; substituting a smaller model here trades quality on the load-bearing decision for cost savings on the cheap part of the workflow. |
| **Developer Agent** | Opus, fresh context | `Agent` tool with `isolation: "worktree"` | Read the brief; implement the change on the worktree branch; commit; stop. Never merges, never pushes, never touches the parent worktree. No state from the orchestrator session except what's in the dispatch prompt. | Opus quality bar for implementation, consistent with the Apple-philosophy / Doom-philosophy posture used elsewhere in the org. Fresh context isolates the developer from orchestrator priors (the developer should converge on the brief's intent, not on "what the orchestrator already believes"). Worktree isolation keeps implementation work off the host's working tree. |
| **Reviewer** | codex GPT-5.5 | `codex exec` (CLI), wrapped in a SIGKILL watchdog | Read the diff + commit message; emit one verdict — `APPROVE`, `REQUEST-CHANGES`, or `RECOMMEND-REVERT`. Verdict goes to `refs/notes/reviews` attached to the reviewed commit. Reviewer never writes code; verification only. | Different vendor (OpenAI vs. Anthropic) for genuine reasoning-pattern diversity. Two Opus instances share blind spots from shared training; cross-vendor review catches what Opus-on-Opus would miss. The SIGKILL watchdog is operational (not algorithmic) per Pattern 7 in `recurring_workflow_patterns.md`: `codex exec` hangs at startup in roughly 5/8 dispatches in this session's experience, and the watchdog is the smallest honest fix. |
| **QA Agent** | Opus, fresh context — **identity distinct from the Developer Agent** | `Agent` tool with a fresh dispatch (separate sub-agent invocation from the developer) | Verify the acceptance criteria from the brief end-to-end against the merged-state contract; run integrity checks (frontmatter parse, `npx tsx tools/validate.ts`, `npx vitest run`); emit `APPROVE` or `REQUEST-CHANGES`. Never modifies code; verification only. | Same model class as the developer for quality bar parity, but a distinct identity to satisfy FI-7 ("the agent identity that records a packet's QA verification must differ from the identity that performed the dev work") at host-context level rather than at sandboxed-CLI level. The QA agent reads the merged-state contract — what the change actually delivers across the repo — not just the diff. See [`reviewer_cli_exception.md`](reviewer_cli_exception.md) for the host-project pipeline's verdict-channel framing of the same FI-7 principle. |

## Lifecycle

The concrete sequence covers three paths: happy-path acceptance, REQUEST-CHANGES re-dispatch, and RECOMMEND-REVERT.

### Happy path

1. **Orchestrator scopes from queue.** Reads `docs/decisions/QUEUE.md`, picks the top item under "Planned (next up)", validates that intent is clear and single-purpose per CLAUDE.md §5.2.
2. **Orchestrator authors the brief.** Includes: the work item, acceptance criteria, anti-scope, file-update checklist, commit-discipline rules. The brief is the dispatch prompt.
3. **Orchestrator dispatches the Developer Agent** via the `Agent` tool with `isolation: "worktree"`. The Developer Agent receives the brief and operates in a fresh worktree branch (typically `worktree-agent-<hash>`).
4. **Developer Agent implements + commits.** One commit per dispatch on the worktree branch. The Developer Agent **does not** push, merge, or touch the parent worktree. On completion, the agent returns a summary to the Orchestrator.
5. **Orchestrator dispatches codex review** against the worktree commit, using a SIGKILL-watchdog-wrapped `codex exec` invocation (per Pattern 7). Watchdog bound is 360 seconds; a hung dispatch is killed and re-dispatched.
6. **Codex writes the verdict** to `refs/notes/reviews` attached to the reviewed commit, with the verdict body containing findings and an explicit `APPROVE` / `REQUEST-CHANGES` / `RECOMMEND-REVERT` marker.
7. **Orchestrator reads the verdict** via `git notes --ref=reviews show <sha>`.
8. **If APPROVE:** Orchestrator dispatches the QA Agent via the `Agent` tool with a fresh sub-agent context, distinct identity from the Developer Agent. QA verifies the acceptance criteria end-to-end and emits `APPROVE` or `REQUEST-CHANGES`.
9. **If QA APPROVE:** Orchestrator attaches an approval note (also at `refs/notes/reviews`), runs `git merge --no-ff <worktree-branch>` from `main`, pushes both `git push origin main` and `git push origin refs/notes/reviews`, then `git worktree remove` + `git branch -d <worktree-branch>` for cleanup. Queue entry moves from "Planned" to "Accepted (recent)" with the merge-commit SHA.

### REQUEST-CHANGES re-dispatch path

- If codex emits `REQUEST-CHANGES` at step 6, the Orchestrator re-dispatches the same Developer Agent identity (same chair) with the original brief **plus** codex's findings appended as round-specific feedback. The new dispatch starts from the existing worktree branch — not a fresh worktree — so the iteration arc is continuous.
- Same path for QA `REQUEST-CHANGES` at step 8: re-dispatch the Developer Agent with QA's findings.
- Round counter increments on each REQUEST-CHANGES round; bounded-iteration applies (see "Bounded-iteration + role-flip" below).

### RECOMMEND-REVERT path

- If codex emits `RECOMMEND-REVERT` at any round, the Orchestrator halts, writes a `type: lesson` research note to `docs/research/<lesson-name>.md` capturing what was tried, what went wrong per round, and what's salvageable (per Pattern 6), then surfaces to the user with the lesson note and a proposed re-brief.
- The worktree branch is force-deleted (`git worktree remove --force` + `git branch -D <worktree-branch>`) only **after** the lesson note is committed to `main`. Lesson preservation precedes branch deletion; this ordering is load-bearing per Pattern 6.

## Bounded-iteration + role-flip

The round-budget rule is **Pattern 1** of [`../research/recurring_workflow_patterns.md`](../research/recurring_workflow_patterns.md). It is not restated in full here; the operational compression is:

- **Three rounds maximum with the same chairs.** Same Developer Agent identity, same Reviewer (codex), same brief.
- **At round 3, the Orchestrator decides one of two moves** by asking: *"if a different agent took the developer chair with this round's review feedback, would they likely converge in 1-2 more rounds?"*
  - **Yes → role-flip.** Swap chairs literally: the original Reviewer (codex) becomes the developer for round 4, and the original Developer Agent (Opus) becomes the reviewer. Both bring their accumulated context as positional advantage. Same brief, swapped chairs — not a fresh dispatch.
  - **No → revert.** The brief itself is architecturally wrong. Force-delete the branch (after writing the lesson note per Pattern 6), re-write the brief, dispatch the next attempt against the corrected brief.
- **Role-flipped rounds 4-5 use the swapped chairs.** Round budget caps at 5 total rounds (3 same-chair + 2 role-flipped).
- **Round 6 escalates to the user.** No further rounds without user judgment.

The precedents for this rule are the two existing revert lessons:

- [`../research/ajv_migration_attempt.md`](../research/ajv_migration_attempt.md) — Phase 4.6 ajv migration. Three rounds; round 3 RECOMMEND-REVERT. Role-flip would have been wrong because the architectural premise was wrong. Lesson preserved; integrity extraction shipped instead.
- [`../research/phase_6_recovery_attempt.md`](../research/phase_6_recovery_attempt.md) — Phase 6 recovery layer. Three rounds; round 3 RECOMMEND-REVERT. Role-flip would have been wrong because the integration model itself needed to change. Lesson preserved; revised Phase 6 shipped against a re-written brief.

Both reverts followed the Pattern 6 preservation discipline: lesson notes committed before branch deletion, indexed in `MEMORY.md`.

## Codex review channel — `refs/notes/reviews`

Codex review verdicts live in the **`refs/notes/reviews`** notes namespace, not the default `refs/notes/commits` namespace. The split is deliberate:

- `refs/notes/commits` is git's default notes namespace and is conventionally used for autocommit-history annotations (CI annotations, deployment markers, miscellaneous tooling output). Mixing review verdicts in with that stream would conflate two different concerns.
- `refs/notes/reviews` keeps review verdicts cleanly isolated. They can be fetched, displayed, and pruned independently.

Notes are local until pushed explicitly:

```sh
git notes --ref=reviews show <sha>          # read a verdict locally
git notes --ref=reviews add -m "..." <sha>  # attach a verdict locally
git push origin refs/notes/reviews          # publish to remote (NOT automatic)
git fetch origin refs/notes/reviews:refs/notes/reviews  # fetch from remote
```

The explicit-push requirement is the same shape git uses for all notes namespaces: notes are not pushed by default. The Orchestrator pushes `refs/notes/reviews` **alongside** `git push origin main` at the merge step; both pushes are mandatory on accept.

Contrast with the host-project pipeline's reviewer channel: in `tools/run.ts` runs, the code-reviewer agent calls `review.ts --approve` / `--request-changes` as the structured-verdict CLI per [`reviewer_cli_exception.md`](reviewer_cli_exception.md). That channel is the deterministic-pipeline reviewer's protocol surface; `refs/notes/reviews` is this workflow's equivalent for human-driven factory-development work where the orchestrator is a session, not a CLI runner.

## Accept / escalate decision tree

After reading codex's verdict + (where applicable) QA's verdict, the Orchestrator decides:

| Branch | Trigger | Action |
|---|---|---|
| **Accept** | codex `APPROVE` + QA `APPROVE` (or codex `APPROVE` for docs-only work where QA verification is the orchestrator's read of the merged contract), acceptance criteria met, no scope drift. | Orchestrator attaches approval note to `refs/notes/reviews`. `git merge --no-ff` from `main`. `git push origin main`. `git push origin refs/notes/reviews`. `git worktree remove` + `git branch -d`. Queue entry moves from "Planned" to "Accepted (recent)" with the merge-commit SHA. |
| **Send back** | codex `REQUEST-CHANGES` with real correctness, scope, or facade findings; OR QA `REQUEST-CHANGES`. | Re-dispatch the Developer Agent with the findings appended to the brief. Increment round counter. Bounded-iteration (Pattern 1) applies — at round 3, decide revert or role-flip per the rule above. |
| **Escalate** | codex `RECOMMEND-REVERT`; OR a design-revealing finding that falls outside the brief's premise (e.g., contradicts an existing decision doc); OR exhausted round budget (round 6); OR any case where the Orchestrator's judgment alone is insufficient. | Halt the work. Write a `type: lesson` research note in `docs/research/` (per Pattern 6) capturing what was tried, what went wrong, what's salvageable. Surface to the user with the lesson note and a recommendation (re-brief, drop, defer). User decides next move. |

## When this workflow does NOT apply

- **Host-project pipeline runs.** Governed by [`single_entry_pipeline.md`](single_entry_pipeline.md) and executed by `npx tsx tools/run.ts <spec-id>`. Different roles (planner / developer / code_reviewer / qa across packets), different protocol (lifecycle CLIs as the agent protocol surface), different round budget (per-packet `max_review_iterations`).
- **Trivial docs alignment** under CLAUDE.md §6.1 — direct commits on `main` are permitted for purely-local, no-semantic-impact changes (comments, formatting, renames without behavior change, doc wording tightening). Example: commit `d167851` was a role-flip wording tightening committed directly on `main`. The trivial-change exception is **not** an escape hatch for changes that touch contracts, invariants, or boundaries; if in doubt, run the workflow.
- **Read-only investigation, audits, or research** where no commit is intended. The Orchestrator may dispatch sub-agents to investigate without going through this workflow, provided no code or doc changes land. If the investigation discovers a needed change, the change goes through the workflow as a new queue item.

## Defaults summary (the W-N decisions)

| ID | Decision |
|---|---|
| W-1 | Cross-session state lives in repo: `docs/decisions/QUEUE.md` (the current-state surface) + `docs/decisions/MEMORY.md` (the decision-doc and research index) + `docs/research/` (lessons and audits). |
| W-2 | Four-role lifecycle: Orchestrator (Opus, host session) → Developer Agent (Opus, worktree-isolated, fresh context, dispatched via `Agent` tool with `isolation: "worktree"`) → Reviewer (codex GPT-5.5 via `codex exec`, SIGKILL-watchdog-wrapped) → QA Agent (Opus, FI-7-distinct identity, fresh context, dispatched via `Agent` tool) → Orchestrator integration (merge + push + cleanup). |
| W-3 | Tests at production bar — deterministic verification per CLAUDE.md §5.5. Build-green-or-process-starts is not acceptable proof of correctness; assertions must pin the named contract. |
| W-4 | Completion = build green + `npx vitest run` clean + `npx tsx tools/validate.ts` clean + acceptance criteria explicitly verified by the QA Agent. |
| W-5 | Codex CLI invocation wrapped in a SIGKILL watchdog per Pattern 7 in `recurring_workflow_patterns.md`. Bound: 360 seconds. Hung dispatches are killed and re-dispatched. |
| W-6 | Review notes live at `refs/notes/reviews` (separate from the default `refs/notes/commits` namespace); pushed explicitly via `git push origin refs/notes/reviews` alongside the `main` push at merge time. |
| W-7 | Round budget: 3 same-chair rounds maximum; at round 3 the Orchestrator decides revert vs role-flip per Pattern 1; hard cap at 5 rounds with chairs flipped on rounds 4-5; round 6 escalates to user. |
| W-8 | QA Agent identity differs from Developer Agent identity (FI-7 echo at host-context level — see also [`reviewer_cli_exception.md`](reviewer_cli_exception.md) for the host-project pipeline analog). Dispatched as a fresh sub-agent, never the same identity that authored the dev commits. |
| W-9 | Scope expansion within a workflow round is forbidden per CLAUDE.md §5.6 — surfaces a new queue item, not an extension of the current round. The Orchestrator splits scope; the agents do not. |
| W-10 | This file (`docs/decisions/workflow.md`) is the workflow doc; `MEMORY.md` indexes it; `QUEUE.md` is the current-state surface. New rounds and accepted items update `QUEUE.md`; new decisions and lessons update `MEMORY.md`. |
| W-11 | Reverts produce a `type: lesson` research note in `docs/research/` **before** the worktree branch is deleted, per Pattern 6 in `recurring_workflow_patterns.md`. Lesson preservation precedes branch deletion; this ordering is load-bearing. |

## How to apply

The Orchestrator runs these checks at dispatch time and at integration time. Each one is a rejection rule, not a guideline.

- **Any proposal to dispatch a sub-agent without a corresponding `QUEUE.md` entry:** reject. The queue entry is the authority for the work and the visible surface across sessions. If a queue entry doesn't exist, create one (and decide whether it can be authored directly per CLAUDE.md §6.1 or needs a workflow round itself).
- **Any proposal to merge a worktree branch without codex `APPROVE` AND QA `APPROVE` (where QA applies):** reject. The two verification surfaces are independent by design; collapsing them defeats the purpose. The only exception is the trivial-change carve-out under CLAUDE.md §6.1, which doesn't enter the workflow in the first place.
- **Any proposal to dispatch the QA Agent under the same identity as the Developer Agent for the current round:** reject — FI-7 violation. Spawn a fresh QA sub-agent.
- **Any proposal to expand a round's scope mid-implementation** (the "while we're here..." pattern from CLAUDE.md §5.6): reject. The expansion is a new queue item; surface it to `QUEUE.md` as a new "Planned" entry and continue the current round on the original brief.
- **Any proposal to continue into a fourth same-chair round** (i.e., round 4 with the same Developer Agent and same Reviewer): reject — Pattern 1 violation. Decide revert or role-flip, don't continue.
- **Any proposal to delete a reverted branch without writing the `type: lesson` research note first:** reject — Pattern 6 violation. Lesson preservation precedes branch deletion.
- **Any proposal to merge without pushing `refs/notes/reviews`:** reject. The verdict is part of the contract; an unpushed verdict is a verdict that doesn't exist for other workers.

## References

- [`../research/recurring_workflow_patterns.md`](../research/recurring_workflow_patterns.md) — the recognition signals this workflow's procedure applies to (bounded-iteration, test-pins-the-bug, doc-creates-inconsistency, observable-vs-controlling, state-machine-integration-is-architecture, reverted-lesson preservation, codex hang-and-restart, distinct verification identities)
- [`../research/ajv_migration_attempt.md`](../research/ajv_migration_attempt.md) — Phase 4.6 revert precedent for Pattern 1
- [`../research/phase_6_recovery_attempt.md`](../research/phase_6_recovery_attempt.md) — Phase 6 revert precedent for Pattern 1
- [`reviewer_cli_exception.md`](reviewer_cli_exception.md) — the host-project pipeline's reviewer-verdict channel (CLI exception); contrast point for this doc's `refs/notes/reviews` channel
- [`factory_self_governance.md`](factory_self_governance.md) — why factory is not self-hosted by its own pipeline; the boundary this workflow operates within
- [`single_entry_pipeline.md`](single_entry_pipeline.md) — the host-project pipeline this workflow is NOT
- [`MEMORY.md`](MEMORY.md) — the decision-doc and research index
- [`QUEUE.md`](QUEUE.md) — the active work-items queue
