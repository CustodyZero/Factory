# Agent Operating Instructions

This file defines how all contributors — AI agents and humans — must operate
in this repository. It is the complete operational reference for the factory
pipeline. AI agents must follow it as hard constraints; humans should treat
it as the authoritative process reference.

---

## 1. The Factory Controls All Work

No code changes happen outside the factory's packet system. Every implementation
must trace back to a packet. Every packet must trace back to a feature. Every
feature must trace back to an intent that a human approved.

**Session reconstruction:** run `npx tsx .factory/tools/status.ts` at the start
of every session.

## 2. Pipeline Lifecycle

```
Spec (human authors specs/<spec-id>.md)
  |
  v
run.ts <spec-id> [<spec-id>...]   <-- the only operator entry point
  |-- Plan: planner decomposes spec into feature + dev/qa packet pairs
  |-- Develop: for each dev packet
  |     |-- Developer agent implements
  |     |-- Code reviewer agent reviews (different identity)
  |     |-- Feedback loop if needed
  |     |-- Completion recorded
  |-- Verify: for each QA packet
  |     |-- QA agent verifies (different identity from dev)
  |     |-- Completion recorded
  |-- Done: feature marked complete
```

The factory translates `specs/<spec-id>.md` into `factory/intents/<spec-id>.json`
(1:1) at run time. Operators author specs; the intent is derived state.
Existing hand-authored intents continue to work (backward compatibility).

**Human gates:** exactly one — authoring the spec. The intent artifact is
derived. Hand-authored intents remain a supported back-compat path; for
those, `intent.status` IS the gate (must be `approved` before `run.ts`
will plan them).

Each story in a feature decomposes into a **dev packet** and a **QA packet**:

- **Dev packet** (`kind: "dev"`): implements the change
- **QA packet** (`kind: "qa"`): verifies the dev packet's acceptance criteria were met

QA packets reference their dev counterpart via the `verifies` field and depend on
the dev packet (listed in `dependencies`). This means QA is sequenced automatically:
the factory will not assign a QA packet until its dev packet is complete.

### Packet Lifecycle Status

Packets carry an explicit `status` field that tracks lifecycle progression:

```
Dev packets:  draft → ready → implementing → review_requested → changes_requested → review_approved → completed
QA packets:   draft → ready → implementing → completed
```

`start.ts` sets status to `implementing`; `complete.ts` sets status to `completed`.
Review states (`review_requested`, `changes_requested`, `review_approved`) apply only
to dev packets and are managed by the code review lifecycle.
Legacy packets with `null` status are grandfathered — their state is derived from
`started_at` and completion records.

### Persona Assignment

The planner sits above execution:
- Intent artifacts → `planner`
- Dev packets → `developer` (implementation) and `code_reviewer` (review)
- QA packets → `qa`

Execute.ts returns each ready packet with a **persona** and a **model**:
- Dev packets → `developer` persona
- QA packets → `qa` persona

The pipeline runner (`run.ts`) invokes the planner, developer, code_reviewer, or qa agent
using the persona and model the factory specifies.
**FI-7**: A QA packet must not be completed by the same identity that completed its dev counterpart.

### Model Selection

Execute.ts resolves the model tier for each packet using a fallback chain:
1. **Packet-level `model`** — overrides everything (set in the packet JSON)
2. **Persona-level `model`** — default for that persona (set in `factory.config.json`)
3. **Hardcoded default** — `"high"` if nothing is configured

Default persona models:
- `developer`: `"high"`
- `code_reviewer`: `"medium"`
- `qa`: `"medium"`

Model tiers are provider-neutral (`high` / `medium` / `low`). Each provider
maps tiers to its own concrete model IDs via `pipeline.providers.<name>.model_map`
in `factory.config.json`.

Suggested override convention by change class (not enforced in code):

| Change class | Dev | QA |
|---|---|---|
| architectural | high | high |
| cross-cutting | high | medium |
| local | medium | medium |
| trivial | medium | low |

Use packet-level `model` to escalate or downgrade specific packets (e.g., escalate an
architectural QA packet to `high`, or downgrade a trivial dev packet to `medium`).

### Artifacts

Artifacts live under the `factory/` directory at the project root.
The `.factory/` submodule contains only tooling (tools, schemas, hooks).

| Directory | Purpose |
|---|---|
| `factory/intents/` | High-level specs for planner decomposition |
| `factory/features/` | Planned execution units (multi-packet) |
| `factory/packets/` | Individual work units (dev and qa) |
| `factory/completions/` | Verification evidence (build/lint/test results) |

