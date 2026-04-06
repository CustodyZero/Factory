<p align="center">
  <img src="https://raw.githubusercontent.com/CustodyZero/brand/main/brand/factory/wordmark/factory-wordmark-green.svg"
       alt="Factory" width="200" />
</p>

A change-control system for governed AI-assisted development.

The factory enforces that all work is scoped, intentional, and accepted
through a risk-proportional process before it is considered done.

It is not a project management tool. It is a **governance artifact store**
with deterministic derivation rules.

---

## Why

AI agents can implement code. They cannot judge whether a change is safe
to ship. The factory separates implementation (which agents can do) from
acceptance (which requires human authority for high-risk changes).

Every change must declare its intent and scope before implementation
begins. Acceptance criteria are determined by change class, not by
the implementer.

---

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm (or npm/yarn — adjust `factory.config.json` accordingly)

### Add to an Existing Project

```sh
# Add factory as a git submodule (hidden — tooling only)
git submodule add https://github.com/custodyzero/factory.git .factory

# Run setup (installs deps, copies templates, creates artifact dirs, configures hooks)
./.factory/setup.sh

# Configure for your project
# Edit factory.config.json — set project_name and verification commands
```

### Configure for Your Project

Edit `factory.config.json` at the project root:

```json
{
  "project_name": "my-project",
  "factory_dir": ".factory",
  "artifact_dir": "factory",
  "verification": {
    "build": "dotnet build",
    "lint": "true",
    "test": "dotnet test"
  },
  "validation": {
    "command": "npx tsx .factory/tools/validate.ts"
  },
  "infrastructure_patterns": [
    ".factory/",
    "factory/",
    ".github/",
    "package.json",
    ".gitignore",
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "LICENSE"
  ],
  "completed_by_default": {
    "kind": "agent",
    "id": "claude"
  }
}
```

---

## Your First Change

Factory has no `create` command — features and packets are JSON files you
write by hand (or have an AI agent write). This walkthrough shows the full
cycle for a single change using a standalone packet.

### 1. Create a dev packet

```json
// factory/packets/add-health-endpoint-dev.json
{
  "id": "add-health-endpoint-dev",
  "kind": "dev",
  "title": "Add /health endpoint",
  "intent": "Expose a health check endpoint so load balancers can verify the service is running.",
  "acceptance_criteria": [
    "GET /health returns 200 with { \"status\": \"ok\" }",
    "Response time is under 50ms",
    "Endpoint is included in API tests"
  ],
  "change_class": "local",
  "scope": { "packages": ["api"] },
  "owner": "alice",
  "created_at": "2025-01-15T10:00:00Z",
  "started_at": null,
  "dependencies": [],
  "feature_id": null
}
```

### 2. Create its QA counterpart

```json
// factory/packets/add-health-endpoint-qa.json
{
  "id": "add-health-endpoint-qa",
  "kind": "qa",
  "verifies": "add-health-endpoint-dev",
  "title": "Verify /health endpoint",
  "intent": "Confirm the health endpoint meets all acceptance criteria from the dev packet.",
  "acceptance_criteria": [
    "All dev packet acceptance criteria verified",
    "No regressions in existing API tests"
  ],
  "change_class": "local",
  "scope": { "packages": ["api"] },
  "owner": "alice",
  "created_at": "2025-01-15T10:00:00Z",
  "started_at": null,
  "dependencies": ["add-health-endpoint-dev"]
}
```

### 3. Check factory status

```sh
npx tsx .factory/tools/status.ts
```

You'll see both packets listed as `not_started`.

### 4. Implement the dev packet

Claim the packet to mark work as in progress. Write the
code, then run completion:

```sh
npx tsx .factory/tools/start.ts add-health-endpoint-dev
npx tsx .factory/tools/complete.ts add-health-endpoint-dev
```

This runs build + lint + tests and writes `factory/completions/add-health-endpoint-dev.json`.
Since the change class is `local`, it auto-accepts.

### 5. Review the QA packet

The QA packet is now unblocked (its dependency is complete). A different
agent or human reviews the dev work against the acceptance criteria, then:

```sh
npx tsx .factory/tools/start.ts add-health-endpoint-qa
npx tsx .factory/tools/complete.ts add-health-endpoint-qa --identity claude-qa
```

The `--identity` flag ensures the QA completion is attributed to a different
identity than the dev completion (FI-7).
If the QA packet declares `environment_dependencies`, matching evidence records
must exist before completion.

### 6. Commit

