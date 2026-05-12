---
name: Verification grading deferred — binary build/lint/test through Phase 8, no Green Contract tiers
description: >-
  Factory does not adopt claw-code's "Green Contract" graded verification (the `TargetedTests` / `Package` / `Workspace` / `MergeReady` ordered tier model where each packet specifies a required level and higher tiers stack to satisfy lower-tier requirements) in `specs/single-entry-pipeline.md` or its sister specs through Phase 8. Verification stays binary: build, lint, and test each pass or fail; a packet is complete only when all three pass. The current model is over-rigorous (every packet runs every check), not under-rigorous — the cost is wasted CI time, not shipped bugs. Graded verification is high-value but not load-bearing for correctness; the right tier vocabulary depends on host-project tooling shape (pnpm/npm, dotnet, custom build scripts) and factory doesn't yet have enough host-project diversity to design that vocabulary well. Adding it later is additive (optional `required_verification_level` field on packet schema; `complete.ts` learns to evaluate against the level; no data migration). Revisit as a future spec post-Phase 8, evaluated against accumulated host-project experience and likely composed with cost visibility (verification cost proportional to change size). Decided 2026-05-01; informed by [claw_code_audit.md](../research/claw_code_audit.md) §7.
type: project
---

# Verification Grading — Deferred

## Decision

Factory does **not** adopt graded verification (claw-code's "Green Contract" pattern) in the `single-entry-pipeline` spec or its sister specs through Phase 8. Verification remains binary: build, lint, and test each pass or fail; a packet is complete only when all three pass.

Graded verification is **explicitly deferred**, not silently omitted. Revisit after Phase 8.

## Context

claw-code's `green_contract.rs` defines four ordered verification tiers:
- `TargetedTests` — minimal, fastest
- `Package` — package-scope tests
- `Workspace` — full workspace test pass
- `MergeReady` — workspace + integration

Each task packet specifies a required level. A small refactor needs only `TargetedTests`; an architectural change needs `MergeReady`. The contract evaluator stacks (a higher tier satisfies a lower-tier requirement).

Reference: [`research/claw_code_audit.md`](../research/claw_code_audit.md) §7.

The pattern is high-value:
- Cuts wasteful verification time on small changes (currently every packet runs the full `pnpm test` regardless of scope)
- Makes verification cost proportional to change size — composes well with cost visibility
- Surfaces "this packet wasn't verified at MergeReady; do not merge to main yet" as a structured signal

## Why deferred

Three reasons, in order:

1. **Not load-bearing for correctness.** Today's binary verification is *over*-rigorous. Every packet runs every check. The cost is wasted CI time, not shipped bugs. A pipeline that completes today is correctly verified; we just paid for verification we may not have needed.

2. **The architecture isn't yet mature enough to know the right tiers.** claw-code's tiers are shaped by their workspace tooling (Cargo workspace + crate). Factory's host projects use different tooling (pnpm/npm, dotnet, custom build scripts, etc.). The right tier vocabulary depends on host-project shape; we don't have enough host-project diversity yet to design it well.

3. **It's additive over the existing model.** Adding graded verification later does not require redesigning the artifact schema or the lifecycle scripts. The packet schema gains an optional `required_verification_level` field; `complete.ts` learns to evaluate against the level. No existing data migrates.

## What this decides

1. **Verification stays binary** through `specs/single-entry-pipeline.md` Phase 8.
2. **The deferral is explicit** — this decision exists so the choice is documented rather than implicit.
3. **Revisit trigger:** a future spec, post-Phase 8, evaluates graded verification against accumulated host-project experience.

## What this does NOT decide

- **Whether graded verification is right for factory long-term.** Likely yes; the pattern is sound. The question is when, not whether.
- **The specific tier model factory would adopt.** claw-code's four-tier model is the obvious starting point; factory's tier names may differ.
- **Whether some packets could opt into faster verification today** without a full grading system. A simpler intermediate (e.g., `verification_skip: ["lint"]` per packet) could exist; out of scope for this decision.

## References

- [`research/claw_code_audit.md`](../research/claw_code_audit.md) §7 — Green Contract pattern
- [`single_entry_pipeline.md`](single_entry_pipeline.md) — verification model this decision preserves
- [`cost_visibility.md`](cost_visibility.md) — graded verification compounds with cost visibility; revisit together