### Operator commands

The single human entry point. Operators run only these.

| Command | When to Use |
|---|---|
| `npx tsx .factory/tools/status.ts` | Start of session, after context loss, when unsure what to do |
| `npx tsx .factory/tools/run.ts <spec-id> [<spec-id>...]` | Run the full pipeline for one or more specs (plan → develop → review → verify) |
| `npx tsx .factory/tools/validate.ts` | Verify factory integrity |

`run.ts` also accepts intent IDs (`factory/intents/<intent-id>.json`) for
backward compatibility with hand-authored intents.

### Agent protocol (CLI-as-protocol)

The lifecycle scripts below are the protocol surface for moving a packet
through its states. They behave identically regardless of caller; what
changes is *who* invokes them.

**Autonomous mode (`run.ts <spec-id>`).** The orchestrator manages the
lifecycle. It calls `start`, `request-review`, and `complete` as
library functions while driving the develop and verify phases. Agents
under autonomous mode perform the work but do **not** call those three
CLIs themselves. The reviewer is the one exception: it calls
`review.ts --approve` / `--request-changes` to record its verdict.

**Manual mode.** Humans (or self-driving agents) may invoke any of the
lifecycle CLIs directly to walk a packet through its states by hand.

All four lifecycle scripts are idempotent — re-invocation on the same
state is a no-op.

| Command | Caller | Purpose |
|---|---|---|
| `npx tsx .factory/tools/plan.ts <spec-or-intent-id>` | planner agent / orchestrator | Resolve planner work and hand off to the planner persona |
| `npx tsx .factory/tools/execute.ts <feature-id>` | dev/qa agent / orchestrator | Determine which packets are ready next |
| `npx tsx .factory/tools/start.ts <packet-id>` | dev/qa agent | Claim a packet before implementation |
| `npx tsx .factory/tools/request-review.ts <packet-id>` | dev agent | Signal code is ready for review (dev packets only) |
| `npx tsx .factory/tools/review.ts <packet-id> --approve` | code reviewer agent | Approve the code review |
| `npx tsx .factory/tools/review.ts <packet-id> --request-changes` | code reviewer agent | Request changes |
| `npx tsx .factory/tools/complete.ts <packet-id>` | dev/qa agent | Run build/lint/test, write completion record |

### Approval semantics

`run.ts` accepts two kinds of inputs and treats them differently:

- **Spec-driven** (`specs/<id>.md` exists). The intent file is a
  derived artifact. The factory skips the intent-status check on this
  path because authoring the spec IS the gate.
- **Intent-driven** (only `intents/<id>.json` exists, no spec). The
  human edited the intent file directly. The intent's `status` IS the
  gate — `run.ts` requires it to be one of `approved`, `planned`, or
  `delivered` before planning.

---

## 3. Non-Negotiable Rules

### 3.1 No Implementation Without a Packet

Every code change must be associated with a factory packet.
Do not write code and then create the packet after the fact.

### 3.2 No Commit Without Completion

Agents record completions through the agent protocol after implementation;
operators get this by running or re-running
`npx tsx .factory/tools/run.ts <spec-id>`. The pre-commit hook enforces
that started packets have completion records before commit.

### 3.3 No Facades

Do not introduce code that makes the system appear correct when it is not.
No stubbed success paths, no TODO implementations that return success,
no silent fallbacks that mask failure.

If something is not implemented, it must fail explicitly.

### 3.4 Single Intent Per Change

One packet = one intent. Do not mix:
- Refactor + feature
- Cleanup + behavior change
- Dependency update + logic change

### 3.5 Tests Are Required

Non-trivial changes must include tests. A successful build is not evidence of correctness.

### 3.6 Reviewer Must Differ from Implementer

FI-7: A QA packet cannot be completed by the same identity that completed its dev counterpart.
The factory validates this. If you implemented the dev packet, you cannot review the QA packet.

### 3.7 Every Dev Packet Needs a QA Counterpart

FI-8: Every dev packet in a feature must have a corresponding QA packet in the same feature.
The factory validates this. Plan features as dev/qa pairs from the start.

---

## 4. Session Reconstruction

If you are starting a new session or have lost context:

1. Run `npx tsx .factory/tools/status.ts`
2. Read the output — it tells you exactly where things stand
3. If a spec is proposed, run `npx tsx .factory/tools/run.ts <spec-id>` to drive the full pipeline
4. If you (an agent) need manual control while debugging, run `npx tsx .factory/tools/execute.ts <feature-id>` to see what packets are ready
5. The output tells you what to do next **and which persona to use**

