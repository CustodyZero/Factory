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

1. Create an intent/spec artifact under `factory/intents/`
2. Run the full pipeline: `npx tsx .factory/tools/run.ts <intent-id>`
3. The pipeline plans, develops, reviews, and verifies — autonomously to completion
4. Re-run the same command to resume if anything failed (the pipeline is idempotent)

### Directory Layout

After setup, your project will have:

```
.factory/                # Tooling submodule (hidden)
factory/                 # Artifacts (visible, one directory)
├── intents/
├── features/
├── packets/
└── completions/
factory.config.json      # Configuration
CLAUDE.md                # AI instructions
AGENTS.md                # Agent constraints
```

Tooling is hidden in `.factory/`. Artifacts are visible in `factory/`.

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
npx tsx .factory/tools/run.ts <intent-id>
```

This runs to completion autonomously:

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

### Human Gates

Exactly two:
1. Approve the spec (write the markdown document)
2. Approve the intent (create the intent artifact with constraints)

Everything after `run.ts` is autonomous. Completion IS acceptance.

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

The pipeline runs autonomously from intent to completed feature:

1. Human authors `factory/intents/<intent-id>.json`. The intent declares exactly
   one of `spec` (inline body for short intents) or `spec_path` (path relative
   to the project root pointing at a Markdown file that holds the authoritative
   spec — use this for long human-authored specs like
   `docs/specs/016-platform-targets.md`). `spec_path` must be relative, must not
   escape the project root, and must point at a non-empty file. `validate.ts`
   enforces the rules; `plan.ts` reads the file at plan time and hands its full
   contents to the planner.
2. Run `npx tsx .factory/tools/run.ts <intent-id>`
3. **Plan phase** — the planner agent writes:
   - one `factory/features/<feature-id>.json` artifact with `status: "planned"`
   - matching dev/qa packet pairs in `factory/packets/`
   - packet dependencies, change classes, and acceptance criteria
   - `feature.intent_id` linkage
4. **Develop phase** — for each dev packet (in dependency order):
   - Developer agent implements (via the configured `developer` provider)
   - Developer's prompt instructs it to `request-review.ts` when done
   - Code reviewer agent runs `review.ts --approve` or `--request-changes`
   - On `--request-changes`, the developer reworks; loop bounded by `max_review_iterations`
   - On approval, completion is recorded with the developer's identity
5. **Verify phase** — for each QA packet:
   - QA agent verifies (via the configured `qa` provider, distinct identity from dev)
   - Completion is recorded with the QA identity (FI-7 enforces distinct identities)
6. **Done** — feature marked complete, summary printed

Pipeline properties:
- **Idempotent** — re-running resumes from artifact state on disk
- **Provider-agnostic** — supports codex, claude, copilot (configure via `pipeline.providers`)
- **Identity-separated** — developer, code_reviewer, and qa identities are distinct (FI-7)
- **Bounded review** — `max_review_iterations` (default 3) caps rework cycles
- **No human gates after intent approval** — completion IS acceptance

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
