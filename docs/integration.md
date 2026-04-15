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
2. Run `npx tsx .factory/tools/plan.ts <intent-id>`
3. Let the planner write one planned feature plus dev/qa packet pairs
4. Human approves the intent/spec when it is ready to govern downstream work
5. Preferred native option: run `npx tsx .factory/tools/orchestrate.ts run --intent <intent-id>`
6. Manual option: run `npx tsx .factory/tools/supervise.ts --init`, then `npx tsx .factory/tools/supervise.ts --json`
7. Spawn only the agents returned in `dispatches`

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

## End-to-End Planner + Supervisor Flow

For automated orchestration with the native harness or an external runner:

1. Human authors `factory/intents/<intent-id>.json`. The intent declares exactly
   one of `spec` (inline body for short intents) or `spec_path` (path relative
   to the project root pointing at a Markdown file that holds the authoritative
   spec — use this for long human-authored specs like
   `docs/specs/016-platform-targets.md`). `spec_path` must be relative, must not
   escape the project root, and must point at a non-empty file. `validate.ts`
   enforces the rules; `plan.ts` reads the file at plan time and hands its full
   contents to the planner.
2. Planner runs `npx tsx .factory/tools/plan.ts <intent-id> --json`
3. If the action is `plan_feature`, the planner writes:
   - one `factory/features/<feature-id>.json` artifact with `status: "planned"`
   - matching dev/qa packet pairs in `factory/packets/`
   - packet dependencies, change classes, and acceptance criteria
   - `feature.intent_id` and `intent.feature_id` linkage
4. Human approves the intent/spec when it is ready to govern downstream work
5. Preferred native option: run `npx tsx .factory/tools/orchestrate.ts run --intent <intent-id>`
6. Manual option: initialize supervisor state with `npx tsx .factory/tools/supervise.ts --init`, then run `npx tsx .factory/tools/supervise.ts --json`
7. Planned features linked to an approved intent inherit execution authority automatically; standalone/manual planned features may still require direct feature approval
8. If the action is `execute_feature`, the supervisor uses the returned `dispatches` as the only legal spawn contract
9. Each spawned developer or qa agent runs the returned `start_command`
10. Dev agents implement, then run `request-review.ts` — the supervisor dispatches a code_reviewer
11. Code reviewer runs `review.ts --approve` (or `--request-changes` for another iteration)
12. After review approval, dev agent runs `complete.ts`; QA agents run `complete.ts` directly
13. QA agents use a distinct qa identity on `complete.ts` and must satisfy any `environment_dependencies` evidence requirements
14. The native orchestrator retries failed planner and packet runs using the configured provider/model ladder before surfacing a real failure
15. Human handles any explicit architectural acceptance with `accept.ts`
16. The supervisor re-ticks after each completion or acceptance until the action becomes `idle`

Supervisor mode is stricter than the manual `execute.ts` loop:
- Feature packets cannot be started unless they were dispatched by `supervise.ts`
- Runtime-style QA packets must declare `environment_dependencies`
- Active dispatch records in `factory/supervisor/state.json` are the source of truth for legal packet starts
- The planner is upstream only; it does not execute or approve work
- A single `execute_feature` action may authorize packet work across multiple independent features
- Native orchestrator support is limited to `codex` and `claude`; `gemini` is manual only

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