The pre-commit hook verifies that all started packets have completions.
Your commit includes the implementation files alongside the factory
artifacts — the governance trail is part of the repo history.

### Using features for larger work

For multi-packet work, wrap packets in a feature:

```json
// factory/features/health-monitoring.json
{
  "id": "health-monitoring",
  "intent": "Add health monitoring so ops can verify service availability.",
  "acceptance_criteria": [
    "Health endpoint exists and is tested",
    "Monitoring dashboard updated"
  ],
  "status": "approved",
  "packets": [
    "add-health-endpoint-dev",
    "add-health-endpoint-qa"
  ],
  "created_by": { "kind": "human", "id": "alice" },
  "created_at": "2025-01-15T09:00:00Z"
}
```

Then use `execute.ts` to drive the execution loop — it tells you which
packets are ready, which persona to use, and what to do next:

```sh
npx tsx .factory/tools/execute.ts health-monitoring
```

---

## Artifact Types

The factory has six artifact types. Each is a JSON file validated against
a schema in `.factory/schemas/` (or `schemas/` when working in the factory
repo itself).

All artifact paths below are relative to the artifact root. In submodule
installs this is `factory/` (e.g., `factory/packets/my-packet.json`). When
factory is the project, this is the repo root.

### Packet

A scoped unit of work. Declares **what** is changing, **why**, and
**which packages** are affected.

```
packets/<packet-id>.json
```

