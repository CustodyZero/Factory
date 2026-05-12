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
specs/<spec-id>.md → run.ts <spec-id> → plan → develop (with code review) → QA verify → done
```

**Human gate:** exactly one — authoring the spec. The factory derives the
intent artifact from the spec at run time. (Hand-authored
`intents/<id>.json` files are still accepted for backward compatibility.)

Everything after `run.ts` is autonomous.

When evolving **factory itself**, this repo uses the factory-development workflow
documented in [docs/decisions/workflow.md](/Users/andyhunter/repositories/custodyzero/factory/docs/decisions/workflow.md) with queue and memory state in
[docs/decisions/QUEUE.md](/Users/andyhunter/repositories/custodyzero/factory/docs/decisions/QUEUE.md) and
[docs/decisions/MEMORY.md](/Users/andyhunter/repositories/custodyzero/factory/docs/decisions/MEMORY.md).
`run.ts` is the pipeline entrypoint for host projects that consume factory; this repo
is deliberately not self-hosted by that pipeline.

> **Operator vs. agent.** Operators run one command: `run.ts <spec-id>`.
> The lifecycle scripts (`start`, `request-review`, `review`, `complete`)
> are the underlying protocol surface; in autonomous mode the pipeline
> calls them as library functions. They are also available as a manual
> surface for humans or self-driving agents who want to walk a single
> packet through its states by hand. See [Agent protocol](#agent-protocol)
> below.

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
        "command": "gh",
        "prefix_args": ["copilot", "--"],
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

| Provider | Command (+ prefix_args) | Notes |
|----------|---------|-------|
| `claude` | `claude` | Anthropic Claude Code CLI |
| `codex` | `codex` | OpenAI Codex CLI |
| `copilot` | `gh` + `prefix_args: ["copilot", "--"]` | GitHub Copilot CLI (multi-model via `model_map`) |

Each persona is mapped to a provider in `pipeline.persona_providers`.
Custom providers can be added — any CLI that accepts a prompt argument works.

---

## Pipeline Flow

The pipeline is the single entry point for all factory work:

```sh
npx tsx .factory/tools/run.ts <spec-id> [<spec-id>...]
```

`run.ts` accepts one or more spec IDs and drives the pipeline to completion
across all of them in dependency order. Internally:

1. **Plan** — Planner agent decomposes the spec into a feature with dev/qa packet pairs
2. **Develop** — For each dev packet (in dependency order):
   - Developer agent implements
   - Code reviewer agent reviews (different identity)
   - Feedback loop if changes requested (bounded by `max_review_iterations`)
   - Completion recorded (build/lint/test verification)
3. **Verify** — For each QA packet:
   - QA agent verifies (different identity from dev)
   - Completion recorded
4. **Done** — Feature marked complete, summary printed

The orchestrator is responsible for sequencing; agents are responsible for
implementation. `run.ts` calls the lifecycle scripts as library functions
to advance state. Agents call the same lifecycle scripts as CLIs to signal
state transitions back to the factory — see [Agent protocol](#agent-protocol).

### Idempotency

`run.ts` is idempotent. If the pipeline fails mid-execution, fix the issue
and re-run the same command. The pipeline derives its resume point from
artifact state on disk — completed packets are skipped, in-progress packets
resume from their current lifecycle status. The lifecycle scripts are
idempotent in the same way: re-invoking on a state that already satisfies
the request prints "already done" and exits 0.

### Identity Separation

- Developer and code reviewer use different identities
- QA agent uses a different identity from the developer (FI-7)
- Identities are configured in `pipeline.completion_identities`

---

## Your First Change

The operator workflow is: write a spec, run the pipeline.

### 1. Author a spec

Create `specs/add-health-endpoint.md`:

```markdown
---
id: add-health-endpoint
title: Add /health endpoint
---

# Health endpoint

Expose a `/health` endpoint so load balancers can verify the service is running.

## Acceptance

