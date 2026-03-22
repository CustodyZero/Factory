# Integration Guide

How to add the factory to an existing project.

---

## Quick Setup

```sh
# From your project root
git clone https://github.com/custodyzero/factory.git factory
./factory/setup.sh
```

The setup script:

1. Installs factory dependencies (isolated in `factory/node_modules/`)
2. Copies template files to your project root (no-clobber):
   - `factory.config.json` — project configuration
   - `CLAUDE.md` — AI agent instructions
   - `AGENTS.md` — agent operating constraints
3. Configures `git config core.hooksPath factory/hooks`

---

## Post-Setup Configuration

### factory.config.json

Edit the template at your project root:

```json
{
  "$schema": "./factory/schemas/factory-config.schema.json",
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

### Fields

| Field | Type | Description |
|---|---|---|
| `project_name` | string | Used in status output headers |
| `factory_dir` | string | Path to factory directory relative to project root (default: `"."`) |
| `verification.build` | string | Shell command for build verification |
| `verification.lint` | string | Shell command for lint verification |
| `verification.test` | string | Shell command for test verification |
| `validation.command` | string | Shell command to run factory validation |
| `infrastructure_patterns` | string[] | File paths/prefixes that are not "implementation work" |
| `completed_by_default` | identity | Default identity written into completion records |

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
inside `factory/node_modules/` and do not affect the host project.

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

## Testing the Factory Tooling

```sh
cd factory
npx vitest run
```

The factory tooling has its own test suite covering:
- Completion gate logic
- Status derivation
- Execute resolver

All tests are pure function tests — no I/O, no mocking.

---

## Git Considerations

### Committing factory as part of your repo

Factory artifacts (packets, completions, acceptances, etc.) are meant to
be committed alongside your code. They are the governance trail.

### Updating factory

To update factory tooling from upstream:

```sh
cd factory
git pull origin main
```

Since factory is a cloned repo inside your project, its `.git` directory
is independent. You can pull updates without affecting your project's
git history.

### .gitignore

Add to your project's `.gitignore`:

```
factory/node_modules/
factory/derived-state.json
```

The setup script does not modify your `.gitignore` — add these entries
manually.
