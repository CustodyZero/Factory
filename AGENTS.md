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

**Session reconstruction:** run `npx tsx tools/status.ts` at the start of every
session. It tells you where things stand and what to do next.

## 2. Pipeline Lifecycle

```
Intent (human writes spec + constraints)
  |
  v
run.ts <intent-id>      <-- single command, runs to completion
  |-- Plan: planner decomposes spec into feature + dev/qa packet pairs
  |-- Develop: for each dev packet
  |     |-- Developer agent implements
  |     |-- Code reviewer agent reviews (different identity)
  |     |-- Feedback loop if needed (bounded by max_review_iterations)
  |     |-- Completion recorded (build/lint/test verification)
  |-- Verify: for each QA packet
  |     |-- QA agent verifies (different identity from dev)
  |     |-- Completion recorded
  |-- Done: feature marked complete, summary printed
```

**Human gates:** exactly two.
1. Approve the spec (write the markdown document)
2. Approve the intent (create the intent artifact with constraints)

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

Artifacts always live at the **project root** (alongside `factory.config.json`).
When Factory is installed as a git submodule, the submodule contains only tooling —
artifacts are never written inside the submodule.

| Directory | Purpose |
|---|---|
| `intents/` | High-level specs for planner decomposition |
| `features/` | Planned execution units (multi-packet) |
| `packets/` | Individual work units (dev and qa) |
| `completions/` | Verification evidence (build/lint/test results) |

### Commands

| Command | When to Use |
|---|---|
| `npx tsx tools/status.ts` | Start of session, after context loss, when unsure what to do |
| `npx tsx tools/run.ts <intent-id>` | Run the full pipeline (plan → develop → review → verify) for an intent |
| `npx tsx tools/plan.ts <intent-id>` | Resolve planner work for an intent/spec and hand off to the planner persona |
| `npx tsx tools/execute.ts <feature-id>` | Determine which packets to implement next (returns packet + persona) |
| `npx tsx tools/start.ts <packet-id>` | Claim a packet and mark it started before implementation |
| `npx tsx tools/request-review.ts <packet-id>` | Developer signals code is ready for code review (dev packets only) |
| `npx tsx tools/review.ts <packet-id> --approve` | Code reviewer approves the code review |
| `npx tsx tools/review.ts <packet-id> --request-changes` | Code reviewer requests changes |
| `npx tsx tools/complete.ts <packet-id>` | After review approval (dev) or implementation (QA), before committing |
| `npx tsx tools/validate.ts` | Verify factory integrity |

---

## 3. Non-Negotiable Rules

3.1. **No implementation without a packet.** If there is no packet artifact,
     there is no authority to change code. Create the packet first.

3.2. **No commit without a completion.** The pre-commit hook enforces this.
     Run `complete.ts` after implementation; it records build/lint/test results.

3.3. **No facades.** No stubbed success paths, no TODOs that return success,
     no silent fallbacks. If something is not done, it must fail explicitly.

3.4. **Single intent per change.** Don't mix refactoring with features,
     cleanup with behavior changes, or infrastructure with implementation.

3.5. **Tests required for non-trivial changes.**

3.6. **Reviewer must differ from implementer (FI-7).** QA packet completion
     identity must be different from the dev packet completion identity.

3.7. **Every dev packet needs a QA counterpart (FI-8).**

## 4. Artifact Types

All artifacts live under the `artifact_dir` (configured in factory.config.json,
typically `factory/`).

| Directory | What | Created by |
|-----------|------|------------|
| `intents/` | High-level specs with constraints | Human |
| `features/` | Planned execution units (packet lists) | Planner agent |
| `packets/` | Individual dev/qa work units | Planner agent |
| `completions/` | Verification evidence (build/lint/test) | `complete.ts` |

### Packet lifecycle

```
(created) -> draft -> ready -> implementing -> review_requested
  -> changes_requested -> implementing -> review_requested
  -> review_approved -> completed
```

QA packets skip the review cycle: `implementing -> completed`.

### Packet kinds

- **dev** — implements code changes. Goes through code review.
- **qa** — verifies a dev packet's work. Must have `verifies` field pointing
  to the dev packet ID. Completed by a different identity than the dev packet.

## 5. Tools

| Command | Purpose |
|---------|---------|
| `run.ts <intent-id>` | Full pipeline: plan, develop, review, verify, done |
| `status.ts` | Session reconstruction — where things stand |
| `plan.ts <intent-id>` | Resolve planner action for an intent |
| `execute.ts <feature-id>` | What packets are ready for execution |
| `start.ts <packet-id>` | Claim a packet before implementation |
| `request-review.ts <packet-id>` | Signal code is ready for review |
| `review.ts <packet-id> --approve\|--request-changes` | Code review decision |
| `complete.ts <packet-id>` | Run verification, create completion record |
| `validate.ts` | Schema + integrity validation |
| `completion-gate.ts` | Pre-commit enforcement (FI-7) |

## 6. Factory Invariants

- **FI-1:** One completion per packet (no duplicates)
- **FI-4:** Completion requires verification to have been run
- **FI-7:** QA completion identity must differ from dev completion identity
- **FI-8:** Every dev packet in a feature must have a QA counterpart
- **FI-9:** No cyclic packet dependencies

The full FI-1 through FI-10 invariant set is documented in `README.md` § Factory Invariants.

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

- **Factory docs:** `README.md`
- **Integration guide:** `docs/integration.md`
- **Schemas:** `schemas/` (JSON schemas for all artifact types)
- **Factory invariants:** `README.md` § Factory Invariants (FI-1 through FI-10)
