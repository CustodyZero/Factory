<p align="center">
  <img src="https://raw.githubusercontent.com/CustodyZero/brand/main/brand/factory/wordmark/factory-wordmark-green.svg"
       alt="Factory" width="200" />
</p>

A change-control system for governed AI-assisted development.

The factory enforces that all work is scoped, intentional, and verified
through an automated pipeline before it is considered done.

It is not a project management tool. It is a **governance artifact store**
with a single-command pipeline that plans, implements, reviews, and verifies.

---

## Why

AI agents can implement code. They cannot judge whether a change is safe
to ship. The factory separates intent (which humans define) from execution
(which agents perform autonomously).

Every change must declare its intent and scope before implementation
begins. Verification (build, lint, test) gates every completion.

The factory flow:

```
intent/spec → run.ts → plan → develop (with code review) → QA verify → done
```

**Human gates:** exactly two.
1. Approve the spec (write the markdown document)
2. Approve the intent (create the intent artifact with constraints)

Everything after `run.ts` is autonomous.

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
      "model": "high"
    },
    "developer": {
      "description": "Implements the change",
      "instructions": [],
      "model": "high"
    },
    "code_reviewer": {
      "description": "Reviews code changes for correctness, design, and contract adherence",
      "instructions": [],
      "model": "medium"
    },
    "qa": {
      "description": "Verifies acceptance criteria are met",
      "instructions": [],
      "model": "medium"
    }
  },
  "pipeline": {
    "providers": {
      "codex": {
        "enabled": true,
        "command": "codex",
        "sandbox": "workspace-write"
      },
      "claude": {
        "enabled": true,
        "command": "claude",
        "permission_mode": "bypassPermissions"
      },
      "copilot": {
        "enabled": false,
        "command": "gh copilot --",
        "model_map": {
          "high": "claude-opus-4-6",
          "medium": "GPT-5.4",
          "low": "claude-haiku-4-5"
        }
      }
    },
    "persona_providers": {
      "planner": "claude",
      "developer": "codex",
      "code_reviewer": "claude",
      "qa": "claude"
    },
    "completion_identities": {
      "developer": "codex-dev",
      "code_reviewer": "claude-cr",
      "qa": "claude-qa"
    },
    "max_review_iterations": 3
  }
}
```

### Model Tiers

Personas declare a **model tier** — `high`, `medium`, or `low` — representing
the desired capability level. These are provider-neutral. Each provider
translates tiers to concrete model IDs via its `model_map`. If no `model_map`
is configured, the provider's default model is used.

### Providers

The pipeline supports multiple agent CLI providers:

| Provider | Command | Notes |
|----------|---------|-------|
| `claude` | `claude` | Anthropic Claude Code CLI |
| `codex` | `codex` | OpenAI Codex CLI |
| `copilot` | `gh copilot --` | GitHub Copilot CLI (multi-model via `model_map`) |

Each persona is mapped to a provider in `pipeline.persona_providers`.
Custom providers can be added — any CLI that accepts a prompt argument works.

---

## Pipeline Flow

The pipeline is the single entry point for all factory work:

1. Human creates an intent/spec artifact in `intents/`
2. Planner agent runs `tools/plan.ts <intent-id>` (or run the full pipeline with `tools/run.ts <intent-id>`)
3. Planner writes one planned feature plus dev/qa packet pairs
4. The pipeline runner picks up the planned feature and drives execution to completion

The planner and pipeline runner are intentionally separate:
- planner decomposes work into artifacts
- pipeline runner executes the artifacts deterministically

1. **Plan** — Planner agent decomposes the spec/intent into a feature with dev/qa packet pairs
2. **Develop** — For each dev packet (in dependency order):
   - Developer agent implements
   - Code reviewer agent reviews (different identity)
   - Feedback loop if changes requested (bounded by `max_review_iterations`)
   - Completion recorded (build/lint/test verification)
3. **Verify** — For each QA packet:
   - QA agent verifies (different identity from dev)
   - Completion recorded
4. **Done** — Feature marked complete, summary printed

### Idempotency

`run.ts` is idempotent. If the pipeline fails mid-execution, fix the issue
and re-run the same command. The pipeline derives its resume point from
artifact state on disk — completed packets are skipped, in-progress packets
resume from their current lifecycle status.

### Identity Separation

- Developer and code reviewer use different identities
- QA agent uses a different identity from the developer (FI-7)
- Identities are configured in `pipeline.completion_identities`

---

## Your First Change

Factory has no `create` command — intent, feature, and packet artifacts are JSON
files you write by hand (or have an AI agent write). The pipeline flow above
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

### 6. Run the QA packet

The QA packet is now unblocked (its dependency is complete). A different
agent or human reviews the dev work against the acceptance criteria, then:

```sh
npx tsx .factory/tools/start.ts add-health-endpoint-qa
npx tsx .factory/tools/complete.ts add-health-endpoint-qa --identity claude-qa
```

The `--identity` flag ensures the QA completion is attributed to a different
identity than the dev completion (FI-7).

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
  "status": "planned",
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
live in the repository:

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

Then run the pipeline:

```sh
npx tsx .factory/tools/run.ts customer-dashboard
```

---

## Artifact Types

The factory has four artifact types. Each is a JSON file validated against
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
- `spec` (or `spec_path`) — planner input describing the desired system behavior or change
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

Optional fields:
- `started_at` — when work began (normally set by `tools/start.ts`)
- `status` — lifecycle status (see above)
- `branch` — git branch name for code review (set by `request-review.ts`)
- `review_iteration` — number of review round-trips completed (default 0)
- `dependencies` — packet IDs that must be completed first
- `model` — model tier override (`high`, `medium`, `low`)
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

### Feature

A planned execution unit that decomposes into dev/qa packet pairs.

```
features/<feature-id>.json
```

Required fields:
- `id` — kebab-case identifier (must match filename)
- `intent` — what the project should do when this feature is complete
- `acceptance_criteria` — feature-level success conditions
- `status` — `planned`, `executing`, `completed`, `delivered`
- `packets` — ordered list of packet IDs (dev and qa)
- `created_by` — identity

---

## Lifecycle

### Pipeline lifecycle (preferred)

```
Human writes intent → run.ts plans, develops, reviews, verifies → done
```

### Manual packet lifecycle

```
not_started → in_progress → completed
```

A packet moves through states based on which artifacts exist:

| State         | Condition                           |
|---------------|-------------------------------------|
| `not_started` | No completion, `started_at` is null |
| `in_progress` | No completion, `started_at` is set  |
| `completed`   | Completion record exists            |

---

## Factory Invariants

**FI-1 — One completion per packet.**

**FI-4 — Completion requires verification.**
Build, lint, and test must have been run before a completion is recorded.

**FI-7 — Commit-time completion enforcement and identity separation.**
A commit must not include implementation files while any started packet lacks
a completion. Enforced by the pre-commit hook.
A QA packet must not be completed by the same identity that completed its dev counterpart.

**FI-8 — Every dev packet in a feature must have a QA counterpart.**
For each dev packet in a feature, a QA packet with `verifies` pointing to that dev packet
must exist in the same feature. Abandoned/deferred packets are exempt.

**FI-9 — No cyclic packet dependencies.**
The dependency graph across all packets must be a DAG. Cycles cause permanent blocked state.

### Schema Invariants (enforced at schema and validation levels)

- Packet `kind` must be `dev` or `qa`
- QA packets must set `verifies` to a valid dev packet ID
- Dev packets must not set `verifies`
- Packet and feature `acceptance_criteria` must be non-empty
- Packet IDs must match filenames (kebab-case)
- Feature `packets` must reference existing packet IDs
- Identity objects must have `kind` and `id` fields
- Orphaned completions are errors

---

## Tooling

When installed as a submodule at `.factory/`, tool paths use `.factory/tools/...`.
When working in the factory repo itself, use `tools/...` directly.

### Run (Pipeline)

```sh
npx tsx .factory/tools/run.ts <intent-id>
```

Single-command pipeline. Plans the intent, executes dev packets with code review,
runs QA verification, marks the feature complete. Idempotent — safe to re-run
after failures.

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
Dev packets must be in `review_approved` status before completion.

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
whether it needs to decompose work, wait for approval, or hand off to the pipeline.

### Validate

```sh
npx tsx .factory/tools/validate.ts
```

Schema validation + referential integrity + invariant enforcement.

---

## Features

Feature lifecycle:
```
planned → executing → completed → delivered
```

Packet lifecycle:
```
Dev packets:  draft → ready → implementing → review_requested → changes_requested → review_approved → completed
QA packets:   draft → ready → implementing → completed
```

Execution protocol:
1. Run `npx tsx .factory/tools/run.ts <intent-id>` (preferred — runs everything)
2. Or manually: run `execute.ts <feature-id>` to get the work list
3. Dev agent: `start.ts` → implement → `request-review.ts` → code_reviewer runs `review.ts --approve` → `complete.ts`
4. QA agent: `start.ts` → verify → `complete.ts`
5. Re-run execute
6. Repeat until all_complete
7. Natural flow per story: dev packet (developer ↔ code_reviewer loop) → QA packet (qa)

### End-to-End Pipeline Flow

The full factory-native flow runs autonomously from intent to completed feature:

1. Human writes `intents/<intent-id>.json` (with `spec` or `spec_path`)
2. Run `npx tsx .factory/tools/run.ts <intent-id>`
3. **Plan phase** — planner agent writes:
   - one `features/<feature-id>.json` artifact with `status: "planned"`
   - dev/qa packet pairs in `packets/`
   - packet dependencies, change classes, and acceptance criteria
   - `feature.intent_id` linkage
4. **Develop phase** — for each dev packet (in dependency order):
   - Developer agent implements and signals `request-review.ts`
   - Code reviewer agent runs `review.ts --approve` or `--request-changes`
   - On `--request-changes`, developer reworks; loop bounded by `max_review_iterations`
   - On approval, completion is recorded with the developer's identity
5. **Verify phase** — for each QA packet:
   - QA agent verifies (distinct identity from dev — FI-7)
   - Completion is recorded with the QA identity
6. **Done** — feature marked complete, summary printed

Pipeline properties:
- **Idempotent** — re-running resumes from artifact state on disk
- **Provider-agnostic** — codex, claude, copilot (configure via `pipeline.providers`)
- **No human gates after intent approval** — completion IS acceptance
- **Bounded review** — `max_review_iterations` (default 3) caps rework cycles

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
│   │   ├── run.ts           # Pipeline entry point
│   │   ├── validate.ts      # Schema + integrity validation
│   │   ├── status.ts        # Status & next action
│   │   ├── plan.ts          # Planner handoff resolver
│   │   ├── execute.ts       # Feature execution resolver
│   │   ├── start.ts         # Packet claim command
│   │   ├── complete.ts      # Completion record generator
│   │   ├── request-review.ts # Code review request
│   │   ├── review.ts        # Code review decision
│   │   ├── completion-gate.ts # Pre-commit FI-7 enforcement
│   │   ├── output.ts        # Terminal output formatting
│   │   └── test/            # Tooling tests
│   ├── hooks/               # Git hooks
│   │   └── pre-commit       # Completion gate + validate
│   ├── templates/           # Setup templates
│   ├── setup.sh             # Installation script (Linux/macOS)
│   ├── setup.ps1            # Installation script (Windows)
│   └── docs/
│       └── integration.md   # Detailed integration guide
├── factory/                 # Factory artifacts (visible, one directory)
│   ├── intents/             # Planner input specs
│   ├── features/            # Planned execution units
│   ├── packets/             # Work unit declarations
│   └── completions/         # Implementation evidence
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
3. Creates `factory/` directory with artifact subdirectories
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
