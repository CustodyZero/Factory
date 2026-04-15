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
- Dev packets → `developer` (implementation) and `code_reviewer` (review, Phase 3)
- QA packets → `qa`

Execute.ts returns each ready packet with a **persona** and a **model**:
- Dev packets → `developer` persona
- QA packets → `qa` persona

The outer orchestrator or human spawns the planner, developer, code_reviewer, or qa agent
using the persona and model the factory specifies.
**FI-7**: A QA packet must not be completed by the same identity that completed its dev counterpart.

### Model Selection

Execute.ts resolves the model tier for each packet using a fallback chain:
1. **Packet-level `model`** — overrides everything (set in the packet JSON)
2. **Persona-level `model`** — default for that persona (set in `factory.config.json`)
3. **Hardcoded default** — `"opus"` if nothing is configured

Default persona models:
- `developer`: `"opus"`
- `code_reviewer`: `"sonnet"`
- `qa`: `"sonnet"`

Suggested override convention by change class (not enforced in code):

| Change class | Dev | QA |
|---|---|---|
| architectural | opus | opus |
| cross-cutting | opus | sonnet |
| local | sonnet | sonnet |
| trivial | sonnet | haiku |

Use packet-level `model` to escalate or downgrade specific packets (e.g., escalate an
architectural QA packet to opus, or downgrade a trivial dev packet to sonnet).

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
| `acceptances/` | Human approval records |

### Commands

| Command | When to Use |
|---|---|
| `npx tsx tools/status.ts` | Start of session, after context loss, when unsure what to do |
| `npx tsx tools/plan.ts <intent-id>` | Resolve planner work for an intent/spec and hand off to the planner persona |
| `npx tsx tools/execute.ts <feature-id>` | Determine which packets to implement next (returns packet + persona) |
| `npx tsx tools/start.ts <packet-id>` | Claim a packet and mark it started before implementation |
| `npx tsx tools/request-review.ts <packet-id>` | Developer signals code is ready for code review (dev packets only) |
| `npx tsx tools/review.ts <packet-id> --approve` | Code reviewer approves the code review |
| `npx tsx tools/review.ts <packet-id> --request-changes` | Code reviewer requests changes |
| `npx tsx tools/complete.ts <packet-id>` | After review approval (dev) or implementation (QA), before committing |
| `npx tsx tools/accept.ts <packet-id>` | Accept a completed packet (human action — do not call autonomously) |
| `npx tsx tools/validate.ts` | Verify factory integrity |
| `npx tsx tools/supervise.ts` | Supervisor tick — next orchestration action |
| `npx tsx tools/supervise.ts --init` | Initialize supervisor state |
| `npx tsx tools/orchestrate.ts health` | Check native Codex/Claude orchestrator availability |
| `npx tsx tools/orchestrate.ts plan <intent-id>` | Invoke the configured planner provider for a plan-ready intent |
| `npx tsx tools/orchestrate.ts supervise` | Invoke the deterministic harness for supervisor-issued dispatches |
| `npx tsx tools/orchestrate.ts run` | Run the native autonomous loop until idle or a human gate |
| `npx tsx tools/orchestrate.ts run --intent <intent-id>` | Plan an intent and, if the intent is approved, continue directly into supervised execution |

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

1. Human creates `intents/<intent-id>.json`. The intent must declare exactly one
   of `spec` (inline body for short intents) or `spec_path` (path relative to the
   project root pointing at a Markdown file containing the authoritative spec —
   use this for long, human-authored specs that already live alongside the code,
   e.g. `docs/specs/016-platform-targets.md`). `spec_path` must be relative, must
   not escape the project root, and must point at a non-empty file. `validate.ts`
   enforces these rules; `plan.ts` reads the file at plan time and hands its full
   contents to the planner.
2. Run `npx tsx tools/plan.ts <intent-id>`
3. If the action is `plan_feature`, spawn a planner agent using the returned planner assignment
4. Planner writes:
   - one feature artifact with `status: "planned"`
   - dev/qa packet pairs
   - dependencies
   - change classes
   - acceptance criteria
5. If the intent/spec is already approved, the planned feature inherits execution authority automatically
6. If the plan was created outside an approved intent, a human may still approve the feature directly
7. Supervisor takes over once execution authority exists

Planner invariants:
- Do not approve or execute
- Do not collapse dev and QA into one packet
- Do not bypass the governing approval authority for the intent/spec or feature
- Preserve the existing completion/acceptance model

- **verification:** build, lint, test commands run during `complete.ts`
- **personas:** planner, developer, code_reviewer, qa — each with
  description, instructions, and model tier (high/medium/low)
- **pipeline:** provider mappings (codex/claude/copilot), completion identities,
  max review iterations, per-provider model_map

## 8. Where to Find Things

The factory includes a **supervisor actor** for automated orchestration. The supervisor
is a stateless tick function that reads factory state and returns the next action.

