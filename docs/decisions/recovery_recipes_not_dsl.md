---
name: factory-recovery-recipes-not-dsl
description: Phase 6's recovery layer uses recipes (data-driven map of FailureScenario to RecoveryRecipe) rather than a configurable policy DSL with And/Or conditions. Recipes provide data-driven recovery without the implementation cost or learning curve of a DSL. If recipes prove insufficient, a DSL can be layered on top later. This decision exists to record the design choice; not adopting claw-code's PolicyEngine wholesale is intentional, not an oversight.
type: project
---

# Recovery: Recipes, Not DSL

## Decision

Phase 6's recovery layer uses **scenario-keyed recipes** — a data-driven map from `FailureScenario` to `RecoveryRecipe`. It does not use claw-code's `PolicyEngine`-style DSL with composable `And`/`Or` conditions over a `LaneContext`.

This is a design choice, not an oversight. Recipes are simpler, equally data-driven for the cases factory needs to handle, and don't require operators to learn a small DSL.

## Context

claw-code's `runtime/src/policy_engine.rs`:

```rust
pub struct PolicyRule {
    pub name: String,
    pub condition: PolicyCondition,
    pub action: PolicyAction,
    pub priority: u32,
}

pub enum PolicyCondition {
    And(Vec<PolicyCondition>),
    Or(Vec<PolicyCondition>),
    GreenAt { level: GreenLevel },
    StaleBranch,
    StartupBlocked,
    LaneCompleted,
    LaneReconciled,
    ReviewPassed,
    ScopedDiff,
    TimedOut { duration: Duration },
}
```

Rules are evaluated against a `LaneContext`. Operators declare rules in config; the engine matches and dispatches actions.

Reference: [`research/claw_code_audit.md`](../research/claw_code_audit.md) §8.

`specs/single-entry-pipeline.md` Phase 6 specifies recipes:

```typescript
type RecoveryRecipe = (
  scenario: FailureScenario,
  context: FailureContext,
) => RecoveryAttempt | EscalateRequest;
```

Each recipe is a TypeScript function. Eight scenarios, eight recipes. Five auto-recoverable, three escalate-only.

## Why recipes, not DSL

1. **The factory's failure modes are small and well-defined.** Phase 6's eight scenarios cover the catalog. A DSL with `And`/`Or` composition is overkill for "if scenario is BuildFailed, retry once with guardrail prompt." Recipes express that directly.

2. **Recipes are still data-driven.** Recovery behavior lives in `tools/pipeline/recovery.ts` as a constant map. Adding a recovery scenario means adding an enum variant and a recipe entry — same shape as adding a lifecycle script. No DSL parser to maintain.

3. **Operators don't need to learn a DSL.** Factory's host-project operators are humans authoring specs and reading output. Asking them to also learn `condition: And(GreenAt(Workspace), Not(StaleBranch))` adds cognitive load without proportional return. A recipe is just code; if an operator wants different recovery behavior, they edit the recipe.

4. **Composition can come later.** If recovery becomes complex enough that recipes start sprouting `if` chains, a DSL can be layered on top — recipes can call into a condition-evaluation library if useful. The initial commitment is the simpler form.

5. **claw-code's DSL exists because lanes are concurrent and policies cross lanes.** Factory's pipeline is sequential through Phase 5+. Cross-lane policy composition isn't a problem we have. When parallelism arrives (deferred in `single_entry_pipeline.md`), revisit.

## What this decides

1. **Phase 6 ships with recipes, not a policy DSL.** The implementation in `tools/pipeline/recovery.ts` is a function map keyed by `FailureScenario`.
2. **Recipes are TypeScript, not config.** No parsing layer; no schema for "recovery rules."
3. **The choice is intentional.** Future contributors should not see Phase 6 and ask "why isn't this a policy engine?" without finding this decision.

## What this does NOT decide

- **Whether a DSL might be added later.** If factory grows to multi-tenant, multi-host, or multi-runtime where operators want shared declarative policies, revisit. Adding DSL on top of recipes is mechanical.
- **The specific recipe shape.** The Phase 6 implementation may iterate on the function signature — `(scenario, context) → RecoveryAttempt | EscalateRequest` is the starting point.
- **Whether recipes should be configurable per host project.** Today the recipes ship as factory's defaults; host-project overrides are out of scope for Phase 6.

## References

- [`research/claw_code_audit.md`](../research/claw_code_audit.md) §8 — claw-code's policy engine
- [`single_entry_pipeline.md`](single_entry_pipeline.md) — Phase 6 recovery layer
- [`event_observability.md`](event_observability.md) — events are the substrate recipes match on; the cleaner the event taxonomy, the simpler recipes can be
