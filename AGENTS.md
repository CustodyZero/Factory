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
npx tsx tools/status.ts
```

This tells you:
- What packets are in progress
- What is blocked
- What needs completion
- What the next legal action is

**If a feature is active:**
```sh
npx tsx tools/execute.ts <feature-id>
```

This tells you which packets are ready to implement **and which persona to use**.
Before touching implementation, explicitly claim the packet:
```sh
npx tsx tools/start.ts <packet-id>
```

### After Implementation — Code Review (Dev Packets Only)

Dev packets must pass code review before completion. QA packets skip this step.

```sh
npx tsx tools/request-review.ts <packet-id>                  # Developer signals code is ready for review
npx tsx tools/review.ts <packet-id> --approve                # Code reviewer approves
npx tsx tools/review.ts <packet-id> --request-changes        # Code reviewer requests changes
```

The developer ↔ code review loop repeats until the reviewer approves:
```
implementing → review_requested → [changes_requested → implementing → review_requested →]* review_approved → completed
```

The `branch` field on the packet identifies the git branch under review.
Review feedback lives in git (branch diffs, git notes) — not in factory artifacts.

### After Code Review (or for QA Packets)

```sh
npx tsx tools/complete.ts <packet-id>                        # dev packets (uses default identity)
npx tsx tools/complete.ts <packet-id> --identity claude-qa   # QA packets (distinct identity)
```

This runs build + lint + tests and creates a completion record.
**Do this before committing. Completion is the deliverable, not the packet.**
**Dev packets must be in `review_approved` status before complete.ts will accept them.**

**QA agents must use `--identity` to distinguish themselves from the developer agent.**
FI-7 requires that the QA completion identity differs from the dev completion identity.
If both use the default, validation will reject the QA completion.

The pre-commit hook will reject commits that include implementation files
without a matching completion record.

---

## 2. Factory Lifecycle

```
Intent/Spec → Planner → Feature + Dev/QA Packets → Human Approval → Supervisor → Execution → Delivery
```

### Dev/QA Packet Pairs

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
| `npx tsx tools/orchestrate.ts run --intent <intent-id>` | Plan an intent, stop at approval, then continue into supervised execution once approved |

---

## 3. Non-Negotiable Rules

### 3.1 No Implementation Without a Packet

Every code change must be associated with a factory packet.
Do not write code and then create the packet after the fact.

### 3.2 No Commit Without Completion

Run `npx tsx tools/complete.ts <packet-id>` before committing.
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

1. Run `npx tsx tools/status.ts`
2. Read the output — it tells you exactly where things stand
3. If an intent is proposed, run `npx tsx tools/plan.ts <intent-id>`
4. If a feature is active, run `npx tsx tools/execute.ts <feature-id>`
5. The output tells you what to do next **and which persona to use**

Do not rely on memory. Do not guess. Read the factory state.

---

## 5. Execution Protocol (for feature-level work)

When executing a feature, **execute.ts is the single authority on what to do next**.
Do not decide when to stop or what step comes next — always ask execute.ts.

```
loop:
  1. Run: npx tsx tools/execute.ts <feature-id>
  2. Read the action kind in the output:
     - spawn_packets  → spawn agents for ready packets using the assigned persona, run `npx tsx tools/start.ts <packet-id>` for each assigned packet, complete each, go to 1
     - awaiting_acceptance → stop, inform human that architectural packets need acceptance
     - all_complete   → feature is done, ready for delivery
     - blocked        → resolve dependencies or replan
```

Each iteration is stateless. If interrupted, re-run `tools/execute.ts` to resume.

The natural flow for each story: dev packet (developer) → QA packet (qa) → acceptance (human, if architectural).

---

## 6. Planner Protocol

The factory includes a distinct **planner actor** for decomposition. The planner is
responsible for turning an intent/spec artifact into a planned feature and dev/qa packet pairs.

The planner does not execute work. The supervisor does not plan work.

### Planner Flow

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
5. Human reviews the generated plan and marks the feature `approved`
6. Supervisor takes over only after approval

Planner invariants:
- Do not approve or execute
- Do not collapse dev and QA into one packet
- Do not bypass human approval
- Preserve the existing completion/acceptance model

---

## 7. Supervisor Protocol

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
1. Human approves a planned feature (typically produced from an intent by the planner)
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
- stop only at `idle`, `awaiting_approval`, or a real blocking/escalation gate after retries are exhausted

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
