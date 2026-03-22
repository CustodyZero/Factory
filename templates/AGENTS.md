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

This tells you which packets are ready to implement.

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
Feature (intent) → Plan (packets) → Human Approval → Execution → QA Report → Delivery
```

### Artifacts

| Directory | Purpose |
|---|---|
| `factory/features/` | Feature-level intents (multi-packet) |
| `factory/packets/` | Individual work units |
| `factory/completions/` | Verification evidence (build/lint/test results) |
| `factory/acceptances/` | Human approval records |
| `factory/reports/` | QA reports for completed features |

### Commands

| Command | When to Use |
|---|---|
| `npx tsx factory/tools/status.ts` | Start of session, after context loss, when unsure what to do |
| `npx tsx factory/tools/execute.ts <feature-id>` | Determine which packets to implement next |
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

---

## 4. Session Reconstruction

If you are starting a new session or have lost context:

1. Run `npx tsx factory/tools/status.ts`
2. Read the output — it tells you exactly where things stand
3. If a feature is active, run `npx tsx factory/tools/execute.ts <feature-id>`
4. The output tells you what to do next

Do not rely on memory. Do not guess. Read the factory state.

---

## 5. Execution Protocol (for feature-level work)

When executing a feature with multiple packets:

```
loop:
  1. Run: npx tsx factory/tools/execute.ts <feature-id>
  2. Read output: which packets are ready?
  3. Implement ready packets (parallel if independent)
  4. For each completed packet: npx tsx factory/tools/complete.ts <packet-id>
  5. Commit with completion
  6. Go to 1

  Exit when: all_complete
  Then: produce QA report
```

Each iteration is stateless. If interrupted, re-run `factory/tools/execute.ts` to resume.

---

## 6. Configuration

The factory reads its configuration from `factory.config.json` in the project root.
This file defines:
- Verification commands (build, lint, test)
- Infrastructure file patterns (files that don't count as implementation)
- Default completion identity

---

## 7. Where to Find Things

- **Factory docs:** `factory/README.md`
- **Integration guide:** `factory/docs/integration.md`
- **Schemas:** `factory/schemas/` (JSON schemas for all artifact types)
- **Factory invariants:** `factory/README.md` § Factory Invariants (FI-1 through FI-7)
