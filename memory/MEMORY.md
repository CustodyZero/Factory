---
name: Host-project memory index
description: >-
  Small always-loaded index for durable host-project memory. Keep this concise.
  Link out to category files instead of turning this file into a dump.
type: project
---

# Host Project Memory

Use this file as the entry point for durable project memory. Keep it short.
The pipeline may load this file automatically; detailed notes belong in the
category directories next to it.

## Categories

- `architectural-facts/` — durable facts about architecture, boundaries, invariants
- `recurring-failures/` — repeated failure shapes worth surfacing to future runs
- `project-conventions/` — stable team or repo conventions the factory should respect
- `code-patterns/` — reusable local patterns, component idioms, integration shapes
- `suggestions/` — candidate updates surfaced by the pipeline; not authoritative until reviewed

## Load Guidance

- Keep this file under 200 lines.
- Prefer links and short summaries over long prose.
- Do not restate current packet/feature state here.
- Promote from `suggestions/` into durable categories only after human review.

## Current Notes

<!-- Add short bullets and links to category files here. -->
