---
name: Factory self-governance — factory is a tool other projects use, it does not govern its own development
description: >-
  Factory is a tool other projects use; it is not a self-hosting product. The pipeline runner (`run.ts`) is not invoked against this repo. Specs in `specs/` are implementation roadmaps for human + Claude collaborative execution, not inputs to autonomous factory runs — they're read by humans and Claude during design and implementation sessions; they don't decompose into intents → packets → autonomous execution the way host-project specs do. The canonical `factory.config.json` lives at `templates/factory.config.json` (the host-project template); the root `factory.config.json` is a non-canonical development convenience that exists because `tools/config.ts` and pre-commit hooks expect a loadable config in the working directory. The deferral of self-governance is deliberate, not a bootstrapping concession waiting for stabilization. Cleanup of the dual-config layout, and any future re-evaluation of self-governance, are deliberately out of scope. Decided 2026-04-30, re-establishing principle going forward after an earlier (now-discarded) 2026-03-22 memory note flagged the same posture during bootstrapping.
type: project
---

# Factory Self-Governance

## Decision

**Factory does not govern its own development.**

- Factory's pipeline runner (`run.ts`) is not invoked against this repo.
- Specs authored in `specs/` are implementation roadmaps for **human + Claude** execution, not inputs to autonomous factory runs.
- The canonical `factory.config.json` lives at `templates/factory.config.json` and exists to be copied into host projects.
- The root `factory.config.json` is a development convenience for tooling that requires a loadable config file. It is **not canonical** and should not be treated as a reference for what host projects should configure.

Factory is a **tool** other projects use. It is not a self-hosting product.

## Context

This posture has been implicit since the pipeline-redesign in commit `5a6df82`, but never explicitly recorded. An earlier (now discarded) memory note from 2026-03-22 stated:

> "Factory is in active bootstrapping. Do not use factory to govern factory changes yet. Once tooling stabilizes and the first real project has exercised it end-to-end, revisit self-governance."

That note was discarded under the "move forward, not retroactively" rule when the memory convention was reset. This decision re-establishes the principle going forward, with a key clarification: the deferral is deliberate, not just a bootstrapping concession.

The clarification surfaced during work on the [`single_entry_pipeline`](single_entry_pipeline.md) decision and its companion implementation spec. Without an explicit principle, the specs/ directory ambiguously implies factory might autonomously process its own specs via `run.ts <spec-id>`. That's not the intent. The specs document the work; humans and Claude collaborate to land it.

## What this means concretely

### Factory development workflow

- Specs in `specs/` are read by humans and by Claude as design input
- Implementation work proceeds through ordinary git commits, code review, and human-in-the-loop verification
- The lifecycle scripts (`start.ts`, `request-review.ts`, `review.ts`, `complete.ts`) are not part of the factory development workflow — they're an artifact of factory's *product surface*, not its *development process*
- Tests run via `npm test` / `vitest`; the pipeline runner is not in the loop

### Configuration layout

- `templates/factory.config.json` — **canonical**. The reference for what a host project's config should look like. Updated when the config schema or recommended values change.
- `factory.config.json` (root) — **non-canonical**. Exists because `tools/config.ts` and pre-commit hooks expect a loadable config in the working directory. Not authoritative for any decision; not a template; not a "best practice" example.
- `schemas/factory-config.schema.json` — schema authority. Both files validate against it; that's the integrity check.

This layout is suboptimal — having two `factory.config.json` files invites confusion. A future cleanup may reorganize this, but **that cleanup is deferred** (see below).

### Specs in this repo

Specs in `specs/` are written for the **same audience that reads `docs/decisions/`** — humans and Claude collaborating on factory development. They differ from host-project specs in two ways:

- **Audience.** Host-project specs are read by factory's planner agent. Factory's own specs are read by humans and Claude during this kind of session.
- **Execution.** Host-project specs decompose into intents → packets → autonomous execution. Factory's own specs decompose into ordinary commits and reviews.

The frontmatter format and the file location are the same. The semantics of "what happens when this spec is invoked" differ.

## What this does NOT decide

The following are deliberately **deferred**:

- **Whether to delete or rename the root `factory.config.json`.** Three plausible options exist (delete, rename to `factory.dev.config.json`, leave as-is). All are out of scope here. Revisit when factory tooling stabilizes against host projects.
- **When self-governance becomes appropriate.** The earlier bootstrapping note suggested "after the first real project has exercised it end-to-end." That trigger is fine but not committed. This decision is open-ended on the timeline.
- **Whether factory's own specs should follow a different schema** (e.g., a "manual" spec without `depends_on`). The current spec schema is general enough to serve both audiences; a divergence may be needed later but not now.
- **Tooling test fixtures.** If we did delete the root `factory.config.json`, tests that load a config would need fixtures. That's an implementation question, not architectural; defer until the deletion question is taken up.

## Implications for existing artifacts

- [`single_entry_pipeline`](single_entry_pipeline.md) — the architectural decision stands as written; the implementation spec ([`specs/single-entry-pipeline.md`](../../specs/single-entry-pipeline.md)) is implemented manually, not autonomously. No change required.
- [`spec_artifact_model`](spec_artifact_model.md) — the spec schema applies to host projects' specs and to factory's own specs equally. No change required.
- [`memory_scope_split`](memory_scope_split.md) — applies to factory and to host projects identically. No change required.

## References

- [`memory_scope_split.md`](memory_scope_split.md) — established the project-scope-vs-worker-scope distinction this decision operates within
- [`spec_artifact_model.md`](spec_artifact_model.md) — defined the spec convention this decision clarifies
- [`single_entry_pipeline.md`](single_entry_pipeline.md) — the pipeline architecture this decision says we don't run *on factory itself*
- [`../../specs/single-entry-pipeline.md`](../../specs/single-entry-pipeline.md) — the first spec, implemented manually under this principle