- `GET /health` returns 200 with `{ "status": "ok" }`
- Response time is under 50 ms
- Endpoint is covered by API tests
```

The body is markdown the planner reads. The frontmatter gives the factory
the metadata it needs to sequence work (`id`, `title`, optional
`depends_on`). See [Authoring specs](docs/integration.md#authoring-specs)
for the full guide.

### 2. Run the pipeline

```sh
npx tsx .factory/tools/run.ts add-health-endpoint
```

`run.ts`:

1. Translates `specs/add-health-endpoint.md` into
   `factory/intents/add-health-endpoint.json` (1:1, derived state)
2. Invokes the planner; the planner writes a feature artifact and
   matched dev/qa packet pairs
3. Invokes the developer agent, then the code reviewer, then runs
   build / lint / test verification and records the dev completion
4. Invokes the QA agent and records the QA completion (different
   identity from the developer per FI-7)
5. Marks the feature complete and prints a summary line (including
   total cost — see [Cost visibility](docs/integration.md#cost-visibility))

If anything fails, fix the issue and re-run the same command. The pipeline
is idempotent.

### 3. Commit

The pre-commit hook (FI-7) ensures every started packet has a completion
before commit. The factory artifacts (`specs/`, `factory/intents/`,
`factory/features/`, `factory/packets/`, `factory/completions/`) ride
alongside your implementation as the governance trail.

### Multi-spec runs

Pass multiple spec IDs to run them in dependency order:

```sh
npx tsx .factory/tools/run.ts spec-a spec-b spec-c
```

Topological order is computed from each spec's `depends_on` frontmatter.
Cycles are rejected at orchestrator entry. All transitive dependencies
must be passed explicitly — auto-resolution is out of scope.

### Backward compatibility: hand-authored intents

Existing `factory/intents/<intent-id>.json` files (with inline `spec` or
referenced `spec_path`) continue to work. `run.ts` accepts an intent ID
the same way it accepts a spec ID. New work should prefer specs because
markdown is easier to author and review than JSON.

**Approval gate.** For intent-driven runs the `status` field is the
human governance gate. `run.ts` accepts `approved`, `planned`, and
`delivered`; it rejects `proposed`, `superseded`, and any missing or
unknown value with a clear error pointing at the intent file.
`approved` is what an operator sets on first authoring; `planned` and
`delivered` are accepted so idempotent reruns of an intent that
already progressed past planning continue to work. See [Artifact
Types → Intent](#intent) below for the full per-status semantics.
Spec-driven runs do NOT consult the derived intent's `status`;
authoring the spec at `specs/<id>.md` IS the gate.

The two intent shapes still supported during the transition:

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
  "status": "approved",
  "feature_id": null,
  "created_by": { "kind": "human", "id": "alice" },
  "created_at": "2025-01-15T09:00:00Z"
}
```

