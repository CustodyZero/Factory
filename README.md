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

The native factory flow is:

`intent/spec -> planner -> feature + dev/qa packets -> human approval -> supervisor -> developer/code_reviewer/qa agents -> acceptance -> delivery`

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
  },
  "personas": {
    "planner": {
      "description": "Decomposes intent into feature and packet artifacts",
      "instructions": [],
      "model": "opus"
    },
    "developer": {
      "description": "Implements the change",
      "instructions": [],
      "model": "opus"
    },
    "code_reviewer": {
      "description": "Reviews code changes for correctness, design, and contract adherence",
      "instructions": [],
      "model": "sonnet"
    },
    "qa": {
      "description": "Verifies acceptance criteria are met",
      "instructions": [],
      "model": "sonnet"
    }
  },
  "orchestrator": {
    "enabled": true,
    "identity": {
      "kind": "agent",
      "id": "orchestrator"
    },
    "output_dir": "reports/orchestrator",
    "recent_run_limit": 25,
    "recent_attempt_limit": 50,
    "completion_identities": {
      "developer": "codex-dev",
      "code_reviewer": "claude-cr",
      "qa": "claude-qa"
    },
    "personas": {
      "planner": "claude",
      "developer": "codex",
      "code_reviewer": "claude",
      "qa": "claude"
    },
    "providers": {
      "codex": {
        "enabled": true,
        "command": "codex",
        "sandbox": "workspace-write",
        "models": {
          "opus": "gpt-5.4",
          "sonnet": "gpt-5.4-mini",
          "haiku": "gpt-5.4-mini"
        }
      },
      "claude": {
        "enabled": true,
        "command": "claude",
        "permission_mode": "bypassPermissions",
        "models": {
          "opus": "opus",
          "sonnet": "sonnet",
          "haiku": "haiku"
        }
      }
    },
    "retries": {
      "max_supervisor_ticks": 50,
      "planner": [
        { "provider": "claude", "model": "sonnet" },
        { "provider": "claude", "model": "opus" },
        { "provider": "codex", "model": "opus" }
      ],
      "developer": [
        { "provider": "codex", "model": "sonnet" },
        { "provider": "codex", "model": "opus" },
        { "provider": "claude", "model": "sonnet" },
        { "provider": "claude", "model": "opus" }
      ],
      "code_reviewer": [
        { "provider": "claude", "model": "sonnet" },
        { "provider": "claude", "model": "opus" },
        { "provider": "codex", "model": "opus" }
      ],
      "qa": [
        { "provider": "claude", "model": "sonnet" },
        { "provider": "claude", "model": "opus" },
        { "provider": "codex", "model": "opus" }
      ]
    }
  }
}
```

---

## Planner-Native Flow

Factory now has a first-class planning layer. The preferred flow is:

1. Human creates an intent/spec artifact in `intents/`
2. Planner agent runs `tools/plan.ts <intent-id>`
3. Planner writes one planned feature plus dev/qa packet pairs
4. Human reviews and approves the feature
5. Supervisor executes only approved packet work

The planner and supervisor are intentionally separate:
- planner decomposes work into artifacts
- supervisor executes approved artifacts deterministically

The native deterministic orchestrator sits beside those actors:
- planner decides decomposition
- supervisor decides legal execution
- orchestrator invokes `codex` and `claude` through fixed shell contracts

`gemini` is intentionally not part of the native harness. Use it manually if needed.

## Your First Change

Factory has no `create` command — intent, feature, and packet artifacts are JSON
files you write by hand (or have an AI agent write). The planner-native flow above
is the preferred path. The walkthrough below shows the lower-level direct packet flow.

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

Claim the packet to mark work as in progress, write the code,
then request code review:

```sh
npx tsx .factory/tools/start.ts add-health-endpoint-dev
# ... implement the change ...
npx tsx .factory/tools/request-review.ts add-health-endpoint-dev
```

### 5. Code review

A code reviewer (different agent or human) reviews the branch and approves:

```sh
npx tsx .factory/tools/review.ts add-health-endpoint-dev --approve
```

If changes are needed, `--request-changes` sends it back to the developer.
After approval, run completion:

```sh
npx tsx .factory/tools/complete.ts add-health-endpoint-dev
```

This runs build + lint + tests and writes `factory/completions/add-health-endpoint-dev.json`.
Since the change class is `local`, it auto-accepts.

### 6. Run the QA packet

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

### 7. Commit

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

### Using intents for planner-native work

For planner-driven work, start with an intent artifact. Intents come in two
shapes, depending on how large the spec is.

**Inline spec** — for short, self-contained intents:

```json
// factory/intents/customer-dashboard.json
{
  "id": "customer-dashboard",
  "title": "Customer dashboard",
  "spec": "Provide a dashboard where users can view account activity and billing status.",
  "constraints": [
    "Preserve the existing public API",
    "Split work into auditable dev/qa packet pairs"
  ],
  "status": "proposed",
  "feature_id": null,
  "created_by": { "kind": "human", "id": "alice" },
  "created_at": "2025-01-15T09:00:00Z"
}
```

**Referenced spec** — for large, human-authored Markdown specs that already
live in the repository (architectural specs with sections, tables, diagrams,
phasing plans, alternatives, etc.):

```json
// factory/intents/016-platform-targets.json
{
  "id": "016-platform-targets",
  "title": "Platform Targets & Application Layer",
  "spec_path": "docs/specs/016-platform-targets-and-application-layer.md",
  "constraints": [
    "Architectural change — must be phased per the spec",
    "Preserve all invariants listed in the spec's §7"
  ],
  "status": "proposed",
  "feature_id": null,
  "created_by": { "kind": "human", "id": "alice" },
  "created_at": "2026-04-11T09:00:00Z"
}
```

`spec_path` is resolved relative to the **project root** (not the artifact
root). At plan time, the factory reads the referenced file and hands its
full contents to the planner. This lets you keep large specs as Markdown
in `docs/specs/` — structured, reviewable, and diff-friendly — instead of
stuffing them into a JSON string.

Rules for `spec_path`:
- Must be relative (no absolute paths) and must not escape the project root
- Must point to an existing, non-empty file
- Mutually exclusive with `spec` — use exactly one
- Validated at `validate.ts` time so a broken reference fails CI, not at
  plan time

Then run the planner handoff resolver:

```sh
npx tsx .factory/tools/plan.ts customer-dashboard
```

`plan.ts` returns the planner persona, model, and instructions for generating:
- one planned feature artifact
- dev/qa packet pairs
- dependencies and change classes
- explicit acceptance criteria

---

## Artifact Types

The factory has seven artifact types. Each is a JSON file validated against
a schema in `.factory/schemas/` (or `schemas/` when working in the factory
repo itself).

All artifact paths below are relative to the artifact root. In submodule
installs this is `factory/` (e.g., `factory/packets/my-packet.json`). When
factory is the project, this is the repo root.

### Intent

A high-level spec or problem statement that the planner decomposes into a feature
and dev/qa packet pairs.

```
intents/<intent-id>.json
```

Required fields:
- `id` — kebab-case identifier (must match filename)
- `title` — one-line summary of the requested outcome
- `spec` — planner input describing the desired system behavior or change
- `status` — `proposed`, `planned`, `superseded`, or `delivered`
- `created_by` — who created the intent
- `created_at` — ISO 8601 timestamp

Optional fields:
- `constraints` — planner constraints or non-goals
- `feature_id` — generated feature linked to this intent
- `planned_at` — when planning completed

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

Lifecycle status (dev packets):
```
draft → ready → implementing → review_requested → changes_requested → review_approved → completed
```
Review states (`review_requested`, `changes_requested`, `review_approved`) apply only to dev packets.
QA packets follow: `draft → ready → implementing → completed`.
Legacy packets with `null` status are grandfathered — their state is derived from `started_at` and completion records.

Optional fields:
- `started_at` — when work began (normally set by `tools/start.ts`)
- `status` — lifecycle status (see above). `null` for legacy packets. Also accepts `abandoned` or `deferred`.
- `branch` — git branch name for code review (set by `request-review.ts`)
- `review_iteration` — number of review round-trips completed (incremented on each re-request after `changes_requested`, default 0)
- `dependencies` — packet IDs that must be completed first
- `environment_dependencies` — external dependencies requiring evidence
- `model` — model tier override (`opus`, `sonnet`, `haiku`)
- `instructions` — additional agent instructions (merged with persona instructions)
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

**FI-7 — Commit-time completion enforcement and identity separation.**
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

### Request Review

```sh
npx tsx .factory/tools/request-review.ts <packet-id>
npx tsx .factory/tools/request-review.ts <packet-id> --branch <branch-name>
```

Transitions a dev packet from `implementing` (or `changes_requested`) to `review_requested`.
Captures the current git branch (or uses `--branch` override) and sets the `branch` field
on the packet. Increments `review_iteration` on re-requests after `changes_requested`.

### Review

```sh
npx tsx .factory/tools/review.ts <packet-id> --approve
npx tsx .factory/tools/review.ts <packet-id> --request-changes
```

Records a code review decision on a dev packet in `review_requested` status.
`--approve` transitions to `review_approved` (developer can now call `complete.ts`).
`--request-changes` transitions to `changes_requested` (developer addresses feedback,
then calls `request-review.ts` again).

Review feedback lives in git (branch diffs, git notes) — not in factory artifacts.

### Complete

```sh
npx tsx .factory/tools/complete.ts <packet-id> [--summary "..."]
```

Runs verification (build, lint, test), then creates a completion record.
Dev packets must be in `review_approved` status before completion (legacy `null`-status
packets are grandfathered).

### Execute

```sh
npx tsx .factory/tools/execute.ts <feature-id>
npx tsx .factory/tools/execute.ts <feature-id> --json
```

Stateless action resolver for feature-level execution.

### Plan

```sh
npx tsx .factory/tools/plan.ts <intent-id>
npx tsx .factory/tools/plan.ts <intent-id> --json
```

Planner handoff resolver. Reads an intent/spec artifact and tells the planner
whether it needs to decompose work, wait for approval, or hand off to the supervisor.

### Supervise

```sh
npx tsx .factory/tools/supervise.ts --init
npx tsx .factory/tools/supervise.ts --json
```

Supervisor tick loop for automated orchestration. In supervisor mode,
`execute_feature` returns stable dispatch records that act as the only legal
authorization for packet start/agent spawn.

### Orchestrate

```sh
npx tsx .factory/tools/orchestrate.ts health
npx tsx .factory/tools/orchestrate.ts health --probe
npx tsx .factory/tools/orchestrate.ts plan <intent-id>
npx tsx .factory/tools/orchestrate.ts supervise
npx tsx .factory/tools/orchestrate.ts run
npx tsx .factory/tools/orchestrate.ts run --intent <intent-id>
```

Deterministic shell harness for native orchestration. It consumes `plan.ts`
and `supervise.ts`, invokes supported LLM CLIs, and stores bounded runtime
state in `supervisor/orchestrator-state.json`.
`run` is the autonomous mode: it initializes supervisor state when needed,
re-ticks after `update_state`, retries planner and packet execution through
the configured provider/model ladder, and stops only at `idle`, `awaiting_approval`,
or a real blocking/escalation gate.

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

Packet lifecycle:
```
Dev packets:  draft → ready → implementing → review_requested → changes_requested → review_approved → completed
QA packets:   draft → ready → implementing → completed
```

Execution protocol:
1. Run `npx tsx .factory/tools/execute.ts <feature-id>`
2. Spawn agents for ready packets using the assigned persona (developer/code_reviewer/qa)
3. Dev agent: `start.ts` → implement → `request-review.ts` → code_reviewer runs `review.ts --approve` → `complete.ts`
4. QA agent: `start.ts` → verify → `complete.ts`
5. Re-run execute
6. Repeat until all_complete
7. Natural flow per story: dev packet (developer ↔ code_reviewer loop) → QA packet (qa) → acceptance (human, if architectural)

If supervisor mode is enabled, packets must be returned by `supervise.ts` before they can be started.
Supervisor `execute_feature` actions now include stable dispatch records so an outer orchestrator
can treat them as the only legal packet authorizations for that tick.

### End-to-End Supervisor Flow

This is the intended automated flow when a human wants the factory to drive a feature
through developer and QA agents:

1. Human creates the feature JSON and dev/QA packet JSON files.
2. Human approves the feature (`status: "approved"`).
3. Preferred native option: run `npx tsx .factory/tools/orchestrate.ts run`
4. Manual option: initialize supervisor state once with `npx tsx .factory/tools/supervise.ts --init`, then run `npx tsx .factory/tools/supervise.ts --json`
5. If the result is `execute_feature`, the orchestrator or external runner spawns one agent per dispatch in `dispatches`
6. Each spawned agent runs the returned `start_command`, performs only that packet’s work, then runs `complete.ts`
7. QA agents use a distinct qa identity and must satisfy any `environment_dependencies` evidence requirement
8. The native orchestrator retries failed planner and packet runs using the configured Codex/Claude ladder before surfacing failure
9. Supervisor re-runs `supervise.ts --json` after each state change
10. If the result is `escalate_acceptance`, the human runs `accept.ts` for the listed architectural packet(s)
11. Repeat until the supervisor returns `idle`

The key rule is that the outer orchestrator must never invent its own packet assignments.
It should only spawn agents from the current tick’s `dispatches`.
A single `execute_feature` action may contain dispatches for multiple independent features.

### End-to-End Planner + Supervisor Flow

This is the full factory-native flow with planning and execution separated:

1. Human writes `intents/<intent-id>.json`
2. Planner agent runs `npx tsx .factory/tools/plan.ts <intent-id> --json`
3. If the action is `plan_feature`, the planner writes:
   - one `features/<feature-id>.json` artifact with `status: "planned"`
   - dev/qa packet pairs in `packets/`
   - packet dependencies, change classes, and acceptance criteria
   - `feature.intent_id` and `intent.feature_id` linkage
4. Human reviews the planned feature and packet set
5. Human sets the feature status to `approved`
6. Preferred native option: run `npx tsx .factory/tools/orchestrate.ts run --intent <intent-id>`
7. The orchestrator invokes the planner if needed, then stops at human approval
8. After approval, rerun `npx tsx .factory/tools/orchestrate.ts run --intent <intent-id>` to enter supervised execution
9. Supervisor dispatches only approved packet work, potentially across multiple independent features in the same tick
10. Developer and qa agents execute packets exactly as assigned
11. Human handles architectural acceptance when escalated
12. Delivery occurs when the approved feature completes and the intent can be considered delivered

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
│   │   ├── plan.ts          # Planner handoff resolver
│   │   ├── execute.ts       # Feature execution resolver
│   │   ├── orchestrate.ts   # Deterministic Codex/Claude shell harness
│   │   ├── start.ts         # Packet claim command
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
│   ├── intents/             # Planner input specs
│   ├── features/            # Planned execution units
│   ├── packets/             # Work unit declarations
│   ├── completions/         # Implementation evidence
│   ├── acceptances/         # Human approval records
│   ├── rejections/          # Audit reversals
│   ├── evidence/            # Environment dependency proofs
│   ├── reports/             # Orchestrator output capture
│   └── supervisor/          # Supervisor state, orchestrator cache, and memory
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
