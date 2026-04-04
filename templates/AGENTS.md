# Agent Operating Instructions

This file defines how all contributors — AI agents and humans — must operate
in this repository. It is the complete operational reference for the factory
workflow. AI agents must follow it as hard constraints; humans should treat
it as the authoritative process guide.

It applies to all agents regardless of provider (Claude, GPT, Gemini, Copilot, Cursor, etc.).

---

## 1. The Factory Controls All Work

This repository uses a factory system to govern all implementation work.
The factory is the source of truth for what work exists, what is in progress, and what is complete.

**You must not implement code without using the factory.**

### Before Starting Any Work

```sh
npx tsx .factory/tools/status.ts
```

This tells you:
- What packets are in progress
- What is blocked
- What needs completion
- What the next legal action is

**If a feature is active:**
```sh
npx tsx .factory/tools/execute.ts <feature-id>
```

This tells you which packets are ready to implement **and which persona to use**.

### After Completing Implementation

```sh
npx tsx .factory/tools/complete.ts <packet-id>                        # dev packets (uses default identity)
npx tsx .factory/tools/complete.ts <packet-id> --identity claude-qa   # QA packets (distinct identity)
```

This runs build + lint + tests and creates a completion record.
**Do this before committing. Completion is the deliverable, not the packet.**

**QA agents must use `--identity` to distinguish themselves from the developer agent.**
FI-7 requires that the QA completion identity differs from the dev completion identity.
If both use the default, validation will reject the QA completion.

The pre-commit hook will reject commits that include implementation files
without a matching completion record.

---

## 2. Factory Lifecycle

```
Feature (intent) → Plan (dev/qa packet pairs) → Human Approval → Execution → Delivery
```

### Dev/QA Packet Pairs

Each story in a feature decomposes into a **dev packet** and a **QA packet**:

- **Dev packet** (`kind: "dev"`): implements the change
- **QA packet** (`kind: "qa"`): verifies the dev packet's acceptance criteria were met

QA packets reference their dev counterpart via the `verifies` field and depend on
the dev packet (listed in `dependencies`). This means QA is sequenced automatically:
the factory will not assign a QA packet until its dev packet is complete.

### Persona Assignment

Execute.ts returns each ready packet with a **persona** and a **model**:
- Dev packets → `developer` persona
- QA packets → `reviewer` persona

The planner spawns the agent with the persona and model the factory specifies.
**FI-7**: A QA packet must not be completed by the same identity that completed its dev counterpart.

### Model Selection

Execute.ts resolves the model tier for each packet using a fallback chain:
1. **Packet-level `model`** — overrides everything (set in the packet JSON)
2. **Persona-level `model`** — default for that persona (set in `factory.config.json`)
3. **Hardcoded default** — `"opus"` if nothing is configured

Default persona models:
- `developer`: `"opus"`
- `reviewer`: `"sonnet"`

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

Artifacts live under the `factory/` directory at the project root.
The `.factory/` submodule contains only tooling (tools, schemas, hooks).

| Directory | Purpose |
|---|---|
| `factory/features/` | Feature-level intents (multi-packet) |
| `factory/packets/` | Individual work units (dev and qa) |
| `factory/completions/` | Verification evidence (build/lint/test results) |
| `factory/acceptances/` | Human approval records |
| `factory/supervisor/` | Supervisor state and memory |

### Commands

| Command | When to Use |
|---|---|
| `npx tsx .factory/tools/status.ts` | Start of session, after context loss, when unsure what to do |
| `npx tsx .factory/tools/execute.ts <feature-id>` | Determine which packets to implement next (returns packet + persona) |
| `npx tsx .factory/tools/complete.ts <packet-id>` | After implementation, before committing |
| `npx tsx .factory/tools/accept.ts <packet-id>` | Accept a completed packet (human action — do not call autonomously) |
| `npx tsx .factory/tools/validate.ts` | Verify factory integrity |
| `npx tsx .factory/tools/supervise.ts` | Supervisor tick — next orchestration action |
| `npx tsx .factory/tools/supervise.ts --init` | Initialize supervisor state |

---

## 3. Non-Negotiable Rules

### 3.1 No Implementation Without a Packet

Every code change must be associated with a factory packet.
Do not write code and then create the packet after the fact.

### 3.2 No Commit Without Completion

