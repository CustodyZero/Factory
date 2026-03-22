# Integration Guide

How to adopt the factory in a host project.

---

## Option A: Standalone (this repo IS your factory)

Use this repo directly as your project root. Your source code, factory
artifacts, and tooling all live together.

1. Clone or copy this repo
2. Run `pnpm install`
3. Edit `factory.config.json` with your project's build/lint/test commands
4. Run `pnpm prepare` to install git hooks
5. Start creating packets

---

## Option B: Embed in an existing project

Copy the factory structure into your existing repo.

### What to copy

```
factory.config.json          → <project-root>/factory.config.json
schemas/                     → <project-root>/factory/schemas/
packets/                     → <project-root>/factory/packets/
completions/                 → <project-root>/factory/completions/
acceptances/                 → <project-root>/factory/acceptances/
rejections/                  → <project-root>/factory/rejections/
evidence/                    → <project-root>/factory/evidence/
features/                    → <project-root>/factory/features/
reports/                     → <project-root>/factory/reports/
tools/                       → <project-root>/tools/factory/
AGENTS.md                    → <project-root>/AGENTS.md
.githooks/pre-commit         → <project-root>/.githooks/pre-commit
```

### Adjust paths

When embedding, the tooling assumes artifacts are at the project root.
You'll need to adjust `factory.config.json` or the tool scripts if
your factory artifacts live under a subdirectory like `factory/`.

The key function is `resolveFactoryRoot()` in `tools/config.ts`.

### Add scripts to your package.json

```json
{
  "scripts": {
    "factory:complete": "npx tsx tools/factory/complete.ts",
    "factory:derive": "npx tsx tools/factory/derive.ts",
    "factory:execute": "npx tsx tools/factory/execute.ts",
    "factory:status": "npx tsx tools/factory/status.ts",
    "factory:validate": "npx tsx tools/factory/validate.ts",
    "prepare": "git config core.hooksPath .githooks"
  }
}
```

### Install dependencies

The factory tooling requires:

```json
{
  "devDependencies": {
    "tsx": "^4.0.0",
    "vitest": "^4.0.0"
  }
}
```

These are lightweight — no framework dependencies.

### Configure git hooks

```sh
git config core.hooksPath .githooks
```

Or add a `prepare` script to your `package.json` (shown above).

### Update infrastructure patterns

Edit the `infrastructure_patterns` in `factory.config.json` to match
your project's structure. These patterns define which files are considered
"factory/infrastructure" (not implementation work) for the FI-7 gate.

Common patterns to add:
- `src/` directories that are NOT implementation (unlikely)
- Build output directories
- Documentation directories
- CI configuration paths

Common patterns to customize:
- `tools/factory/` instead of `tools/` if you have other tools
- Project-specific root config files

---

## Prerequisites

| Requirement | Version | Purpose |
|---|---|---|
| Node.js | >= 20 | Runtime for factory tooling |
| pnpm (or npm/yarn) | Any | Package manager (configurable in factory.config.json) |
| tsx | >= 4.0 | TypeScript execution without compilation |
| vitest | >= 4.0 | Test runner for factory tooling tests |
| git | Any | Version control + hooks |

### Optional

| Tool | Purpose |
|---|---|
| jq | Pre-commit hook reads config without Node.js for speed |

---

## Configuration Reference

### factory.config.json

```json
{
  "$schema": "./schemas/factory-config.schema.json",

  "project_name": "my-project",

  "verification": {
    "build": "pnpm build",
    "lint": "pnpm lint",
    "test": "pnpm test"
  },

  "validation": {
    "command": "npx tsx tools/validate.ts"
  },

  "infrastructure_patterns": [
    "factory/",
    "tools/",
    ".githooks/",
    ".github/",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    ".gitignore",
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
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
| `verification.build` | string | Shell command to run build verification |
| `verification.lint` | string | Shell command to run lint verification |
| `verification.test` | string | Shell command to run test verification |
| `validation.command` | string | Shell command to run factory validation |
| `infrastructure_patterns` | string[] | File paths/prefixes that are not "implementation work" |
| `completed_by_default` | identity | Default identity written into completion records |

### Infrastructure patterns

Patterns ending in `/` match directory prefixes (e.g., `factory/` matches
`factory/packets/foo.json`). Patterns without `/` match exact filenames
(e.g., `package.json` matches only the root `package.json`, not
`packages/cli/package.json`).

---

## Pre-commit Hook

The pre-commit hook runs four steps in order:

1. **Build** — runs `verification.build` from config
2. **Lint** — runs `verification.lint` from config
3. **Completion gate** — FI-7 enforcement (blocks if implementation files
   are staged without completion records)
4. **Validate** — full factory validation (schema + integrity + invariants)

If any step fails, the commit is blocked.

---

## Testing the Factory Tooling

```sh
pnpm test              # or: npx vitest run
```

The factory tooling has its own test suite (44 tests) covering:
- Completion gate logic (16 tests)
- Status derivation (14 tests)
- Execute resolver (14 tests)

All tests are pure function tests — no I/O, no mocking.