**Referenced spec** — for long, human-authored Markdown specs that already
live in `docs/specs/`:

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
  "status": "approved",
  "feature_id": null,
  "created_by": { "kind": "human", "id": "alice" },
  "created_at": "2026-04-11T09:00:00Z"
}
```

`spec_path` is resolved relative to the project root, must be relative,
must not escape the project root, must point to an existing non-empty
file, and is mutually exclusive with `spec`. `validate.ts` enforces these
rules; `plan.ts` reads the file at plan time and hands its full contents
to the planner.

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
- `status` — `proposed`, `approved`, `planned`, `delivered`, or `superseded`
- `created_by` — who created the intent
- `created_at` — ISO 8601 timestamp

Status semantics by run-input source:

- **Spec-driven runs** (`run.ts <spec-id>`): the orchestrator
  generates the intent with `status: "proposed"`. That value is a
  generator-set artifact, NOT a governance signal — the spec
  authoring is the approval. `run.ts` accepts it and continues.
- **Intent-driven runs** (`run.ts <intent-id>`, hand-authored
  intents): `run.ts` checks the status field as a governance gate.
  - `approved` — grants run authority. This is what an operator
    sets when hand-authoring an intent for the first time.
  - `planned` / `delivered` — accepted for idempotent reruns of
    intents that already progressed past the plan phase.
  - `proposed` — REJECTED with an actionable error (the operator
    must edit the file and set `status: "approved"`).
  - `superseded` — REJECTED; the intent is terminal.
  - missing / unknown — REJECTED.

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
Human authors spec → run.ts plans, develops, reviews, verifies → done
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

### Operator commands

The factory has three commands operators run.

#### Run (Pipeline)

```sh
npx tsx .factory/tools/run.ts <spec-id> [<spec-id>...]
```

Single-command pipeline. Plans each spec, executes dev packets with code
review, runs QA verification, marks each feature complete. Idempotent —
safe to re-run after failures. Accepts intent IDs for backward
compatibility with hand-authored intents.

#### Status

```sh
npx tsx .factory/tools/status.ts              # human-readable report
npx tsx .factory/tools/status.ts --json       # machine-readable JSON
npx tsx .factory/tools/status.ts --feature <id>  # scoped to a feature
```

#### Validate

```sh
npx tsx .factory/tools/validate.ts
```

Schema validation + referential integrity + invariant enforcement.

### Agent protocol

The lifecycle scripts below are the protocol surface for moving a
packet through its states. The same scripts back two modes:

- **Autonomous mode** — `run.ts <spec-id>`. The orchestrator calls
  `start`, `request-review`, and `complete` as library functions while
  driving the develop / verify phases. Agents perform the *work* but
  do **not** invoke those three CLIs themselves; the prompts the
  factory ships explicitly say so. `review.ts` is the one exception
  — the code reviewer calls it to record its verdict, because that's
  how the pipeline learns approve vs. request-changes.
- **Manual mode** — humans (or self-driving agents) invoke the
  lifecycle CLIs directly to walk a packet through its states. This
  is the back-compat surface and the way to drive a stuck packet
  forward when the autonomous run bailed out.

All four lifecycle scripts are idempotent — re-invocation on the same
state is a no-op.

#### Start

```sh
npx tsx .factory/tools/start.ts <packet-id>
```

Claims a packet and marks it started before implementation begins.

#### Request Review

```sh
npx tsx .factory/tools/request-review.ts <packet-id>
npx tsx .factory/tools/request-review.ts <packet-id> --branch <branch-name>
```

Transitions a dev packet from `implementing` (or `changes_requested`) to
`review_requested`. Captures the current git branch (or uses `--branch`
override) and sets the `branch` field on the packet. Increments
`review_iteration` on re-requests after `changes_requested`.

#### Review

```sh
npx tsx .factory/tools/review.ts <packet-id> --approve
npx tsx .factory/tools/review.ts <packet-id> --request-changes
```

Records a code review decision on a dev packet in `review_requested`
status. `--approve` transitions to `review_approved` (developer can now
call `complete.ts`). `--request-changes` transitions to
`changes_requested` (developer addresses feedback, then calls
`request-review.ts` again). Review feedback lives in git (branch diffs,
git notes) — not in factory artifacts.

#### Complete

```sh
npx tsx .factory/tools/complete.ts <packet-id> [--summary "..."]
```

Runs verification (build, lint, test), then creates a completion record.
Dev packets must be in `review_approved` status before completion.

#### Execute

```sh
npx tsx .factory/tools/execute.ts <feature-id>
npx tsx .factory/tools/execute.ts <feature-id> --json
```

Stateless action resolver for feature-level execution. Used by agents
under manual control or by `run.ts` when driving the develop/verify phases.

#### Plan

```sh
npx tsx .factory/tools/plan.ts <spec-or-intent-id>
npx tsx .factory/tools/plan.ts <spec-or-intent-id> --json
```

Planner handoff resolver. Reads a spec or intent artifact and tells the
planner whether it needs to decompose work, wait for approval, or hand
off to the pipeline.

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

Operator path:
1. Author `specs/<spec-id>.md`
2. Run `npx tsx .factory/tools/run.ts <spec-id>` — drives plan, develop, review, verify, done

Agent path inside a run (managed by `run.ts`, not the operator):
- Dev agent: `start.ts` → implement → `request-review.ts` → code_reviewer runs `review.ts --approve` → `complete.ts`
- QA agent: `start.ts` → verify → `complete.ts`
- Natural flow per story: dev packet (developer ↔ code_reviewer loop) → QA packet (qa)

### End-to-End Pipeline Flow

The full factory-native flow runs autonomously from spec to completed feature:

1. Human authors `specs/<spec-id>.md` (preferred) or, for backward compatibility, `factory/intents/<intent-id>.json` (with `spec` or `spec_path`)
2. Run `npx tsx .factory/tools/run.ts <spec-id> [<spec-id>...]`
3. **Plan phase** — orchestrator translates spec → intent (1:1) and invokes the planner; the planner writes:
   - one `factory/features/<feature-id>.json` artifact with `status: "planned"`
   - dev/qa packet pairs in `factory/packets/`
   - packet dependencies, change classes, and acceptance criteria
   - `feature.intent_id` linkage
4. **Develop phase** — for each dev packet (in dependency order):
   - Developer agent implements and signals via `request-review.ts`
   - Code reviewer agent calls `review.ts --approve` or `--request-changes`
   - On `--request-changes`, developer reworks; loop bounded by `max_review_iterations`
   - On approval, completion is recorded with the developer's identity
5. **Verify phase** — for each QA packet:
   - QA agent verifies (distinct identity from dev — FI-7)
   - Completion is recorded with the QA identity
6. **Done** — feature marked complete, summary printed (with total cost where reportable)

Pipeline properties:
- **Idempotent** — re-running resumes from artifact state on disk
- **Provider-agnostic** — codex, claude, copilot (configure via `pipeline.providers`)
- **Failover-aware** — `persona_providers` accepts an ordered list for cross-CLI failover; abstraction providers may declare within-CLI `model_failover` (see [Provider failover](docs/integration.md#provider-failover))
- **Recovery-aware** — known failure scenarios are auto-recovered with bounded retries; lint/test failures always escalate (see [Recovery](docs/integration.md#recovery))
- **Cost-visible** — every run reports total cost; configurable caps at run/packet/per-day scope (see [Cost visibility](docs/integration.md#cost-visibility))
- **Observable** — typed events stream to `factory/events/<run-id>.jsonl` (see [Event observability](docs/integration.md#event-observability))
- **No human gates after spec authoring** — completion IS acceptance
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
├── specs/                   # Human-authored specs (markdown + frontmatter)
├── factory/                 # Factory artifacts (visible, one directory)
│   ├── intents/             # Derived from specs (or hand-authored back-compat)
│   ├── features/            # Planned execution units
│   ├── packets/             # Work unit declarations
│   ├── completions/         # Implementation evidence
│   ├── events/              # Per-run event streams (JSONL)
│   ├── cost/                # Per-invocation cost records
│   └── escalations/         # Structured failure records when recovery escalates
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
