<p align="center">
  <strong>Factory</strong>
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
# Clone factory as a subdirectory
git clone https://github.com/custodyzero/factory.git factory

# Run setup (installs deps, copies templates, configures hooks)
./factory/setup.sh

# Configure for your project
# Edit factory.config.json — set project_name and verification commands
```

### Configure for Your Project

Edit `factory.config.json` at the project root:

```json
{
  "project_name": "my-project",
  "factory_dir": "factory",
  "verification": {
    "build": "dotnet build",
    "lint": "true",
    "test": "dotnet test"
  },
  "validation": {
    "command": "npx tsx factory/tools/validate.ts"
  },
  "infrastructure_patterns": [
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

## Artifact Types

The factory has six artifact types. Each is a JSON file validated
against a schema in `schemas/`.

### Packet

A scoped unit of work. Declares **what** is changing, **why**, and
**which packages** are affected.

```
packets/<packet-id>.json
```

Required fields:
- `id` — kebab-case identifier (must match filename)
- `title` — one-line summary
- `intent` — what is changing and why
- `change_class` — `trivial`, `local`, `cross_cutting`, or `architectural`
- `scope.packages` — which packages are affected
- `owner` — who is responsible
- `created_at` — ISO 8601 timestamp

Optional fields:
- `started_at` — when work began
- `dependencies` — packet IDs that must be accepted first
- `environment_dependencies` — external dependencies
- `status` — `abandoned` or `deferred` (exempt from FI-6/FI-7)
- `feature_id` — parent feature ID
- `tags` — freeform labels

### Completion

Evidence that a packet's implementation is done.

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

Human approval that a completed packet is accepted.

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

A high-level intent that decomposes into multiple packets.

```
features/<feature-id>.json
```

Required fields:
- `id` — kebab-case identifier (must match filename)
- `intent` — what the project should do when this feature is complete
- `status` — `draft`, `planned`, `approved`, `executing`, `completed`, `delivered`
- `packets` — ordered list of packet IDs
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

**FI-1 — One completion per packet.**

**FI-2 — One acceptance per packet.**

**FI-3 — No agent acceptance or rejection.**
Only `human`, `cli`, or `ui` identities may author acceptance or rejection records.

**FI-4 — No acceptance without completion.**

**FI-5 — Architectural packets cannot auto-accept.**

**FI-6 — No progression without completion.**
If a started packet lacks a completion record, no newer packet may have a completion.
Packets marked `abandoned` or `deferred` are exempt.

**FI-7 — Commit-time completion enforcement.**
A commit must not include implementation files while any started packet lacks
a completion. Enforced by the pre-commit hook.

---

## Tooling

### Status

```sh
npx tsx factory/tools/status.ts              # human-readable report
npx tsx factory/tools/status.ts --json       # machine-readable JSON
npx tsx factory/tools/status.ts --feature <id>  # scoped to a feature
```

### Complete

```sh
npx tsx factory/tools/complete.ts <packet-id> [--summary "..."]
```

Runs verification (build, lint, test), then creates a completion record.

### Execute

```sh
npx tsx factory/tools/execute.ts <feature-id>
npx tsx factory/tools/execute.ts <feature-id> --json
```

Stateless action resolver for feature-level execution.

### Validate

```sh
npx tsx factory/tools/validate.ts
```

Schema validation + referential integrity + invariant enforcement.

### Derive

```sh
npx tsx factory/tools/derive.ts              # print to stdout
npx tsx factory/tools/derive.ts --write      # write to derived-state.json
```

---

## Features

Feature lifecycle:
```
draft → planned → approved → executing → completed → delivered
```

Execution protocol:
1. Run `npx tsx factory/tools/execute.ts <feature-id>`
2. Spawn parallel agents for each ready packet
3. Each agent: implement → complete → commit
4. Re-run execute
5. Repeat until all_complete
6. Produce QA report

---

## Directory Structure

When installed in a host project:

```
.                            # Host project root
├── factory.config.json      # Project-specific configuration
├── CLAUDE.md                # AI instructions for the project
├── AGENTS.md                # Agent operating constraints
├── factory/                 # Factory (this repo, cloned)
│   ├── schemas/             # JSON schemas for all artifact types
│   ├── packets/             # Work unit declarations
│   ├── completions/         # Implementation evidence
│   ├── acceptances/         # Human approval records
│   ├── rejections/          # Audit reversals
│   ├── evidence/            # Environment dependency proofs
│   ├── features/            # Feature-level intents
│   ├── reports/             # QA reports
│   ├── tools/               # Factory tooling
│   │   ├── config.ts        # Configuration loader
│   │   ├── validate.ts      # Schema + integrity validation
│   │   ├── status.ts        # Status & next action
│   │   ├── execute.ts       # Feature execution resolver
│   │   ├── complete.ts      # Completion record generator
│   │   ├── completion-gate.ts # Pre-commit FI-7 enforcement
│   │   ├── derive.ts        # State derivation
│   │   └── test/            # Tooling tests
│   ├── hooks/               # Git hooks
│   │   └── pre-commit       # Build + lint + gate + validate
│   ├── templates/           # Setup templates
│   ├── setup.sh             # Installation script
│   └── docs/
│       └── integration.md   # Detailed integration guide
└── src/                     # Host project source (any language)
```

---

## Installation

```sh
# From your project root
git clone https://github.com/custodyzero/factory.git factory
./factory/setup.sh
```

The setup script:
1. Installs factory dependencies (isolated in `factory/node_modules/`)
2. Copies template `factory.config.json`, `CLAUDE.md`, and `AGENTS.md` to your project root (no-clobber)
3. Configures `git config core.hooksPath factory/hooks`

See [`docs/integration.md`](docs/integration.md) for detailed integration guide.

---

## License

Factory is open source under the MIT License. See [LICENSE](LICENSE).

The MIT License governs the source code. It does not grant rights to use
CustodyZero brand assets. See the
[CustodyZero brand repository](https://github.com/custodyzero/brand)
for brand usage policy.

---

<p align="center">
  <a href="https://custodyzero.com">
    <img src="https://raw.githubusercontent.com/CustodyZero/brand/main/brand/custodyzero/wordmark/custodyzero-cz-dark.svg"
         alt="A CustodyZero product" width="160" />
  </a>
</p>
