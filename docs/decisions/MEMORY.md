# Memory Index

- [factory_self_governance.md](factory_self_governance.md) — Factory does not govern its own development. The pipeline runner (run.ts) is not invoked against this repo; specs are implementation roadmaps for human+Claude execution. The canonical config is templates/factory.config.json; the root factory.config.json is a non-canonical development convenience.
- [memory_scope_split.md](memory_scope_split.md) — Memory in factory operates at two scopes: per-packet workers stay stateless; the project carries learned memory across runs.
- [spec_artifact_model.md](spec_artifact_model.md) — Specs are new human-authored markdown artifacts at a higher level than intents. Factory translates each spec into exactly one intent (1:1 parity).
- [single_entry_pipeline.md](single_entry_pipeline.md) — Factory has one entry point — run.ts — accepting one or more spec IDs. Four-layer architecture (driver/phases/lifecycle/recovery), CLI-as-agent-protocol, sequential dependency-aware first. Recovery: 8 scenarios, two-layer provider failover (cross-CLI + within-CLI for abstraction providers); LintFailed and TestFailed always escalate.
