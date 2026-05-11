# Integration Guide

How to add the factory to an existing project.

---

## Quick Setup

```sh
# From your project root
git submodule add https://github.com/custodyzero/factory.git .factory
./.factory/setup.sh
```

The setup script:

1. Installs factory dependencies (isolated in `.factory/node_modules/`)
2. Copies template files to your project root (no-clobber):
   - `factory.config.json` — project configuration
   - `CLAUDE.md` — AI agent instructions
   - `AGENTS.md` — agent operating constraints
3. Creates `factory/` directory with artifact subdirectories:
   - `factory/intents/`, `factory/features/`, `factory/packets/`, `factory/completions/`
4. Configures `git config core.hooksPath .factory/hooks`

After setup, the normal workflow is:

1. Author a spec at `specs/<spec-id>.md` (see [Authoring specs](#authoring-specs))
2. Run the full pipeline: `npx tsx .factory/tools/run.ts <spec-id>`
3. The pipeline plans, develops, reviews, and verifies — autonomously to completion
4. Re-run the same command to resume if anything failed (the pipeline is idempotent)

### Two operating modes

The factory exposes two ways to drive packets through their lifecycle:

- **Autonomous mode** — `run.ts <spec-id>`. The pipeline calls the
  lifecycle library functions to advance state. Agents perform the
  *work* (write code, review it, verify it) but do **not** call the
  lifecycle CLIs themselves to signal start / request-review / complete.
  The reviewer agent is the one exception: it records its verdict via
  `review.ts --approve` or `--request-changes` because that's how the
  pipeline learns the decision.
- **Manual mode** — humans (or agents driving themselves) invoke the
  lifecycle CLIs (`start.ts`, `request-review.ts`, `review.ts`,
  `complete.ts`) directly to walk a packet through its states. This
  is the back-compat surface and the way to drive a stuck packet
  forward when the autonomous run has bailed out.

Both modes share the same lifecycle CLIs as the protocol surface; the
difference is **who** invokes them. The full contract is in the
[Agent protocol appendix](#agent-protocol-for-reference).

### Directory Layout

After setup, your project will have:

```
.factory/                # Tooling submodule (hidden)
specs/                   # Human-authored specs (markdown + frontmatter)
factory/                 # Factory artifacts (visible, one directory)
├── intents/             # Derived from specs (or hand-authored back-compat)
├── features/
├── packets/
├── completions/
├── events/              # Per-run event streams (JSONL)
├── cost/                # Per-invocation cost records
└── escalations/         # Structured failure records when recovery escalates
factory.config.json      # Configuration
CLAUDE.md                # AI instructions
AGENTS.md                # Agent constraints
```

Tooling is hidden in `.factory/`. Artifacts are visible in `factory/`.
Specs live at the project root in `specs/` so authors edit them next to
the code, not inside the tooling submodule.

---

## Authoring specs

Specs are the operator's interface to the factory. One spec describes one
unit of work; `run.ts <spec-id>` translates the spec into an intent and
drives the pipeline to completion. The full architectural rationale is in
[`docs/decisions/spec_artifact_model.md`](decisions/spec_artifact_model.md);
this section is the authoring guide.

### File location

```
specs/<spec-id>.md
```

At the project root, alongside `factory.config.json`. Tracked in git as
the source of truth for what the project intends to build. The directory
is intentionally distinct from any pre-existing `docs/specs/` directory —
that one is project documentation; `specs/` is factory-managed.

### Frontmatter

A spec is a markdown file with YAML frontmatter:

```markdown
---
id: add-health-endpoint
title: Add /health endpoint
depends_on: [auth-baseline]   # optional; default empty
---

# Spec body

The body is markdown. The planner reads it to derive an intent. Operators
author at the human-readable level; the factory translates to the locked
intent schema (1:1).
```

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `id` | string | yes | Stable identifier; must match the filename (`specs/<id>.md`) |
| `title` | string | yes | One-line summary used in status output and audit logs |
| `depends_on` | array of strings | no, default `[]` | Other spec IDs that must complete before this spec runs |

Frontmatter is intentionally minimal. Anything else (priority, owner,
target release) goes in the markdown body or in human-managed tooling
outside the factory — those fields are not consumed by the factory.

### Dependencies

`depends_on` is the only sequencing primitive between specs:

- If spec `A` declares `depends_on: [B]`, the factory will not start `A`
  until `B` completes successfully (all packets in B's intent reach
  `completed`).
- If `B` fails, `A` is blocked and reported as such.
- Cyclic dependencies are rejected at orchestrator entry.
- **All transitive dependencies must be passed explicitly to `run.ts`.**
  Auto-resolution is out of scope; if `A` depends on `B` and `B` depends
  on `C`, you must invoke `run.ts C B A` (in any order — topological sort
  computes the actual run order).

### Body conventions

The markdown body is the spec content. The planner agent reads it to
derive an intent. Operators author at the human-readable level (problem
statement, acceptance, constraints); the planner pulls implementation
detail into the intent during planning.

Recommended sections (not enforced):

- A short problem statement
- Acceptance criteria the change must satisfy
- Out-of-scope notes — what the change deliberately does *not* do
- Constraints the planner should respect

### What NOT to do

- **Do not author intents directly.** Hand-authored
  `factory/intents/<id>.json` files still work for backward compatibility,
  but new work should be a spec. The factory derives the intent.
- **Do not put low-level implementation detail in the spec body.** The
  planner translates the spec into an intent and decomposes the intent
  into packets — that is where implementation choices belong.
- **Do not put a `status`, `priority`, or `acceptance_criteria` field in
  the frontmatter.** Status lives on derived artifacts. Priority is a
  human concern outside the factory. Acceptance criteria are derived by
  the planner onto packets.
- **Do not split a single coherent change across multiple specs.** One
  spec maps to one intent (1:1). If you need cross-spec sequencing, use
  `depends_on`.

---

## Post-Setup Configuration

### factory.config.json

Edit the template at your project root:

```json
{
  "$schema": "./.factory/schemas/factory-config.schema.json",
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

### Fields

| Field | Type | Description |
|---|---|---|
| `project_name` | string | Used in status output headers |
| `factory_dir` | string | Path to factory tooling relative to project root (default: `"."`) |
| `artifact_dir` | string | Path to artifact directory relative to project root (default: `"."`) |
| `verification.build` | string | Shell command for build verification |
| `verification.lint` | string | Shell command for lint verification |
| `verification.test` | string | Shell command for test verification |
| `validation.command` | string | Shell command to run factory validation |
| `infrastructure_patterns` | string[] | File paths/prefixes that are not "implementation work" |
| `completed_by_default` | identity | Default identity written into completion records |
| `personas` | object | Planner, developer, code_reviewer, and qa persona defaults |
| `pipeline` | object | Provider mappings, completion identities, review iteration limits |

### Provider configuration

Each entry under `pipeline.providers` describes one CLI:

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Whether the provider is available for selection |
| `command` | string | The single executable token (bare name resolved against `PATH`, or absolute path) |
| `prefix_args` | string[] | Optional fixed leading argv elements prepended to every invocation |
| `sandbox` | string | (codex) sandbox mode: `read-only`, `workspace-write`, `danger-full-access` |
| `permission_mode` | string | (claude) permission gate: `acceptEdits`, `bypassPermissions`, ... |
| `model_map` | object | Per-tier (`high`/`medium`/`low`) model id mapping |
| `model_failover` | string[] | (abstraction providers) within-CLI failover model order |

**`command` is one argv token.** Under POSIX-style argv-mode spawn,
`command` is the executable path, not a shell-tokenized string.
Whitespace inside `command` is preserved as part of the path. If your
provider requires a sub-command (e.g. `gh copilot --`), put the
sub-command in `prefix_args`:

```json
"copilot": {
  "enabled": true,
  "command": "gh",
  "prefix_args": ["copilot", "--"]
}
```

**Operator migration note (DEP0190).** If your `factory.config.json`
has a `command` string containing whitespace (the legacy shape, e.g.
`"command": "gh copilot --"`), you will see a deprecation warning on
load:

```
[factory] DEP0190: 'copilot' uses legacy shell-tokenized command "gh copilot --".
Migrate to command: "gh", prefix_args: ["copilot","--"]. See specs/dep0190-shell-removal.md.
```

Migrate by splitting the string: the first token becomes `command`,
the remaining tokens become `prefix_args`. The legacy shape continues
to load (kept for backward compatibility with hand-edited configs)
but will be removed in a future spec; the migration target above is
the supported shape going forward. See
[`specs/dep0190-shell-removal.md`](../specs/dep0190-shell-removal.md)
for the rationale and the full migration story.

The factory operates under **POSIX-style argv-mode spawn**. Windows
operators run under WSL (or equivalent). Native-Windows `.cmd`/`.bat`
provider wrappers are not supported; install provider CLIs as
POSIX-spawnable binaries (e.g. via `gh`, `claude`, `codex`'s native
installers under WSL).

### Infrastructure patterns

Patterns ending in `/` match directory prefixes (e.g., `factory/` matches
`factory/packets/foo.json`). Patterns without `/` match exact filenames
(e.g., `package.json` matches only the root `package.json`).

Adjust these patterns to match your project structure. Common additions:
- CI configuration directories (`.github/`, `.gitlab/`)
- Project-level config files (`.sln`, `Makefile`, `Cargo.toml`)
- Documentation directories

---

## Pipeline Flow

The pipeline (`run.ts`) is the single entry point for all factory work:

```
npx tsx .factory/tools/run.ts <spec-id> [<spec-id>...]
```

This runs to completion autonomously:

1. **Plan** — Orchestrator translates each spec into an intent (1:1) and invokes the planner; the planner decomposes the intent into a feature with dev/qa packet pairs
2. **Develop** — For each dev packet (in dependency order):
   - Developer agent implements
   - Code reviewer agent reviews (different identity)
   - Feedback loop if changes requested (bounded by `max_review_iterations`)
   - Completion recorded (build/lint/test verification)
3. **Verify** — For each QA packet:
   - QA agent verifies (different identity from dev)
   - Completion recorded
4. **Done** — Feature marked complete, summary printed (with total cost)

### Human Gates

The gate depends on the run-input source:

- **Spec-driven runs** (`run.ts <spec-id>`): exactly one human gate —
  authoring the spec. The intent is a derived artifact materialised
  by the orchestrator from the spec; its `status` field is a
  generator-set artifact, NOT a governance gate. The default
  `proposed` status is accepted automatically.
- **Intent-driven runs** (`run.ts <intent-id>`, backward-compat path):
  hand-authored intents are gated by their `status` field. The
  factory accepts `approved`, `planned`, and `delivered`. The
  factory rejects `proposed`, `superseded`, missing, and unknown
  values; the operator must edit the intent file and set
  `status: "approved"` to grant run authority. (`planned` and
  `delivered` are accepted for idempotent reruns of intents that
  already progressed past plan.)

Completion IS acceptance — there is no separate "ready to ship"
gate after the pipeline succeeds. See the end of this document for
operator guidance on hand-authoring intents.

### Agent Identity Separation

- Dev and QA agents use different identities (FI-7)
- Code reviewer uses a different identity from the developer
- Identities are configured in `pipeline.completion_identities`

---

## Prerequisites

| Requirement | Version | Purpose |
|---|---|---|
| Node.js | >= 20 | Runtime for factory tooling |
| git | Any | Version control + hooks |

### Optional

| Tool | Purpose |
|---|---|
| jq | Pre-commit hook reads config without Node.js for speed |

Factory's Node.js dependencies (tsx, vitest, typescript) are installed
inside `.factory/node_modules/` and do not affect the host project.

---

## Pre-commit Hook

The pre-commit hook runs two steps:

1. **Completion gate** — FI-7 enforcement (blocks if implementation files
   are staged without completion records)
2. **Validate** — full factory validation (schema + integrity + invariants)

If either step fails, the commit is blocked.

The hook resolves tool paths from `factory_dir` in the config, so it
works regardless of whether factory is at the project root or in a
subdirectory.

---

## End-to-End Pipeline Flow

The pipeline runs autonomously from spec to completed feature:

1. Human authors `specs/<spec-id>.md` (see [Authoring specs](#authoring-specs)).
   For backward compatibility, hand-authored
   `factory/intents/<intent-id>.json` files are still accepted — declaring
   either `spec` (inline body for short intents) or `spec_path` (path
   relative to the project root pointing at a Markdown file that holds
   the authoritative spec, e.g. `docs/specs/016-platform-targets.md`).
   `spec_path` must be relative, must not escape the project root, and
   must point at a non-empty file. `validate.ts` enforces the rules;
   `plan.ts` reads the file at plan time and hands its full contents to
   the planner.

   **Hand-authored intents must declare `status: "approved"` to grant
   `run.ts` the authority to run.** This is the intent-driven approval
   gate (see [Human Gates](#human-gates) above). `planned` and
   `delivered` are accepted for idempotent reruns; `proposed`,
   `superseded`, missing, and unknown values are rejected with an
   actionable error. Spec-driven runs (`run.ts <spec-id>`) are NOT
   subject to this check — the spec's authorship IS the approval, and
   the derived intent's generator-set `status: "proposed"` is accepted.
2. Run `npx tsx .factory/tools/run.ts <spec-id> [<spec-id>...]`
3. **Plan phase** — orchestrator translates each spec into an intent (1:1);
   the planner agent then writes:
   - one `factory/features/<feature-id>.json` artifact with `status: "planned"`
   - matching dev/qa packet pairs in `factory/packets/`
   - packet dependencies, change classes, and acceptance criteria
   - `feature.intent_id` linkage
4. **Develop phase** — for each dev packet (in dependency order):
   - Developer agent implements (via the configured `developer` provider)
   - Pipeline transitions packet status through the develop lifecycle
     (`start` → `implementing` → `request-review`); the developer prompt
     does NOT instruct the agent to call those CLIs
   - Code reviewer agent calls `review.ts --approve` or
     `--request-changes` to record the verdict (the only lifecycle call
     the autonomous-mode prompts make)
   - On `--request-changes`, the developer reworks; loop bounded by
     `max_review_iterations`
   - On approval, the pipeline runs verification and records the
     completion with the developer's identity
5. **Verify phase** — for each QA packet:
   - QA agent verifies (via the configured `qa` provider, distinct
     identity from dev)
   - The pipeline runs verification and records the completion with the
     QA identity (FI-7 enforces distinct identities); the QA prompt
     does NOT instruct the agent to call `complete.ts`
6. **Done** — feature marked complete, summary printed (with total cost)

The lifecycle CLIs (`start.ts`, `request-review.ts`, `review.ts`,
`complete.ts`) are the protocol surface in both modes. In autonomous
mode the pipeline calls them as library functions; the agents perform
the *work* but only the reviewer records its verdict via the CLI. In
manual mode (debugging, back-compat, driving a stuck packet) humans or
agents may invoke the CLIs directly. See the
[Agent protocol appendix](#agent-protocol-for-reference) for the
contract.

Pipeline properties:
- **Idempotent** — re-running resumes from artifact state on disk; lifecycle scripts are individually idempotent too
- **Provider-agnostic** — supports codex, claude, copilot (configure via `pipeline.providers`)
- **Failover-aware** — `persona_providers` accepts a list for cross-CLI failover; abstraction providers may declare within-CLI `model_failover` (see [Provider failover](#provider-failover))
- **Recovery-aware** — bounded auto-recovery for known scenarios; lint and test failures always escalate (see [Recovery](#recovery))
- **Cost-visible** — every run reports total cost; configurable caps abort on overage (see [Cost visibility](#cost-visibility))
- **Observable** — typed events stream to `factory/events/<run-id>.jsonl` (see [Event observability](#event-observability))
- **Identity-separated** — developer, code_reviewer, and qa identities are distinct (FI-7)
- **Bounded review** — `max_review_iterations` (default 3) caps rework cycles
- **No human gates after spec authoring** — completion IS acceptance

---

## Event observability

The pipeline emits typed events at every meaningful state transition. Each
event is one JSON line in `<artifactRoot>/events/<runId>.jsonl` (one file
per run). The stream is append-only during a run; rotation/archival is the
host's concern.

The taxonomy is closed — `tools/pipeline/events.ts` defines the full
`EventType` union. Grouped by category:

- **Pipeline lifecycle:** `pipeline.started`, `pipeline.spec_resolved`,
  `pipeline.finished`, `pipeline.failed`
- **Spec lifecycle:** `spec.started`, `spec.blocked`, `spec.completed`
- **Phase lifecycle:** `phase.started`, `phase.completed` (the payload
  carries `outcome: 'ok' | 'failed'` — there is no separate
  `phase.failed` event)
- **Packet lifecycle:** `packet.started`, `packet.review_requested`,
  `packet.review_approved`, `packet.changes_requested`,
  `packet.completed`, `packet.failed`
- **Verification:** `verification.passed`, `verification.failed`
- **Recovery:** `recovery.attempt_started`, `recovery.succeeded`,
  `recovery.exhausted`, `recovery.escalated`
- **Cost:** `cost.cap_crossed`

Every event has a stable shape:
`{ event_type, timestamp, provenance, run_id, payload }`.

Each event also carries a **provenance label** — `live_run` for normal
operator runs, `test` for events emitted by the test suite, plus
`healthcheck`, `replay`, and `dry_run` reserved for future tooling.
Consumers filter by provenance, so test-suite events do not pollute the
operator's stream.

To inspect a run:

```sh
tail -f factory/events/<run-id>.jsonl
jq 'select(.event_type == "recovery.escalated")' factory/events/<run-id>.jsonl
```

Full design: [`docs/decisions/event_observability.md`](decisions/event_observability.md).

---

## Cost visibility

Every agent invocation is metered. The run summary emits zero, one, or
many invocations per run; the summary line varies by what was metered:

- **No invocations:** the cost line is omitted entirely.
- **All unknown-cost:** `Cost: 3 unknown-cost invocation(s) (provider did not report tokens)`
- **All known-cost:** `Total cost: $0.4231 over 5 invocation(s)`
- **Mixed:** `Total cost: $0.4231 (3 unknown-cost invocation(s))`

The `unknown-cost` count is invocations where the provider did not report
tokens (e.g., `gh copilot`); they are counted but contribute `null`
dollars rather than being silently zeroed.

Caps are configurable in `factory.config.json`. All three are optional and
default to disabled (no enforcement):

```json
"pipeline": {
  "cost_caps": {
    "per_run": 5.00,
    "per_packet": 1.00,
    "per_day": 25.00
  }
}
```

| Cap | Behavior on cross |
|---|---|
| `per_run` | Aborts the entire pipeline run; emits `cost.cap_crossed` and `pipeline.failed` |
| `per_packet` | Fails just the affected packet; orchestrator continues to the next independent packet |
| `per_day` | Aborts the run AND records the date so subsequent same-day runs are blocked at orchestrator entry (LOCAL date) |

Caps use `>=` semantics: a running total at-or-above the cap triggers
escalation. The cap dollar values are USD.

Per-invocation cost records are written to `factory/cost/`. Operators
own the audit trail.

Full design: [`docs/decisions/cost_visibility.md`](decisions/cost_visibility.md).

---

## Recovery

The factory recognizes eight failure scenarios and applies a recipe per
scenario. Five auto-recover with bounded retries; three always escalate.

| Scenario | Recipe | Per-packet retry budget |
|---|---|---|
| `ProviderTransient` | Wait, retry same provider/model | 2 |
| `AgentNonResponsive` | Treat as `ProviderTransient` | 2 |
| `BuildFailed` | Re-invoke developer with build error + guardrail prompt | 1 |
| `StaleBranch` | `git fetch && git rebase origin/main`; retry once | 1 |
| `ProviderUnavailable` | Cascade through within-CLI then cross-CLI failover (see [Provider failover](#provider-failover)) | data-driven (= cascade length) |
| `LintFailed` | **Escalate.** Auto-recovery would invite agents to disable lint rules. | 0 |
| `TestFailed` | **Escalate.** Auto-recovery is the failure mode where agents mutilate tests to clear errors. | 0 |
| `CompletionGateBlocked` | **Escalate.** The pre-commit hook is an intentional human gate. | 0 |

When recovery exhausts its budget or hits an escalate-only scenario:

- The orchestrator writes a structured failure record at
  `factory/escalations/<spec-id>-<timestamp>.json`
- A `recovery.escalated` event is appended to the run's event stream
- The affected packet is marked `failed`
- Downstream packets and dependent specs are marked blocked

`LintFailed` and `TestFailed` are deliberately escalate-only. The factory
will not let an agent decide whether failing tests should be relaxed or
whether failing lint rules should be disabled — that is a human call.

Full design: [`docs/decisions/recovery_recipes_not_dsl.md`](decisions/recovery_recipes_not_dsl.md).

---

## Provider failover

Each persona maps to one or more provider CLIs. The factory supports two
layers of failover.

**Cross-CLI** (`persona_providers.<persona>`) accepts either a single
provider name or an ordered list:

```json
"persona_providers": {
  "developer": ["codex", "claude", "copilot"],
  "code_reviewer": ["claude", "copilot"],
  "qa": "claude"
}
```

The single-string form is the original shape and continues to work
unchanged — no failover. The array form declares the failover order:
the first entry is tried first, the next on failure, and so on. Existing
configs do not need to migrate.

**Within-CLI** (`pipeline.providers.<provider>.model_failover`) applies
to **abstraction providers** — CLIs that route to multiple underlying
models (e.g., `copilot`). It is an optional ordered list of model IDs:

```json
"copilot": {
  "command": "gh",
  "prefix_args": ["copilot", "--"],
  "model_map": {
    "high": "claude-opus-4-6",
    "medium": "GPT-5.4",
    "low": "claude-haiku-4-5"
  },
  "model_failover": ["claude-opus-4-6", "GPT-5.4", "claude-haiku-4-5"]
}
```

Direct providers (`codex`, `claude` — one CLI maps to one upstream
provider) do **not** set `model_failover`; the field is reserved for
abstraction providers.

When `ProviderUnavailable` fires, the cascade walks each provider's
`model_failover` list (within-CLI) before falling through to the next
CLI in `persona_providers` (cross-CLI). When every entry is exhausted,
the scenario escalates.

Full design: [`docs/decisions/single_entry_pipeline.md`](decisions/single_entry_pipeline.md)
(see "Recovery" and "Provider failover").

---

## Testing the Factory Tooling

```sh
cd .factory
npx vitest run
```

The factory tooling has its own test suite covering:
- Completion gate logic
- Status derivation
- Execute resolver
- Plan resolver
- Configuration utilities
- Terminal output formatting

All tests are pure function tests — no I/O, no mocking.

---

## Git Considerations

### Committing factory artifacts

Factory artifacts (packets, completions, etc.) under `factory/` are meant
to be committed alongside your code. They are the governance trail.

### Updating factory tooling

To update factory tooling from upstream:

```sh
cd .factory
git pull origin main
cd ..
git add .factory
git commit -m "Update factory tooling"
```

### .gitignore

Add to your project's `.gitignore`:

```
.factory/node_modules/
```

The setup script does not modify your `.gitignore` — add these entries
manually.

---

## Agent protocol — for reference

The lifecycle scripts below are the protocol surface for moving a
packet through its lifecycle. They are the same scripts whether the
caller is the orchestrator, an autonomous agent, or a human typing at a
terminal — the difference is who invokes them, not what they do.

### Two callers, one contract

- **Autonomous (`run.ts <spec-id>`)** — the orchestrator calls
  `start`, `request-review`, and `complete` as library functions while
  driving the develop / verify phases. Agents under autonomous mode
  perform the underlying work but do NOT call those three CLIs
  themselves. The exception is `review.ts`: the code reviewer agent
  calls it explicitly to record approve/request-changes — that is how
  the pipeline learns the verdict.
- **Manual (humans or self-driving agents)** — anyone can invoke the
  lifecycle CLIs directly to drive a packet forward. This is the
  back-compat surface, the debugging surface, and the way to nudge a
  packet out of an in-between state when an autonomous run bailed out.

All four lifecycle scripts are idempotent: re-invocation on a state
that already satisfies the request prints "already done" and exits 0.
This means external callers can safely retry without producing
duplicate state.

| Script | Purpose | Idempotent on |
|---|---|---|
| `start.ts <packet-id>` | Agent claims a packet; sets `started_at`, status → `implementing` | `started_at` already set |
| `request-review.ts <packet-id>` | Developer signals dev work ready for code review; status → `review_requested` | status already `review_requested` |
| `review.ts <packet-id> --approve` / `--request-changes` | Code reviewer records decision | status already matches the requested decision |
| `complete.ts <packet-id>` | Runs verification (build/lint/test), writes the completion record | completion record already exists (skips re-running verification) |

Two related scripts are part of the protocol but not state-mutating:

| Script | Purpose |
|---|---|
| `plan.ts <spec-or-intent-id>` | Resolves what the planner should do; reads spec/intent and returns a structured planner action |
| `execute.ts <feature-id>` | Resolves which packets are ready next, with persona and model assignments |

### Agent prompt patterns

The flow looks different depending on which mode is driving the packet.

**Autonomous mode (`run.ts`)** — the orchestrator drives the lifecycle.
The agent prompts the factory ships in `tools/pipeline/prompts.ts`
explicitly tell each persona NOT to call `start.ts`,
`request-review.ts`, or `complete.ts`. The reviewer prompt is the
exception: it instructs the reviewer to call `review.ts --approve` /
`--request-changes` so the pipeline learns the decision.

**Manual mode** — the natural lifecycle for an agent (or human)
driving a packet through its states by hand:

```
1. Run start.ts <packet-id>                    (mark in progress)
2. Implement the change
3. Run request-review.ts <packet-id>           [dev only]
4. Wait for review.ts decision                  [dev only]
5. On --approve: run complete.ts <packet-id>
   On --request-changes: rework, go to 3
```

The lifecycle scripts behave identically in both modes — they're the
same protocol. Choose the mode that matches your intent: `run.ts` for
the autonomous one-command pipeline; the lifecycle CLIs directly when
you need to drive a single packet by hand.