Every packet has a **kind**: `dev` (implements a change) or `qa` (verifies
a dev packet's acceptance criteria were met). Each dev packet in a feature
must have a corresponding QA packet (FI-8).

A QA packet sets `verifies` to the ID of the dev packet it reviews, and
lists that dev packet in `dependencies` so the factory sequences them
automatically — QA only becomes ready after dev completes.

Required fields:
- `id` — kebab-case identifier (must match filename)
- `kind` — `dev` or `qa`
- `title` — one-line summary
- `intent` — what is changing and why
- `acceptance_criteria` — testable conditions for completeness
- `change_class` — `trivial`, `local`, `cross_cutting`, or `architectural`
- `scope.packages` — which packages are affected
- `owner` — who is responsible
- `created_at` — ISO 8601 timestamp

QA-specific fields:
- `verifies` — ID of the dev packet this QA packet reviews (required for `qa`, forbidden for `dev`)

Optional fields:
- `started_at` — when work began (normally set by `tools/start.ts`)
- `dependencies` — packet IDs that must be completed first
- `environment_dependencies` — external dependencies requiring evidence
- `model` — model tier override (`opus`, `sonnet`, `haiku`)
- `instructions` — additional agent instructions (merged with persona instructions)
- `status` — `abandoned` or `deferred` (exempt from FI-6/FI-7)
- `feature_id` — parent feature ID
- `tags` — freeform labels

### Completion

Evidence that a packet's implementation is done. Created by `complete.ts`,
not by hand.

```
completions/<packet-id>.json
```

Required fields:
- `packet_id` — must reference an existing packet
- `completed_at` — ISO 8601 timestamp
- `completed_by` — identity (`{ kind, id }`)
- `summary` — what was done
- `verification` — `{ tests_pass, build_pass, lint_pass, ci_pass }` (all booleans)

### Acceptance

Human approval that a completed packet is accepted. Created by `accept.ts`.

```
acceptances/<packet-id>.json
```

Required fields:
- `packet_id` — must reference a packet with a valid completion
- `accepted_at` — ISO 8601 timestamp
- `accepted_by` — identity (must be `human`, `cli`, or `ui` — **never `agent`**)

### Rejection

Reverts an auto-accepted cross-cutting packet back to completed status.

```
rejections/<packet-id>.json
```

### Evidence

Proof that an environment dependency has been satisfied.

```
evidence/<dependency-key>.json
```

### Feature

A high-level intent that decomposes into dev/qa packet pairs.

```
features/<feature-id>.json
```

Required fields:
- `id` — kebab-case identifier (must match filename)
- `intent` — what the project should do when this feature is complete
- `acceptance_criteria` — feature-level success conditions
- `status` — `draft`, `planned`, `approved`, `executing`, `completed`, `delivered`
- `packets` — ordered list of packet IDs (dev and qa)
- `created_by` — identity

---

## Lifecycle

```
not_started → in_progress → completed → accepted
                                ↑            |
                                |  (rejection)|
                                +-------------+
```

A packet moves through states based on which artifacts exist:

| State                | Condition                                         |
|----------------------|---------------------------------------------------|
| `not_started`        | No completion, `started_at` is null               |
| `in_progress`        | No completion, `started_at` is set                |
| `environment_pending`| Completion exists, but environment deps are unmet |
| `completed`          | Completion exists, not yet accepted                |
| `accepted`           | Acceptance criteria satisfied (see below)          |

---

## Acceptance Rules

Acceptance is **proportional to risk**.

| Change Class    | Acceptance Path                                              |
|-----------------|--------------------------------------------------------------|
| `trivial`       | Auto-accepted when verification passes                       |
| `local`         | Auto-accepted when verification passes                       |
| `cross_cutting` | Auto-accepted with audit flag (human can reject)             |
| `architectural` | Requires explicit human acceptance record                    |

---

## Factory Invariants

### Artifact Integrity

**FI-1 — One completion per packet.**

**FI-2 — One acceptance per packet.**

**FI-3 — No agent acceptance or rejection.**
Only `human`, `cli`, or `ui` identities may author acceptance or rejection records.

**FI-4 — No acceptance without completion.**

### Acceptance Rules

**FI-5 — Architectural packets cannot auto-accept.**
Architectural dev packets require explicit human acceptance after their QA counterpart completes.

### Execution Governance

**FI-6 — No progression without completion.**
If a started packet lacks a completion record, no newer packet may have a completion.
Packets marked `abandoned` or `deferred` are exempt.

**FI-7 — Commit-time completion enforcement and reviewer separation.**
A commit must not include implementation files while any started packet lacks
a completion. Enforced by the pre-commit hook.
A QA packet must not be completed by the same identity that completed its dev counterpart.

### Structural Integrity

**FI-8 — Every dev packet in a feature must have a QA counterpart.**
For each dev packet in a feature, a QA packet with `verifies` pointing to that dev packet
must exist in the same feature. Abandoned/deferred packets are exempt.

**FI-9 — No cyclic packet dependencies.**
The dependency graph across all packets must be a DAG. Cycles cause permanent blocked state.

**FI-10 — Feature status must reflect reality.**
Features marked `completed` or `delivered` must have completion records for all
active (non-abandoned, non-deferred) packets.

### Schema Invariants (enforced at schema and validation levels)

- Packet `kind` must be `dev` or `qa`
- QA packets must set `verifies` to a valid dev packet ID
- Dev packets must not set `verifies`
- Packet and feature `acceptance_criteria` must be non-empty
- Packet IDs must match filenames (kebab-case)
- Feature `packets` must reference existing packet IDs
- Identity objects must have `kind` and `id` fields
- Orphaned completions, acceptances, and rejections are errors

---

## Tooling

When installed as a submodule at `.factory/`, tool paths use `.factory/tools/...`.
When working in the factory repo itself, use `tools/...` directly.

### Status

```sh
npx tsx .factory/tools/status.ts              # human-readable report
npx tsx .factory/tools/status.ts --json       # machine-readable JSON
npx tsx .factory/tools/status.ts --feature <id>  # scoped to a feature
```

### Start

```sh
npx tsx .factory/tools/start.ts <packet-id>
```

Claims a packet and marks it started before implementation begins.

### Complete

```sh
npx tsx .factory/tools/complete.ts <packet-id> [--summary "..."]
```

Runs verification (build, lint, test), then creates a completion record.

### Execute

```sh
npx tsx .factory/tools/execute.ts <feature-id>
npx tsx .factory/tools/execute.ts <feature-id> --json
```

Stateless action resolver for feature-level execution.

### Supervise

```sh
npx tsx .factory/tools/supervise.ts --init
npx tsx .factory/tools/supervise.ts --json
```

Supervisor tick loop for automated orchestration. In supervisor mode,
`execute_feature` returns stable dispatch records that act as the only legal
authorization for packet start/agent spawn.

### Validate

```sh
npx tsx .factory/tools/validate.ts
```

Schema validation + referential integrity + invariant enforcement.

### Derive

```sh
npx tsx .factory/tools/derive.ts              # print to stdout
npx tsx .factory/tools/derive.ts --write      # write to derived-state.json
```

---

## Features

Feature lifecycle:
```
draft → planned → approved → executing → completed → delivered
```

Execution protocol:
1. Run `npx tsx .factory/tools/execute.ts <feature-id>`
2. Spawn agents for ready packets using the assigned persona (developer/reviewer)
3. Each agent: run `start.ts` for its assigned packet → implement → complete → commit
4. Re-run execute
5. Repeat until all_complete
6. Natural flow per story: dev packet (developer) → QA packet (reviewer) → acceptance (human, if architectural)

If supervisor mode is enabled, packets must be returned by `supervise.ts` before they can be started.
Supervisor `execute_feature` actions now include stable dispatch records so an outer orchestrator
can treat them as the only legal packet authorizations for that tick.

### End-to-End Supervisor Flow

This is the intended automated flow when a human wants the factory to drive a feature
through developer and QA agents:

1. Human creates the feature JSON and dev/QA packet JSON files.
2. Human approves the feature (`status: "approved"`).
3. Initialize supervisor state once: `npx tsx .factory/tools/supervise.ts --init`
4. Supervisor agent runs `npx tsx .factory/tools/supervise.ts --json`
5. If the result is `execute_feature`, the supervisor spawns one agent per dispatch in `dispatches`
6. Each spawned agent runs the returned `start_command`, performs only that packet’s work, then runs `complete.ts`
7. QA agents use `--identity <qa-id>` and must satisfy any `environment_dependencies` evidence requirement
8. Supervisor re-runs `supervise.ts --json` after each state change
9. If the result is `escalate_acceptance`, the human runs `accept.ts` for the listed architectural packet(s)
10. Repeat until the supervisor returns `idle`

The key rule is that the outer orchestrator must never invent its own packet assignments.
It should only spawn agents from the current tick’s `dispatches`.

---

## Directory Structure

When installed in a host project as a git submodule:

```
.                            # Host project root
├── factory.config.json      # Project-specific configuration
├── CLAUDE.md                # AI instructions for the project
├── AGENTS.md                # Agent operating constraints
├── .factory/                # Factory submodule (hidden, tooling only)
│   ├── schemas/             # JSON schemas for all artifact types
│   ├── tools/               # Factory tooling
│   │   ├── config.ts        # Configuration loader
│   │   ├── validate.ts      # Schema + integrity validation
│   │   ├── status.ts        # Status & next action
│   │   ├── execute.ts       # Feature execution resolver
│   │   ├── complete.ts      # Completion record generator
│   │   ├── completion-gate.ts # Pre-commit FI-7 enforcement
│   │   ├── derive.ts        # State derivation
│   │   ├── migrate.ts       # Schema migration for existing artifacts
│   │   └── test/            # Tooling tests
│   ├── hooks/               # Git hooks
│   │   └── pre-commit       # Build + lint + gate + validate
│   ├── templates/           # Setup templates
│   ├── setup.sh             # Installation script
│   └── docs/
│       └── integration.md   # Detailed integration guide
├── factory/                 # Factory artifacts (visible, one directory)
│   ├── features/            # Feature-level intents
│   ├── packets/             # Work unit declarations
│   ├── completions/         # Implementation evidence
│   ├── acceptances/         # Human approval records
│   ├── rejections/          # Audit reversals
│   ├── evidence/            # Environment dependency proofs
│   └── supervisor/          # Supervisor state and memory
└── src/                     # Host project source (any language)
```

**Key separation:** Tooling lives in `.factory/` (hidden submodule).
Artifacts live in `factory/` (visible, single directory). The `factory_dir`
config field points to the tooling submodule, `artifact_dir` points to
the artifact directory. Tools resolve paths via `resolveArtifactRoot()`
and `resolveFactoryRoot()`.

---

## Installation

```sh
# From your project root
git submodule add https://github.com/custodyzero/factory.git .factory
./.factory/setup.sh
```

The setup script:
1. Installs factory dependencies (isolated in `.factory/node_modules/`)
2. Copies template `factory.config.json`, `CLAUDE.md`, and `AGENTS.md` to your project root (no-clobber)
3. Creates `factory/` directory with artifact subdirectories and supervisor files
4. Configures `git config core.hooksPath .factory/hooks`

See [`docs/integration.md`](docs/integration.md) for detailed integration guide.

---

## Licensing Commitment

Factory is open source under Apache 2.0 and will remain so permanently.

The Apache 2.0 license governs the source code. It does not grant
rights to use Factory brand assets. See the
[CustodyZero brand repository](https://github.com/custodyzero/brand)
for brand usage policy.

---

<p align="center">
  <a href="https://custodyzero.com">
    <img src="https://raw.githubusercontent.com/CustodyZero/brand/main/brand/custodyzero/wordmark/custodyzero-cz-dark.svg"
         alt="A CustodyZero product" width="160" />
  </a>
</p>