Run `npx tsx .factory/tools/complete.ts <packet-id>` before committing.
The pre-commit hook enforces this. If it blocks you, create the completion first.

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
3. If a feature is active, run `npx tsx .factory/tools/execute.ts <feature-id>`
4. The output tells you what to do next **and which persona to use**

Do not rely on memory. Do not guess. Read the factory state.

---

## 5. Execution Protocol (for feature-level work)

When executing a feature, **execute.ts is the single authority on what to do next**.
Do not decide when to stop or what step comes next — always ask execute.ts.

```
loop:
  1. Run: npx tsx .factory/tools/execute.ts <feature-id>
  2. Read the action kind in the output:
     - spawn_packets  → spawn agents for ready packets using the assigned persona, complete each, go to 1
     - awaiting_acceptance → stop, inform human that architectural packets need acceptance
     - all_complete   → feature is done, ready for delivery
     - blocked        → resolve dependencies or replan
```

Each iteration is stateless. If interrupted, re-run `.factory/tools/execute.ts` to resume.

The natural flow for each story: dev packet (developer) → QA packet (reviewer) → acceptance (human, if architectural).

---

## 6. Supervisor Protocol

The factory includes a **supervisor actor** for automated orchestration. The supervisor
is a stateless tick function that reads factory state and returns the next action.

### When to Use

Use the supervisor when you want automated orchestration of feature execution.
The supervisor replaces the manual `execute.ts` loop with a higher-level actor
that tracks feature phases, spawns agents, and escalates to humans.

### How It Works

```
1. Human creates feature + packets
2. Human approves feature
3. Run: npx tsx .factory/tools/supervise.ts --init   (first time only)
4. Run: npx tsx .factory/tools/supervise.ts --json
5. Perform the returned action
6. Repeat step 4 until idle
```

The supervisor returns one action per tick:
- `execute_feature` — spawn agents for ready packets
- `escalate_acceptance` — present to human for acceptance
- `escalate_blocked` — present to human, something is stuck
- `update_state` — state has been refreshed, re-tick
- `idle` — nothing to do

### State Files

| File | Purpose |
|---|---|
| `factory/supervisor/state.json` | Feature tracking, escalations, audit log |
| `factory/supervisor/memory.md` | Cross-session context for any inference engine |
| `factory/supervisor/SUPERVISOR.md` | Behavioral contract (copy from `.factory/templates/SUPERVISOR.md`) |

### Supervisor Invariants (SI-1 through SI-7)

| ID | Rule |
|---|---|
| SI-1 | State must be consistent with factory artifacts |
| SI-2 | Supervisor never performs human-authority actions |
| SI-3 | Actions are idempotent |
| SI-4 | Audit log is append-only |
| SI-5 | Reuses resolveExecuteAction — does not bypass factory contracts |
| SI-6 | Pending escalations block feature progression |
| SI-7 | One action per tick |

---

## 7. Configuration

The factory reads its configuration from `factory.config.json` in the project root.
This file defines:
- Verification commands (build, lint, test)
- Infrastructure file patterns (files that don't count as implementation)
- Default completion identity
- **Persona definitions** (instructions for developer and reviewer agents)

### Personas and Instructions

Personas are defined in `factory.config.json` under the `personas` key. Each persona
has a `description` and an `instructions` array. Instructions are passed to agents
when execute.ts assigns them packets.

```json
{
  "personas": {
    "developer": {
      "description": "Implements the change",
      "instructions": ["Use the cpp-guidelines MCP server for all C++ code"],
      "model": "opus"
    },
    "reviewer": {
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

## 8. Migration

When upgrading an existing factory installation, run:

```sh
npx tsx .factory/tools/migrate.ts        # apply migration
npx tsx .factory/tools/migrate.ts --dry  # preview without writing
```

This adds required fields (`kind`, `acceptance_criteria`) to pre-existing packets and features.
Migration placeholders (`[MIGRATION]`) must be replaced with real acceptance criteria
before the next execution cycle.

---

## 9. Where to Find Things

- **Factory docs:** `.factory/README.md`
- **Integration guide:** `.factory/docs/integration.md`
- **Schemas:** `.factory/schemas/` (JSON schemas for all artifact types)
- **Factory invariants:** `.factory/README.md` § Factory Invariants (FI-1 through FI-10)
