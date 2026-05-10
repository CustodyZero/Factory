---
name: factory-spec-artifact-model
description: Specs are new human-authored markdown artifacts at a higher level than intents. Factory translates each spec into exactly one intent (1:1 parity); the intent remains the locked schema and the planner's input. The spec is the human authoring surface.
type: project
---

# Spec Artifact Model

## Decision

The factory adds a new artifact type — **spec** — at a higher level than the existing intent.

- **Specs are human-authored.** They live as markdown files. One file per spec.
- **Specs map 1:1 to intents.** Each spec produces exactly one intent. The intent remains the locked schema and the planner's input. Nothing about the intent shape changes.
- **Factory translates spec → intent.** Translation happens at run time inside the pipeline runner. There is no separate "import" command and no mid-state where a spec exists without its intent.
- **Specs are the only input humans hand the factory.** `run.ts <spec-id> [<spec-id>...]` is the sole entry point.

The intent artifact remains unchanged in shape, location, and role. This decision adds the spec layer above it; it does not modify the existing layer.

## Context

This decision came out of a design conversation about minimizing human interaction with factory and unifying the entry point. Two readings of "spec" were on the table:

- **Reading A:** spec ID = intent ID, no new artifact. Just renaming.
- **Reading B:** spec is a new higher-level artifact, human-authored, that factory translates into the locked intent schema.

Reading B was chosen. It mirrors the stationzero/valet pattern of human-authored markdown decisions plus generated downstream artifacts, gives humans a more natural authoring surface (markdown with frontmatter), and keeps the intent schema as the *machine-locked contract* between human direction and factory execution.

Reference: chat decision recorded 2026-04-30; supporting research in [`research/factory_script_audit.md`](../research/factory_script_audit.md).

## Spec file model

### Location

```
specs/
└── <spec-id>.md
```

At the project root, alongside `factory.config.json`. Specs are tracked in git as the source of truth for what the project intends to build.

The directory name `specs/` is intentionally distinct from `docs/specs/` (where some host projects already keep markdown specs referenced via `intents/<id>.json` `spec_path`). This avoids ambiguity: `specs/` is the factory-managed directory; `docs/specs/` (if present) is project documentation.

### File format

A spec is a markdown file with YAML frontmatter:

```markdown
---
id: <spec-id>
title: <one-line title>
depends_on: [<spec-id>, ...]   # optional; default empty
---

# <free-form markdown body — the actual spec text>

The body is the authoritative content. It is what the planner reads.
The frontmatter exists only to give factory the metadata it needs
to sequence work.
```

### Frontmatter schema

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `id` | string | yes | Stable identifier; matches the filename (`specs/<id>.md`) |
| `title` | string | yes | One-line summary used in status output and audit logs |
| `depends_on` | array of strings | no, default `[]` | Other spec IDs that must complete before this spec runs |

Frontmatter is intentionally minimal. Anything else humans want to track about a spec (priority, owner, target release, links) goes in the markdown body or in human-managed tooling — *not* in the spec frontmatter. Factory does not consume those fields.

### Dependencies

`depends_on` is the only sequencing primitive. It declares spec-level ordering:

- If spec `A` declares `depends_on: [B]`, factory will not start `A` until `B` completes successfully (all packets in B's intent reach `completed`).
- If `B` fails, `A` is blocked and reported as such.
- Cyclic dependencies are rejected at validation time (FI-9 analog at the spec level).

`depends_on` is the spec analog of packet `dependencies`. The two operate at different layers and do not interact: packet dependencies sequence work *within* a spec's intent; spec dependencies sequence specs *between* intents.

### What's NOT in the spec

- **No `status` field.** Status lives on the generated intent and downstream artifacts. The spec is human authoring; it doesn't track lifecycle.
- **No `priority` field.** Priority is a human concern outside factory.
- **No `acceptance_criteria` field.** Acceptance criteria live on packets after planning. The planner derives them from the spec body.
- **No inline body content in YAML.** All free-form content is markdown after the frontmatter.

## Spec → intent translation

When `run.ts <spec-id>` is invoked:

1. Load `specs/<spec-id>.md`. Validate frontmatter against the schema.
2. Check whether `intents/<spec-id>.json` already exists.
   - If yes: verify the existing intent points at this spec (matching `id`). If not, this is an error (spec ID and intent ID must match per 1:1 parity).
   - If no: generate it from the spec.
3. The generated intent has:
   - `id`: matches the spec ID
   - `spec_path`: relative path to `specs/<spec-id>.md` (the existing intent field)
   - `title`: from spec frontmatter
   - `depends_on`: copied from spec frontmatter (new field on intent — see below)
   - `status`: `proposed` (the existing intent default)
   - `created_by`: `{ kind: "cli", id: "factory-run" }`
   - `created_at`: timestamp
4. Write the intent to `intents/<spec-id>.json`. Validate.
5. Continue the pipeline as today (planner reads the intent, which references the spec via `spec_path`).

The intent is **derived state**. If a human deletes `intents/<spec-id>.json`, the next `run.ts` invocation regenerates it from the spec. The spec is the source of truth.

### Approval gate (spec-driven vs intent-driven)

The post-Phase-8 convergence pass introduced a runtime governance gate
on intent `status` for the backward-compat intent-driven path
(`run.ts <intent-id>`). The spec model interacts with that gate as
follows:

- **Spec-driven runs** (`run.ts <spec-id>`) bypass the gate. The
  derived intent's `status: "proposed"` is a generator-set artifact,
  NOT a human-authored governance signal. The human approval
  happened the moment the spec was written. The orchestrator
  preserves the `proposed` default to keep the spec → intent
  translation deterministic and to avoid forcing operators to flip a
  status field on a derived artifact they did not author.

- **Intent-driven runs** (`run.ts <intent-id>` against a hand-authored
  `intents/<id>.json`) DO consult the gate. The accepted statuses are
  `approved`, `planned`, and `delivered`; `proposed`, `superseded`,
  missing, and unknown values are rejected with an actionable error
  asking the operator to set `status: "approved"`. This is the only
  remaining authoring surface where `status` carries human intent —
  the operator wrote the file, so the operator has to acknowledge
  the run.

The split keeps spec-as-derived-state honest (rule 4 of "What this
decides") while restoring an explicit governance signal on the
hand-authored fallback. Without the split, either every spec-driven
run would require an extra status-flip step, OR the intent-driven
path would silently inherit the `proposed` default and never gate.

### Intent schema change required

The existing `intents/<id>.json` schema does not have a `depends_on` field. This decision adds one:

- `depends_on`: array of strings, optional, default `[]`
- Validated by `validate.ts`
- Used by the pipeline runner for spec-level sequencing

This is a **schema change** to a locked artifact. It is additive and backward-compatible (default empty), but it warrants a separate validation pass before this decision lands in implementation.

## What this decides

1. Specs are a new human-authored artifact type.
2. Specs live at `specs/<spec-id>.md` with YAML frontmatter (`id`, `title`, optional `depends_on`).
3. Specs map 1:1 to intents.
4. Factory translates spec → intent at run time; the intent is derived state.
5. The spec is the source of truth for what to build; the intent is the locked schema downstream tooling consumes.
6. The intent schema gains an optional `depends_on` field (additive, backward-compatible).

## What this does NOT decide

- **The path to `specs/` for host projects.** Same default (`specs/` at project root), but configurable via `factory.config.json` if needed. Defer until a host project requests it.
- **Spec body conventions.** Whether specs should follow a template (problem statement / acceptance / out-of-scope sections) is left to project convention. Factory does not enforce body structure.
- **Migration of existing intents.** Existing `intents/<id>.json` files without specs continue to work; running `run.ts <intent-id>` against a spec-less intent is allowed (no spec lookup if no `specs/<id>.md` exists). This is a temporary compatibility mode; a future decision may deprecate it.
- **Spec versioning.** No changelog, no version field. Git history is the changelog.

## References

- [`research/factory_script_audit.md`](../research/factory_script_audit.md) — context for the unification of entry points
- [`memory_scope_split.md`](memory_scope_split.md) — established the project-vs-worker scope split that this decision operates within (specs are project-scope authoring; intents and below are pipeline-scope state)
