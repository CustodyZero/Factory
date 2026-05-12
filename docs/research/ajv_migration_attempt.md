---
name: The ajv migration that wasn't — Phase 4.6 bounded-iteration revert lesson
description: Bounded-iteration revert lesson recorded 2026-05-01. Phase 4.6 of `specs/single-entry-pipeline.md` was originally scoped as a pure-refactor migration of four hand-rolled artifact validators in `tools/validate.ts` (785 lines, the largest file in `tools/`) to ajv consuming the existing `schemas/*.schema.json` files. After three rounds of codex GPT-5.5 review, the verdict was RECOMMEND-REVERT: ajv enforced full-schema strictness the old validators ignored (`additionalProperties: false`, optional field constraints, `oneOf` mutex semantics), and successive lax-mode filters and drop-rule mini-DSLs fixed regressions but failed to reduce complexity — 785 lines became 1,396 across three files plus the new ajv dependency plus 46 regression-pinning tests. The lesson: when migrating a hand-rolled validator to a schema-driven engine, first verify the hand-rolled validator was actually doing schema-driven validation; if it's doing semantic checks dressed up as schema validation (here: `verifies` × `kind` constraints, spec-vs-spec_path mutex with non-empty-string semantics, conditional required-fields), the migration adds layers without removing complexity. What shipped instead (Phase 4.6 revised, commit `192e971`): integrity-layer extraction to `tools/pipeline/integrity.ts` (467 lines), `validate.ts` shrunk 785 → 423 lines, 29 compatibility tests pinning existing hand-rolled behavior, no ajv, no new dependencies. The compatibility tests are the most valuable artifact: any future schema-driven migration attempt has a deterministic safety net. First case where the bounded-iteration model surfaced an architectural error in the brief itself, not in the implementation. Original branch `worktree-agent-aa2a30d634d859b5c` was force-deleted post-revert.
type: lesson
---

# Research Note — The ajv Migration That Wasn't

**Date:** 2026-05-01
**Context:** Phase 4.6 of `specs/single-entry-pipeline.md` — originally an ajv migration; ultimately shipped as integrity-layer extraction only.
**Status:** Lesson learned, recorded for future architectural calls.

---

## What we tried

After Phase 4.5, an architecture audit identified `tools/validate.ts` at 785 lines as the largest single file in `tools/`, having grown organically as new artifact types were added (each adding a new hand-rolled validator). The previously-deferred recommendation to migrate to `ajv` was raised and accepted.

Phase 4.6 was scoped as a pure-refactor migration:

- Replace four hand-rolled artifact validators (`validatePacketSchema`, `validateCompletionSchema`, `validateFeatureSchema`, `validateIntentSchema`) plus the spec frontmatter validator with `ajv` consuming the existing `schemas/*.schema.json` files.
- Preserve cross-cutting integrity validations (FI-1, FI-7, FI-9, spec dependency cycles, etc.) as hand-rolled logic.
- Preserve error-message shape and ordering.
- Target: validate.ts under 400 lines.

A separate Opus developer implemented this brief.

## What went wrong

Three rounds of codex GPT-5.5 review surfaced increasingly deep behavioral regressions:

**Round 1 — REQUEST-CHANGES.** ajv enforces the FULL schemas, including:
- `additionalProperties: false` on all artifact schemas — old hand-rolled validators ignored unknown fields
- Optional field type/shape constraints — old validators only checked types on REQUIRED fields
- The schema's `oneOf` mutex on intent's `spec` vs `spec_path` — old validator used "non-empty string presence" semantics

Inputs that previously passed under the old validators now failed under ajv.

**Round 2 — REQUEST-CHANGES.** Round 1's "lax-mode filter" (drop ajv errors that the old validator wouldn't have produced) was too coarse. Codex found six additional regressions:
- Packet `verifies` × kind constraint dropped (QA must have verifies; dev must not)
- Required-error overreach on optional containers (e.g., `planned_by: {}` now failed)
- Intent `spec`/`spec_path` semantic mismatch
- Stricter-than-old item validation on feature `acceptance_criteria`, intent `constraints`
- Packet `change_class` newly required (old was lax)

