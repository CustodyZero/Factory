---
id: dep0190-shell-removal
title: Remove shell:true from spawn; split provider command into command + prefix_args
depends_on: []
---

# DEP0190 shell removal ✅ COMPLETE

**Status:** Merged in commit `89cb66d` (2026-05-11). 4 commits, 713 → 738 tests, 2 review rounds (REQUEST-CHANGES → APPROVE). Independent QA APPROVE on all 15 acceptance criteria + 16 specific checks.

**Windows decision (locked at dispatch):** Path (a) — POSIX-only support boundary. Windows operators run under WSL. The factory does not include `.cmd`/`.bat` shim code; no `cmd.exe /c` fallback. Documented at the top of `tools/pipeline/agent_invoke.ts`.

**Round-1 finding worth recording:** Codex caught a test that pinned the buggy behavior under a misleading test name — the loader's whitespace-split rule broke POSIX absolute paths with spaces (e.g., `/Applications/Tool With Space/bin/codex`), but the existing test claimed "preservation" while asserting the broken split. The disambiguation rule was corrected to `command.includes('/')` (path) vs whitespace-without-`/` (legacy). Second time in this session that bounded-iteration caught the test-pins-the-bug facade — first time was the convergence pass's reviewer fallback. Pattern worth carrying as a recognition signal.

---

## Problem statement

Node emits a `DEP0190` deprecation warning when `child_process.spawn()` is
called with `shell: true` together with an argv array. Node is deprecating
shell tokenization of an argv array because it is the well-known argument-
injection vector: a shell metacharacter in any argv element silently
becomes shell syntax instead of a literal argument. Future Node releases
will remove the behavior.

The factory hits this warning every time it invokes a provider CLI. Two
sites of the codebase rely on shell tokenization today:

1. `tools/pipeline/agent_invoke.ts:382` — the `spawn(command, args, ...)`
   call passes `shell: true`.
2. `factory.config.json` and `templates/factory.config.json` — the copilot
   provider's `command` is the literal string `"gh copilot --"`. The
   factory does not split that string itself; the shell does, because of
   `shell: true`. Without the shell, `spawn("gh copilot --", [...])`
   becomes a lookup for an executable literally named `gh copilot --`,
   which does not exist.

Codex and Claude providers configure `command: "codex"` and
`command: "claude"` respectively — single-token strings — and do not rely
on tokenization in practice. Only the abstraction provider (copilot) does.

## Goal

Remove `shell: true` from the `agent_invoke.ts` spawn call, refactor the
provider config to separate the executable from any fixed leading
arguments, and preserve the current invocation behavior for all three
configured providers (codex / claude / copilot).

## Specifically (what changes)

### Config schema change

`schemas/factory-config.schema.json` adds an optional `prefix_args:
string[]` (non-empty items, `minItems: 1` when present) to
`$defs/pipeline_provider`. Schema remains `additionalProperties: false`.
After the change, `command` carries the executable only — a single argv
token interpreted by `spawn` as the program path; `prefix_args` carries
the fixed leading arguments (e.g. `["copilot", "--"]`). Per-provider
suffix logic (claude/codex/copilot/generic) in `buildProviderArgs` is
unchanged.

Supported `command` shapes (under `spawn` with `shell: false`, a single
argv command is treated as a literal executable path — no shell
tokenization — so internal whitespace inside the path is preserved):

- Bare executable name resolved against `PATH`: `"gh"`, `"codex"`,
  `"claude"`, `"npx"`. Most common.
- Absolute executable path, possibly containing spaces:
  `"/Applications/Tool With Space/bin/codex"`,
  `"C:\\Program Files\\GitHub CLI\\gh.exe"`. Supported; spaces inside an
  argv-mode `command` are part of the path, not argument separators.

Unsupported (migration boundary): a space-separated string carrying
multiple arguments, e.g. `"gh copilot --"`. This shape only worked under
the previous `shell: true` because the shell tokenized it. Operators on
that shape must split into `command: "gh"` + `prefix_args: ["copilot",
"--"]`. Phase 1's loader normalizes this once, with a deprecation
warning.

### Config loader normalization

`tools/config.ts` accepts BOTH shapes:

- **New shape** (preferred): `command` is a single token; `prefix_args`
  carries any leading args. Loaded as-is.
- **Legacy shape** (kept for backward compat): `command` contains
  whitespace. The loader whitespace-splits it once at load time (no
  quoting support — narrow split rule covering only the forms the
  factory has shipped: `"codex"`, `"claude"`, `"gh copilot --"`) and
  emits one deprecation warning per provider naming the rewritten
  shape. The legacy shape is normalized into the in-memory
  `PipelineProviderConfig` so downstream code only sees the new shape.

### `buildProviderArgs` + `invokeAgent` refactor

