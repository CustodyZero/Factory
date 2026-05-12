---
name: Doctor diagnostic deferred — no unified preflight command until after Phase 8
description: Factory does not add claw-code's `claw doctor` unified-preflight equivalent in `specs/single-entry-pipeline.md` or its sister specs through Phase 8. Health-checking remains fragmented across `tools/status.ts` (factory state), `tools/validate.ts` (schema and integrity), manual provider checks, and the pre-commit completion-gate hook. A unified `factory doctor` command is high-value for operator UX but not on the architectural critical path — its lack costs setup friction, not correctness. Better designed late, once Phases 5-8 surface the full set of checks worth running (multi-spec sequencing, recovery state, cost-cap status, event stream health, worktree state). Revisit as a sister spec post-Phase 8. The decision exists to surface the deferral rather than leave it as a silent omission. Decided 2026-05-01; informed by [claw_code_audit.md](../research/claw_code_audit.md) §10.
type: project
---

# Doctor Diagnostic — Deferred

## Decision

Factory does **not** add a unified preflight diagnostic command (claw-code's `doctor` pattern) in the `single-entry-pipeline` spec or its sister specs through Phase 8. Health-checking remains fragmented across `status.ts`, `validate.ts`, and manual provider checks.

A unified `factory doctor` command is **explicitly deferred**, not silently omitted. Revisit as a sister spec after Phase 8.

## Context

claw-code's `claw doctor` is a single-command preflight diagnostic. From their `USAGE.md`:

> "Run this before prompts, sessions, or automation. Once you have a saved session, you can rerun it with `./target/debug/claw --resume latest /doctor`."

It checks: provider availability, MCP servers, git state, config validity, sandbox setup, version, and more. Output is human-readable by default and `--output-format json` for scripting.

Reference: [`research/claw_code_audit.md`](../research/claw_code_audit.md) §10.

Factory today has the same checks scattered:
- `tools/status.ts` — factory state (intents/packets/completions)
- `tools/validate.ts` — schema and integrity
- Provider availability — manual; agents discover failures at invocation time
- Config validity — partial; `loadConfig` errors but doesn't validate end-to-end
- Git state — implicit in completion-gate hook, not exposed
- Worktree state — not surfaced

## Why deferred

1. **Operator UX, not correctness.** A new operator running factory in a host project benefits from `factory doctor` — clear "this thing is configured right" signal in one command. But the lack of `doctor` doesn't ship bugs; it costs the operator some setup friction.

2. **Better designed late.** `doctor`'s value comes from comprehensive coverage: every health check the operator might want, in one place. Designing it before we know the full set of health concerns risks missing some and adding others we'll regret. Phases 5-8 will surface checks we don't know we need yet (multi-spec sequencing, recovery state, cost cap status, event stream health). Better to gather those naturally and consolidate in a final pass.

3. **Cheap to build later.** Once the architecture is in place, `doctor` is mostly an integration of existing checks. New tool, ~200 lines, calls the existing health-check logic from each subsystem. Not blocked by anything in Phases 5-8.

## What this decides

1. **No unified preflight command** in `specs/single-entry-pipeline.md` Phase 8 or earlier.
2. **The deferral is explicit** — this decision exists so the choice is documented.
3. **Revisit trigger:** a sister spec post-Phase 8, after the architecture has surfaced the full set of checks worth running.

## What this does NOT decide

- **Whether `factory doctor` is right.** Likely yes; the operator-UX value is real.
- **The specific check list.** Will be richer than today's (provider availability, cost cap status, event stream health, worktree state, etc.); designed in the future spec against accumulated needs.
- **Whether to incrementally improve the existing checks before the consolidated tool lands.** Out of scope here.

## References

- [`research/claw_code_audit.md`](../research/claw_code_audit.md) §10 — Doctor / preflight pattern
- [`single_entry_pipeline.md`](single_entry_pipeline.md) — the architecture work this decision sets aside
- [`event_observability.md`](event_observability.md) — events produced during pipeline runs are a future input to `doctor`'s "is the event stream healthy" check
