---
name: factory-reviewer-cli-exception
description: The reviewer agent uses the `review.ts` lifecycle CLI to record its verdict (`--approve` / `--request-changes`). Other phase agents (planner, developer, QA) do NOT invoke lifecycle CLIs — the pipeline drives those transitions. The reviewer is the deliberate exception because its verdict IS a structured output the pipeline must consume reliably, and CLI-as-protocol was designed to avoid LLM structured-output parsing. The exception is kept honest by the `ReviewDecisionMissing` recovery scenario, which fails the packet (no silent force-approve) when the reviewer exits 0 without invoking `review.ts`.
type: project
---

# Reviewer CLI Exception

## Decision

The code-reviewer agent invokes `review.ts --approve` or `review.ts --request-changes` as the protocol channel for its verdict. This is the **deliberate exception** to the autonomous-pipeline-manages-lifecycle rule that governs every other phase prompt (planner, developer, rework, QA).

## Context

[`single_entry_pipeline.md`](single_entry_pipeline.md) established **CLI-as-agent-protocol**: lifecycle scripts are the channel through which agents signal state back to the orchestrator, on the grounds that

> "LLMs are unreliable at structured output. Asking agents to return JSON imposes a parser-correctness burden on the agent and a parsing-correctness burden on the orchestrator."

The convergence pass that followed Phase 8 reframed the dev/rework/QA prompts to instruct the agent *"do not call request-review.ts or complete.ts yourself"* (the literal phrasing in `buildDevPrompt`, `buildReworkPrompt`, and `buildQaPrompt`). The pipeline drives those transitions itself once the agent process exits. That move is sound for those phases: the orchestrator already knows when the developer's code is ready to review (the agent process exited), when rework is done (same), and when QA has run (same). The transition is mechanical; no LLM structured output is required to drive it.

The reviewer is different. The reviewer's output is **itself** a structured verdict — approve or request-changes — that the pipeline must consume reliably to decide whether to advance the packet to `complete` or loop back to `rework`. There is no mechanical way to derive that verdict from agent exit status; the verdict lives in the model's judgement about the code.

That makes the reviewer's verdict exactly the kind of structured-output problem CLI-as-protocol was designed to solve. Asking the reviewer to invoke `review.ts --approve` / `--request-changes` keeps the verdict on the same boundary every other agent-to-factory signal already crosses. The convergence pass surfaced the question explicitly and chose to keep the exception, rather than collapse it into stdout parsing.

This decision records that choice so future contributors don't read the dev/rework/QA prompts ("do not call lifecycle CLIs"), notice the reviewer prompt is different, and "fix" the inconsistency.

## What this decides

1. **The reviewer prompt names `review.ts` as the verdict channel.** `buildReviewPrompt` in `tools/pipeline/prompts.ts` includes the literal instructions for both `--approve` and `--request-changes`. This is load-bearing and is called out in a comment on the prompt builder.

2. **The pipeline routes the reviewer's CLI invocation through `recordReview(...)`.** The reviewer's call to `review.ts` is what causes the packet to transition to `review_approved` or `changes_requested` on disk; the develop-phase closure then reads that status and branches.

3. **No silent fallback.** If the reviewer agent exits 0 without invoking `review.ts`, the develop-phase closure detects that the packet is still in `review_requested` state, synthesizes a `ReviewDecisionMissing` failure with the marker string, and routes it through the recovery layer. The recovery recipe escalates immediately (budget 0). The packet fails. This safety net is what makes the exception honest — without it, the exception would silently force-approve when the agent ignored the protocol.

## What this does NOT decide

- **Whether all phases should eventually use CLI-as-verdict-channel for structured outputs.** Today the reviewer is the only persona whose phase output is a structured verdict. The planner writes a feature artifact (filesystem signal). The developer writes code (filesystem signal). The QA agent produces a completion (lifecycle script, but for the completion record itself, not a verdict about it). If a future phase grows a structured verdict shape, this decision establishes the precedent — but does not pre-commit to it.

- **Whether `review.ts` should be extended to capture richer verdict shapes** (per-file approve/reject, severity-tagged comments, etc.). Out of scope. The current binary verdict is what the pipeline consumes today.

- **The exact wording of the reviewer prompt.** That lives in `tools/pipeline/prompts.ts:buildReviewPrompt` and may iterate without re-opening this decision.

- **The reviewer persona's provider, model, or instructions list.** Configured per project in `factory.config.json`; orthogonal to the protocol channel.

## Alternatives considered

**(a) Stdout parsing of reviewer output for the verdict.** Rejected. This inherits the exact structured-output fragility CLI-as-protocol was designed to prevent. The LLM may emit the verdict marker inside a code block, inside a quoted explanation, inside a paragraph hedging the verdict, or with stray formatting. Building a regex / sentinel parser puts a parser-correctness burden on the orchestrator and a structured-output burden on the agent — both of which the parent decision rejected for the same reason in every other lifecycle transition.

**(b) Dedicated callback (e.g., reviewer writes a verdict file the pipeline polls).** Rejected. This introduces a new protocol surface for one persona. The lifecycle CLI surface already exists, is well-understood, is exercised by tests, and is documented in `AGENTS.md` as the agent protocol. Reusing it costs less than inventing a parallel mechanism — and an additional protocol surface used by exactly one caller would be a worse exception than the one we're documenting.

**(c) Eliminating the reviewer phase entirely.** Rejected. Code review is a load-bearing quality gate. It exists to catch issues the developer agent did not catch and to keep automated code generation honest. Removing it would solve the protocol-channel question by removing the thing that needs a channel; it would also remove a gate the factory's quality story depends on.

## Integrity protection

The `ReviewDecisionMissing` failure scenario (`tools/pipeline/recovery.ts`) is what allows this exception to be a documented architectural choice rather than a facade. The relevant pieces:

- `REVIEW_DECISION_MISSING_MARKER` is an exported string constant. The develop-phase review closure synthesizes a failure context carrying this marker when the reviewer exits 0 without recording a verdict (`tools/pipeline/develop_phase.ts`, the post-review status check).
- The classifier matches the marker by exact substring (not heuristic) and dispatches to the `ReviewDecisionMissing` scenario.
- The recipe is `escalate` with budget 0. There is no retry; the prompt was clear and the agent ignored it. The escalation record names the packet and points at the run logs.

Without that path, the develop-phase closure would have only two honest options: silently force-approve (the previous behavior, removed by the convergence pass on CLAUDE.md §3.1 grounds), or hard-crash the pipeline. The recovery scenario gives it a third: route the failure through the same escalation surface every other unrecoverable scenario uses, with a specific diagnostic. The exception in the prompt and the failure path in recovery are coupled; the architectural choice is honest only as long as both exist.

## References

- [`single_entry_pipeline.md`](single_entry_pipeline.md) — the CLI-as-agent-protocol parent decision and the lifecycle-script catalog
- [`tools/pipeline/prompts.ts`](../../tools/pipeline/prompts.ts) — `buildReviewPrompt` carries the `review.ts --approve` / `--request-changes` instructions
- [`tools/pipeline/develop_phase.ts`](../../tools/pipeline/develop_phase.ts) — the post-review status check that synthesizes the `ReviewDecisionMissing` marker on no-decision
- [`tools/pipeline/recovery.ts`](../../tools/pipeline/recovery.ts) — `ReviewDecisionMissing` scenario, classifier branch, and escalate-only recipe
