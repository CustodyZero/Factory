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
   - `factory/features/`, `factory/packets/`, `factory/completions/`, etc.
   - `factory/supervisor/` with SUPERVISOR.md and memory.md
   - `factory/reports/orchestrator/` for captured LLM run output
4. Configures `git config core.hooksPath .factory/hooks`

After setup, the normal first-run sequence for an agent-driven project is:

1. Create an intent/spec artifact under `factory/intents/`
2. Run `npx tsx .factory/tools/plan.ts <intent-id>`
3. Let the planner write one planned feature plus dev/qa packet pairs
4. Human reviews the planned feature and marks it `approved`
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
├── completions/
├── acceptances/
├── rejections/
├── evidence/
└── supervisor/
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
| `orchestrator` | object | Native Codex/Claude harness configuration and provider mappings |

### Infrastructure patterns

Patterns ending in `/` match directory prefixes (e.g., `factory/` matches
`factory/packets/foo.json`). Patterns without `/` match exact filenames
(e.g., `package.json` matches only the root `package.json`).

Adjust these patterns to match your project structure. Common additions:
- CI configuration directories (`.github/`, `.gitlab/`)
- Project-level config files (`.sln`, `Makefile`, `Cargo.toml`)
- Documentation directories

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

The pre-commit hook runs four steps in order:

1. **Build** — runs `verification.build` from config
2. **Lint** — runs `verification.lint` from config
3. **Completion gate** — FI-7 enforcement (blocks if implementation files
   are staged without completion records)
4. **Validate** — full factory validation (schema + integrity + invariants)

If any step fails, the commit is blocked.

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
4. Human reviews the planned feature and marks it `approved`
5. Preferred native option: run `npx tsx .factory/tools/orchestrate.ts run --intent <intent-id>`
6. Manual option: initialize supervisor state with `npx tsx .factory/tools/supervise.ts --init`, then run `npx tsx .factory/tools/supervise.ts --json`
7. If the action is `execute_feature`, the supervisor uses the returned `dispatches` as the only legal spawn contract
8. Each spawned developer or qa agent runs the returned `start_command`
9. The agent performs only that packet’s scope, then runs `complete.ts`
10. QA agents use a distinct qa identity on `complete.ts` and must satisfy any `environment_dependencies` evidence requirements
11. The native orchestrator retries failed planner and packet runs using the configured provider/model ladder before surfacing a real failure
12. Human handles any explicit architectural acceptance with `accept.ts`
13. The supervisor re-ticks after each completion or acceptance until the action becomes `idle`

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
- Supervisor resolver
- Packet start / supervisor enforcement via validation paths

All tests are pure function tests — no I/O, no mocking.

---

## Git Considerations

### Committing factory artifacts

Factory artifacts (packets, completions, acceptances, etc.) under `factory/`
are meant to be committed alongside your code. They are the governance trail.

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
.factory/derived-state.json
```

The setup script does not modify your `.gitignore` — add these entries
manually.

---

## Migration Guidance

Planner-native flow is backward-compatible with existing downstream repos.

- Existing features and packets remain valid without `intent_id`
- Existing approved features can continue through `execute.ts` or `supervise.ts` unchanged
- `npx tsx .factory/tools/migrate.ts` now ensures `factory/intents/` exists for new planner-driven work
- New work should start from `factory/intents/<intent-id>.json`, then flow through `plan.ts` before approval and execution