- `buildProviderArgs` prepends `providerConfig.prefix_args ?? []` to the
  per-provider argv it already constructs. Its return shape
  (`{ command, args }`) is unchanged; `command` is now guaranteed to be
  a single executable token.
- `invokeAgent` drops `shell: true` from its spawn options. Everything
  else stays the same: cwd, stdio piping, copilot's stdin path, the
  10-minute SIGTERM/SIGKILL timeout chain, the heartbeat surface, the
  close/error handlers, cost extraction.

### Live + template config migration (Phase 3)

`factory.config.json` and `templates/factory.config.json` rewrite the
copilot entry from `"command": "gh copilot --"` to
`"command": "gh", "prefix_args": ["copilot", "--"]`. codex and claude
entries are unchanged (single-token `command`; no `prefix_args`).

### Tests

- Argv-construction tests for every provider (codex / claude / copilot /
  generic), with and without `prefix_args`, with and without `modelId`,
  in both prompt-as-positional and prompt-via-stdin paths.
- Config-loader tests: new shape passthrough; legacy shape normalization;
  deprecation warning emitted exactly once per provider.
- Spawn-boundary integration test using a stub child (e.g.
  `node -e "process.exit(0)"`) that asserts `DEP0190` does NOT appear
  via `process.on('warning', ...)` filtered on `warning.code === 'DEP0190'`.
- Edge-case argv tests: prompts containing spaces, single quotes, double
  quotes, backticks, and newlines must reach the child byte-identical.
  Without `shell: true` the OS spawn handles escaping natively.

## Suggested phasing

Three phases, landed in order. Each is a candidate dev/qa packet pair.

### Phase 1 — Schema + loader normalization (additive, no behavior change)

**Goal:** widen the schema and the loader to accept both shapes; emit a
deprecation warning when the legacy shape is loaded. No change to the
spawn call or to provider configs.

**Deliverables:**

- `schemas/factory-config.schema.json` adds optional `prefix_args` on
  `pipeline_provider`.
- `tools/config.ts` loader splits a whitespace-containing `command` into
  `{ command, prefix_args }` and warns once per loaded provider.
- Loader tests cover: new shape passthrough; legacy shape normalization;
  deprecation warning content and frequency.
- Existing 713 tests still pass.

**Acceptance:** loading either config shape produces the same in-memory
`PipelineProviderConfig` (single-token `command` + array `prefix_args`).
Live `factory.config.json` still loads (legacy shape) and emits the
documented warning.

### Phase 2 — `buildProviderArgs` + `invokeAgent` refactor

**Goal:** thread `prefix_args` through `buildProviderArgs` and drop
`shell: true` from the spawn call. No config file changes yet.

**Deliverables:**

- `buildProviderArgs` prepends `prefix_args` to the argv it already
  builds; per-provider suffix logic unchanged.
- `invokeAgent` removes `shell: true` from the spawn options.
- Tests cover argv construction for every provider with and without
  `prefix_args`; the no-warning integration test runs against a stub
  child process; the prompt-escaping edge-case tests run.

**Acceptance:** all three configured providers (codex / claude /
copilot) invoke successfully against a stub executable without
emitting `DEP0190`. Existing tests still pass. Recovery, cost
extraction, and event emission tests still pass — the change is at
the spawn boundary and below all of those seams.

### Phase 3 — Migrate live + template configs to new shape

**Goal:** rewrite both `factory.config.json` files to the new shape and
update operator documentation.

**Deliverables:**

- `factory.config.json` and `templates/factory.config.json` updated to
  the split shape for the copilot provider.
- `docs/integration.md` (and any other operator-facing doc that shows
  a provider block) updated to the new shape with a short migration
  note.
- A note in the deprecation warning of Phase 1 pointing operators at
  the documented new shape.

**Acceptance:** `npx tsx tools/run.ts <spec-id>` runs through to
completion with no `DEP0190` warning emitted by Node. The legacy
shape continues to load (kept for operators with hand-edited configs)
but emits the deprecation warning. A later spec — out of scope here
— may flip the loader to reject the legacy shape outright once host
projects have had time to migrate.

## Risks