Do not rely on memory. Do not guess. Read the factory state.

---

## 5. Execution Protocol (manual control — agent escape hatch)

For normal operation, the operator runs `run.ts <spec-id>` and the factory
drives the full pipeline. The loop below is for agents debugging a stuck
pipeline or exercising the lifecycle directly — not the day-to-day path.

When taking manual control, **execute.ts is the single authority on what
to do next**. Do not decide when to stop or what step comes next — always
ask execute.ts.

```
loop:
  1. Run: npx tsx .factory/tools/execute.ts <feature-id>
  2. Read the action kind in the output:
     - spawn_packets → spawn agents for ready packets using the assigned persona, run `npx tsx .factory/tools/start.ts <packet-id>` for each, complete each, go to 1
     - all_complete  → feature is done, ready for delivery
     - blocked       → resolve dependencies or replan
     - not_ready     → feature is already completed/delivered
```

Each iteration is stateless. If interrupted, re-run `.factory/tools/execute.ts` to resume.

The natural flow for each story: dev packet (developer) → code review (code_reviewer) → QA packet (qa).

---

## 6. Planner Protocol

The factory includes a distinct **planner actor** for decomposition. The planner is
responsible for turning an intent/spec artifact into a planned feature and dev/qa packet pairs.

The planner does not execute work. The pipeline runner does not plan work.

### Planner Flow

1. Human authors `specs/<spec-id>.md` (preferred) or, for backward
   compatibility, `factory/intents/<intent-id>.json`. The intent must declare
   exactly one of `spec` (inline body for short intents) or `spec_path` (path
   relative to the project root pointing at a Markdown file containing the
   authoritative spec — use this for long, human-authored specs that already
   live alongside the code, e.g. `docs/specs/016-platform-targets.md`).
   `spec_path` must be relative, must not escape the project root, and must
   point at a non-empty file. `validate.ts` enforces these rules; `plan.ts`
   reads the file at plan time and hands its full contents to the planner.
2. The orchestrator (or, when debugging, an agent) calls
   `npx tsx .factory/tools/plan.ts <spec-or-intent-id>`. Operators run the
   full pipeline with `npx tsx .factory/tools/run.ts <spec-id>` instead.
3. If the action is `plan_feature`, spawn a planner agent using the returned planner assignment
4. Planner writes:
   - one feature artifact with `status: "planned"`
   - dev/qa packet pairs
   - dependencies
   - change classes
   - acceptance criteria
5. The pipeline runner picks up the planned feature and drives execution to completion

Planner invariants:
- Do not approve or execute
- Do not collapse dev and QA into one packet
- Do not bypass the governing approval authority for the intent/spec
- Preserve the existing completion model

---

## 7. Configuration

The factory reads its configuration from `factory.config.json` in the project root.
This file defines:
- Verification commands (build, lint, test)
- Infrastructure file patterns (files that don't count as implementation)
- Default completion identity
- **Persona definitions** (instructions for planner, developer, code_reviewer, and qa agents)
- **Pipeline provider mappings** (codex / claude / copilot)

### Personas and Instructions

Personas are defined in `factory.config.json` under the `personas` key. Each persona
has a `description` and an `instructions` array. Instructions are passed to agents
when execute.ts assigns them packets.

```json
{
  "personas": {
    "planner": {
      "description": "Decomposes the intent into a planned feature and packet set",
      "instructions": ["Produce one feature artifact plus dev/qa packet pairs"],
      "model": "high"
    },
    "developer": {
      "description": "Implements the change",
      "instructions": ["Use the cpp-guidelines MCP server for all C++ code"],
      "model": "high"
    },
    "code_reviewer": {
      "description": "Reviews code changes for correctness, design, and contract adherence",
      "instructions": ["Verify contract invariants are preserved across boundaries"],
      "model": "medium"
    },
    "qa": {
      "description": "Verifies acceptance criteria are met",
      "instructions": ["Check MISRA compliance in clang-tidy output"],
      "model": "medium"
    }
  }
}
```

Individual packets can also carry `instructions` that are merged with persona
instructions. Packet-level instructions add to persona-level, they don't replace.

**You must follow all instructions returned by execute.ts.** They are project-level
constraints defined by the project owner.

---

## 8. Where to Find Things

- **Factory docs:** `.factory/README.md`
- **Integration guide:** `.factory/docs/integration.md`
- **Schemas:** `.factory/schemas/` (JSON schemas for all artifact types)