### When to Use

Use the supervisor when you want automated orchestration of feature execution.
The supervisor replaces the manual `execute.ts` loop with a higher-level actor
that tracks feature phases, spawns agents, and escalates to humans.
When supervisor mode is active, only packets returned in `ready_packets` may be started.

### How It Works

Manual supervisor loop:

```
1. Human approves the governing intent/spec, or directly approves a standalone planned feature
2. Run: npx tsx tools/supervise.ts --init   (first time only)
3. Run: npx tsx tools/supervise.ts --json
4. Perform the returned action
5. Repeat step 3 until idle
```

Native autonomous loop:

```sh
npx tsx tools/orchestrate.ts run
npx tsx tools/orchestrate.ts run --intent <intent-id>
```

`orchestrate.ts run` will:
- initialize supervisor state automatically when needed
- re-tick after `update_state`
- invoke planner/developer/code_reviewer/qa agents through the configured Codex/Claude shell contracts
- retry failed planner and packet runs through the configured provider/model ladder
- stop only at `idle` or an explicit human gate (`acceptance`, `blocked`, `failure`, or direct feature approval when no approved intent governs the plan`) after retries are exhausted

The supervisor returns one action per tick:
- `execute_feature` — spawn agents for ready packets using the returned dispatch records
- `escalate_acceptance` — present to human for acceptance
- `escalate_blocked` — present to human, something is stuck
- `update_state` — state has been refreshed, re-tick
- `idle` — nothing to do

In `execute_feature`:
- `dispatches` are the supervisor-issued authorization records
- `ready_packets` describe the human-readable assignment details
- agents must run the returned `start_command` before implementation
- the outer orchestrator must not spawn any packet missing from `dispatches`
- one `execute_feature` action may include packets from multiple independent features

Native orchestrator support is restricted to `codex` and `claude`.
`gemini` is not part of the deterministic harness.

### State Files

| File | Purpose |
|---|---|
| `supervisor/state.json` | Feature tracking, escalations, audit log |
| `supervisor/orchestrator-state.json` | Bounded orchestrator cache, provider checks, and recent run history |
| `supervisor/memory.md` | Cross-session context for any inference engine |
| `supervisor/SUPERVISOR.md` | Behavioral contract (copy from `factory/templates/SUPERVISOR.md`) |

### Supervisor Invariants (SI-1 through SI-7)

| ID | Rule |
|---|---|
| SI-1 | State must be consistent with factory artifacts |
| SI-2 | Supervisor never performs human-authority actions |
| SI-3 | Actions are idempotent |
| SI-4 | Audit log is append-only |
| SI-5 | Reuses resolveExecuteAction — does not bypass factory contracts |
| SI-6 | Pending escalations block feature progression |
| SI-7 | One action per tick (an action may authorize work across multiple features) |

---

## 8. Configuration

The factory reads its configuration from `factory.config.json` in the project root.
This file defines:
- Verification commands (build, lint, test)
- Infrastructure file patterns (files that don't count as implementation)
- Default completion identity
- **Persona definitions** (instructions for planner, developer, code_reviewer, and qa agents)
- **Orchestrator provider mappings** (Codex/Claude only)

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
      "model": "opus"
    },
    "developer": {
      "description": "Implements the change",
      "instructions": ["Use the cpp-guidelines MCP server for all C++ code"],
      "model": "opus"
    },
    "code_reviewer": {
      "description": "Reviews code changes for correctness, design, and contract adherence",
      "instructions": ["Verify contract invariants are preserved across boundaries"],
      "model": "sonnet"
    },
    "qa": {
      "description": "Verifies acceptance criteria are met",
      "instructions": ["Check MISRA compliance in clang-tidy output"],
      "model": "sonnet"
    }
  }
}
```

Individual packets can also carry `instructions` that are merged with persona
instructions. Packet-level instructions add to persona-level, they don't replace.

**You must follow all instructions returned by execute.ts.** They are project-level
constraints defined by the project owner.

---

## 9. Migration

When upgrading an existing factory installation, run:

```sh
npx tsx tools/migrate.ts        # apply migration
npx tsx tools/migrate.ts --dry  # preview without writing
```

This adds required fields (`kind`, `acceptance_criteria`) to pre-existing packets and features.
Migration placeholders (`[MIGRATION]`) must be replaced with real acceptance criteria
before the next execution cycle.

Planner migration guidance:
- Existing features and packets remain valid without `intent_id`
- `migrate.ts` now ensures the `intents/` directory exists
- Downstream repos can adopt planner-native flow incrementally by creating new work under `intents/`
- Existing approved features can continue through execution unchanged

---

## 10. Where to Find Things

- **Factory docs:** `README.md`
- **Integration guide:** `docs/integration.md`
- **Schemas:** `schemas/` (JSON schemas for all artifact types)
- **Factory invariants:** `README.md` § Factory Invariants (FI-1 through FI-10)