**Round 3 — RECOMMEND-REVERT.** Round 2's hand-rolled drop-rules mini-DSL fixed all six specific regressions, but the architectural verdict was unambiguous:

> "The migration did not reduce complexity. It turned a 785-line hand validator into 1,396 lines across schema validation, integrity extraction, and retained hand-rolled semantic checks. The hard part was not JSON Schema validation; it was preserving intentionally lax, semantic, historical behavior. Ajv now sits in the middle, but much of its stricter value is suppressed by a custom drop-rule mini-DSL."

Comparison at the rejection point:

| | Pre-Phase-4.6 (main) | Post-round-3 (rejected) |
|--|---|---|
| Total validation code | 785 lines (one file) | 1,396 lines (three files) |
| External dependencies | None | + ajv |
| Custom mini-DSL | None | drop-rules config layer |
| Tests pinning behavior | None | 46 added tests |
| Verdict | — | RECOMMEND-REVERT |

## What we shipped instead

Codex's recommendation was followed. The original branch was force-deleted. A fresh Phase 4.6 (revised) implementation did only the parts that were value-additive:

- Extract the integrity layer to `tools/pipeline/integrity.ts` (467 lines)
- `tools/validate.ts` shrunk from 785 to 423 lines
- Add 29 compatibility tests pinning the EXISTING hand-rolled validators' actual behavior
- No ajv
- No new dependencies
- No schema changes

Total validation code: 785 → 890 lines split clean across two files. The integrity extraction alone delivered the architectural goal that motivated Phase 4.6 in the first place: validate.ts is no longer the fattest file in tools/.

## The lesson

**Pattern:** when migrating a hand-rolled validator to a schema-driven engine, first verify the hand-rolled validator was actually doing schema-driven validation. If it was doing semantic checks dressed up as schema validation, the migration adds layers without removing complexity.

**The specific tell here:** the hand-rolled validators and the JSON schemas were never in clean correspondence. Each schema declared more constraints than the validator enforced; the validator enforced semantic rules (verifies × kind, spec/spec_path mutex with non-empty-string semantics) that the schema didn't express well. The schemas existed but were not authoritative for validation behavior.

A clean schema-driven migration requires:
- The schemas to be authoritative (every validation rule expressible in the schema)
- The hand-rolled validators to be a shallow read of the schemas (not a divergent implementation)

If those preconditions fail, the migration is replacing one form of complexity with another, not eliminating it.

## What's preserved for the future

The compatibility tests added in Phase 4.6 (revised) are the most valuable artifact of this exercise. They pin the EXISTING hand-rolled validator behavior — including its lax behaviors — explicitly, with concrete test fixtures.

If a future attempt at schema-driven validation is considered, those tests are the safety net. They will catch any divergence the next attempt introduces, in either direction (stricter OR more permissive).

A future migration would also need to address the schemas-and-validators-not-in-correspondence problem upstream:
- Either modernize the schemas to express EVERY rule the validators enforce (and accept the validators tightening to match)
- Or accept that the hand-rolled validators are the source of truth and the schemas are documentation, not enforcement

This research note records the choice to defer that question.

## Iteration record (informational)

The original attempt's branch was `worktree-agent-aa2a30d634d859b5c`. Six commits, three review rounds, force-deleted after the recommend-revert verdict. Total developer effort: meaningful but not wasteful — the failed iteration produced the codex analysis that informed the correct shipping scope.

This is exactly the case the bounded-iteration model is designed for: three rounds of careful review revealed an architectural error in the brief itself, not in the implementation. The right move was to honor that signal rather than power through to a fourth round.

## References

- `specs/single-entry-pipeline.md` — Phase 4.6 (revised) section reflects what shipped
- `tools/pipeline/integrity.ts` — the extraction that DID land
- `tools/test/validate.test.ts` — the compatibility tests that pin current behavior
- Git history: commit `192e971` is the merge of Phase 4.6 (revised); the failed branch was deleted but the chat record of the three-round review is in this session's transcript