| Risk | Mitigation |
|------|------------|
| Argument escaping diverges from current shell-tokenized behavior on Windows vs Unix | Cross-platform tests for prompts containing spaces, quotes, backticks, and newlines, asserting byte-identical delivery to the child. No reliance on shell-specific quoting. |
| Windows wrapper-script providers (`.cmd` / `.bat`) fail to spawn without shell: `spawn("gh", ["copilot", "--", ...], { shell: false })` on Windows does not find `gh.cmd` because Node's spawn on Windows resolves only `.exe`-style executables natively; npm/pnpm/Scoop/Chocolatey commonly install `gh`, `codex`, `claude`, and `npx` as `.cmd` shims | The implementing developer picks one explicitly: **(a)** Documented support boundary — factory operates with POSIX-style argv-mode spawn; Windows operators run under WSL (or equivalent POSIX environment) and the factory does not claim native-Windows support for `.cmd`/`.bat` providers; OR **(b)** Cross-platform spawn-boundary test that exercises wrapper-style commands (not just native stub children — e.g. a `.cmd` shim on Windows CI), with a documented Windows-specific shim path in `invokeAgent` (e.g. extension probing or explicit `cmd.exe /c` for `.cmd`/`.bat`, isolated and labeled). The spec does not prefer one path; the choice is made when the fix lands and documented in that packet. |
| Operators have hand-edited `command` strings that depend on shell features (tilde, glob, env-var substitution, command substitution) | Phase 1 keeps the legacy shape working (with a warning). Phase 3 does not break the legacy shape. Shell-feature emulation is explicitly out of scope; operators relying on those features were deviating from the documented surface and must move to a literal argv. |
| **Operator config migration friction**: existing operators across host projects have `command: "gh copilot --"` in their `factory.config.json` | Phase 1's dual-acceptance is load-bearing. The legacy shape continues to work indefinitely with a deprecation warning. A future spec may move to strict rejection, but only after host projects have had observed time to migrate. |
| Cost extraction, recovery classification, event emission depend on `child.stdout` / `child.stderr` / `exit_code` | The spawn boundary is below all three seams. Tests pin the InvokeResult shape (exit_code, stdout, stderr, cost) and the cost-recording flow against fixture stdout strings; they pass unchanged when `shell: true` is removed. Verify by running the existing recovery + cost + events test suites unmodified. |
| Deprecation-warning detector test is flaky (Node's warning channel is process-global) | Use `process.on('warning', ...)` with a scoped listener attached/removed inside the test; assert on warning `code === 'DEP0190'`. Run sequentially (no parallel test interference). |
| The schema split could be conflated with the Phase 7 `model_failover` field | They are distinct: `prefix_args` is fixed leading argv for every invocation; `model_failover` is recovery sequencing. The schema places them as separate optional properties on `pipeline_provider`. |

## Acceptance criteria

- `npx tsx tools/run.ts <spec-id>` does not emit `DEP0190` warnings from
  any agent invocation (planner / developer / reviewer / qa).
- All three providers (codex / claude / copilot) invoke correctly
  without `shell: true`. Verified by argv-construction tests + a stub-
  executable spawn test.
- The config loader accepts BOTH the legacy single-string `command` shape
  and the new `command + prefix_args` shape. Legacy shape emits a single
  deprecation warning per provider per load.
- `factory.config.json` and `templates/factory.config.json` are migrated
  to the new shape.
- No regression in:
  - Cost tracking (provider/model/tokens/dollars on InvokeResult).
  - Recovery / cascade classification (Phase 6 + Phase 7 behavior).
  - Event emission and provenance labeling (Phase 5.5 behavior).
  - Heartbeat surface (cadence resolution, `_startHeartbeat` contract).
- All existing 713 tests still pass; new tests added per the deliverables
  above.

## Out of scope (for THIS spec)

- **Stricter argv validation.** Rejecting argv elements that contain
  newlines, null bytes, or other control characters is a separate
  hardening pass and warrants its own spec.
- **Expanding the supported provider list** or changing the per-provider
  argv contract beyond `prefix_args` prepending. The factory's three
  configured providers (codex / claude / copilot) plus the generic
  fallback remain the supported surface.
- **Shell-feature emulation** (tilde expansion, globbing, environment-
  variable substitution, command substitution). Operators who relied on
  these were already deviating from documented best practice; the
  migration note in Phase 3 is sufficient.
- **Strict rejection of the legacy `command`-with-whitespace shape.**
  Phase 1 normalizes; Phase 3 migrates the in-repo configs; flipping
  the loader to a hard error is deferred indefinitely and would be its
  own spec.

## References

- `tools/pipeline/agent_invoke.ts` — spawn call site (`shell: true`) and
  `buildProviderArgs`
- `tools/config.ts` — config loader (where Phase 1's normalization
  lands)
- `factory.config.json` — current live config with legacy copilot shape
- `templates/factory.config.json` — host-project template (canonical per
  `docs/decisions/factory_self_governance.md`)
- `schemas/factory-config.schema.json` — schema authority for both files
- `docs/integration.md` — operator-facing documentation that lists the
  provider block (Phase 3 updates this)
- Node documentation for `DEP0190` — the deprecation being addressed
- Convergence-pass commit `82909a9` (`develop_phase.ts:1074` heartbeat
  surface) — unaffected by this change; verified by the heartbeat
  cadence + resolution tests remaining green
