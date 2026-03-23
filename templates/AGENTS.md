# Agent Operating Instructions

This file defines how AI agents must operate in this repository.
It applies to all agents regardless of provider (Claude, GPT, Gemini, Copilot, Cursor, etc.).

These are not guidelines. They are constraints. Violating them produces incorrect work.

---

## 1. The Factory Controls All Work

This repository uses a factory system to govern all implementation work.
The factory is the source of truth for what work exists, what is in progress, and what is complete.

**You must not implement code without using the factory.**

### Before Starting Any Work

```sh
npx tsx factory/tools/status.ts
```

This tells you:
- What packets are in progress
- What is blocked
- What needs completion
- What the next legal action is

**If a feature is active:**
```sh
npx tsx factory/tools/execute.ts <feature-id>
```

This tells you which packets are ready to implement **and which persona to use**.

### After Completing Implementation

```sh
npx tsx factory/tools/complete.ts <packet-id>
```

This runs build + lint + tests and creates a completion record.
**Do this before committing. Completion is the deliverable, not the packet.**

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

Execute.ts returns each ready packet with a **persona**:
- Dev packets → `developer` persona
- QA packets → `reviewer` persona

The planner spawns the agent with the persona the factory specifies.
**FI-7**: A QA packet must not be completed by the same identity that completed its dev counterpart.

### Artifacts

| Directory | Purpose |
|---|---|
| `factory/features/` | Feature-level intents (multi-packet) |
| `factory/packets/` | Individual work units (dev and qa) |
| `factory/completions/` | Verification evidence (build/lint/test results) |
| `factory/acceptances/` | Human approval records |

### Commands

| Command | When to Use |
|---|---|
| `npx tsx factory/tools/status.ts` | Start of session, after context loss, when unsure what to do |
| `npx tsx factory/tools/execute.ts <feature-id>` | Determine which packets to implement next (returns packet + persona) |
| `npx tsx factory/tools/complete.ts <packet-id>` | After implementation, before committing |
| `npx tsx factory/tools/accept.ts <packet-id>` | Accept a completed packet (human action — do not call autonomously) |
| `npx tsx factory/tools/validate.ts` | Verify factory integrity |

---

## 3. Non-Negotiable Rules

### 3.1 No Implementation Without a Packet

Every code change must be associated with a factory packet.
Do not write code and then create the packet after the fact.

### 3.2 No Commit Without Completion

Run `npx tsx factory/tools/complete.ts <packet-id>` before committing.
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

1. Run `npx tsx factory/tools/status.ts`
2. Read the output — it tells you exactly where things stand
3. If a feature is active, run `npx tsx factory/tools/execute.ts <feature-id>`
4. The output tells you what to do next **and which persona to use**

Do not rely on memory. Do not guess. Read the factory state.

---

## 5. Execution Protocol (for feature-level work)

When executing a feature, **execute.ts is the single authority on what to do next**.
Do not decide when to stop or what step comes next — always ask execute.ts.

```
loop:
  1. Run: npx tsx factory/tools/execute.ts <feature-id>
  2. Read the action kind in the output:
     - spawn_packets  → spawn agents for ready packets using the assigned persona, complete each, go to 1
     - awaiting_acceptance → stop, inform human that architectural packets need acceptance
     - all_complete   → feature is done, ready for delivery
     - blocked        → resolve dependencies or replan
```

Each iteration is stateless. If interrupted, re-run `factory/tools/execute.ts` to resume.

The natural flow for each story: dev packet (developer) → QA packet (reviewer) → acceptance (human, if architectural).

---

## 6. Configuration

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
      "instructions": ["Use the cpp-guidelines MCP server for all C++ code"]
    },
    "reviewer": {
      "description": "Verifies acceptance criteria are met",
      "instructions": ["Check MISRA compliance in clang-tidy output"]
    }
  }
}
```

Individual packets can also carry `instructions` that are merged with persona
instructions. Packet-level instructions add to persona-level, they don't replace.

**You must follow all instructions returned by execute.ts.** They are project-level
constraints defined by the project owner.

---

## 7. Migration

When upgrading an existing factory installation, run:

```sh
npx tsx factory/tools/migrate.ts        # apply migration
npx tsx factory/tools/migrate.ts --dry  # preview without writing
```

This adds required fields (`kind`, `acceptance_criteria`) to pre-existing packets and features.
Migration placeholders (`[MIGRATION]`) must be replaced with real acceptance criteria
before the next execution cycle.

---

## 8. Where to Find Things

- **Factory docs:** `factory/README.md`
- **Integration guide:** `factory/docs/integration.md`
- **Schemas:** `factory/schemas/` (JSON schemas for all artifact types)
- **Factory invariants:** `factory/README.md` § Factory Invariants (FI-1 through FI-10)
