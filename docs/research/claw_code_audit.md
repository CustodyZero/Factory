---
name: claw-code research audit — autonomous Discord-driven coding harness; lane events, recovery recipes, doctor preflight
description: >-
  Code-level audit of `claw-code` (Rust workspace + Python reference, ~23 MB / 284 files / 80 Rust + 70 Python + 80 JSON across 10 Rust crates), surveyed 2026-04-30. Autonomous coding harness whose primary human interface is a Discord channel — humans set direction by sentence, agent "claws" coordinate work in parallel across planning/execution/review/recovery without human intervention. Three-part system: workflow layer (OmX) + event router (clawhip) + multi-agent coordination (OmO). End-state worker is offline while the system continues; the system is required to recover from real-world failure modes (bad branches, MCP handshake errors, prompt misdelivery, trust gates) on its own, which gives it an unusually mature failure model baked into the architecture. The audit informs five factory decisions: event observability (claw-code's lane events as a typed closed enum with provenance labels distinguishing live/test/healthcheck/replay/transport — §4); recovery recipes vs DSL (claw-code's `PolicyEngine` with composable `And`/`Or` conditions over `LaneContext`, which factory chose NOT to adopt because lanes-are-concurrent isn't a problem factory has — §8); verification grading deferred (the Green Contract `TargetedTests`/`Package`/`Workspace`/`MergeReady` stacked tier model — §7); doctor diagnostic deferred (unified `claw doctor` preflight, JSON-output mode for scripting — §10); and the memory scope split (claw-code's deliberate omission of learned memory: every worker starts fresh from CLAUDE.md and git context — §12). claw-code's posture is more aggressive autonomy than factory's "human approves intent, agents execute"; the audit makes that contrast load-bearing rather than incidental.
type: reference
---

# Research Audit — `claw-code`

**Source:** `/Users/andyhunter/localrepositories/claw-code`
**Surveyed:** 2026-04-30
**Surface:** ~23 MB, 284 files, 80 Rust + 70 Python + 80 JSON across 10 Rust workspace crates plus a Python reference workspace
**One-line description:** Autonomous coding harness ("Claw Code") whose primary human interface is Discord — humans set direction, agent "claws" coordinate work in parallel, planning/execution/review/recovery is automated. Three-part system: workflow layer (OmX) + event router (clawhip) + multi-agent coordination (OmO). The repo is positioned as a *demonstration* of the coordination system, not as a self-contained product.

---

## 1. What it is — and what it claims to be

The `PHILOSOPHY.md` is unusually candid about identity. Excerpts:

> If you only look at the generated files in this repository, you are looking at the wrong layer. The Python rewrite was a byproduct. The Rust rewrite was also a byproduct. The real thing worth studying is the **system that produced them**.

> The important interface here is not tmux, Vim, SSH, or a terminal multiplexer. The real human interface is a Discord channel. A person can type a sentence from a phone, walk away, sleep, or do something else. The claws read the directive, break it into tasks, assign roles, write code, run tests, argue over failures, recover, and push when the work passes.

This is a more aggressive autonomy posture than factory's "human approves intent, agents execute." Claw-code's **end-state worker is offline** while the system continues; the system is required to recover from real-world failure modes (bad branches, MCP handshake errors, prompt misdelivery, trust gates) without human intervention.

The result is an unusually mature **failure model** baked into the architecture.

## 2. Architecture — what's where

### 2.1 Top-level

```
rust/         — canonical Rust workspace (the active runtime)
src/          — Python reference workspace (older byproduct)
tests/        — audit and parity helpers
scripts/      — automation
prd.json      — Product Requirements Document with 24 stories
PHILOSOPHY.md ROADMAP.md PARITY.md USAGE.md  — operational docs
Containerfile — container-first workflow
```

The Rust workspace is the live product. Python remnants are a historical layer; PARITY.md tracks how close the Rust port is to behavioral parity.

### 2.2 Rust workspace crates

```
rust/crates/
  runtime/                 # 40+ files — the orchestration runtime (most relevant)
  rusty-claude-cli/        # Rust port of the claude CLI
  api/                     # API surface
  commands/                # slash commands
  tools/                   # tool framework
  plugins/                 # plugin system
  telemetry/               # telemetry
  compat-harness/          # parity testing harness
  mock-anthropic-service/  # mock service for tests
```

The `runtime` crate is the heart. It contains 40+ files implementing typed events, task packets, recovery recipes, policy engines, trust resolution, branch-staleness detection, sandbox boundaries, MCP lifecycle hardening, plugin lifecycle, and a "green contract" for verification.

This is **substantially deeper orchestration infrastructure than factory has**. Factory's equivalent is `tools/run.ts` (798 lines) plus the helper tools.

## 3. The PRD — story-driven development

`prd.json` is a structured Product Requirements Document. 24 user stories. Each has:

```json
{
  "id": "US-002",
  "title": "Phase 2 - Canonical lane event schema (4.x series)",
  "description": "Define typed events for lane lifecycle: ...",
  "acceptanceCriteria": [
    "LaneEvent enum with all required variants defined",
    "Event ordering with monotonic sequence metadata attached",
    "Event provenance labels (live_lane, test, healthcheck, replay, transport)",
    ...
  ],
  "passes": true,
  "priority": "P0"
}
```

Story IDs are sequential (`US-001` … `US-024`), priorities are `P0`/`P1`/`P2`, and there's a `passes` boolean tracking whether the story is currently green.

This is a **richer cousin of factory's packet artifact**:

| Factory packet | Claw-code user story |
|----------------|----------------------|
| `id`, `title`, `kind: dev|qa` | `id`, `title` |
| `acceptance_criteria: string[]` | `acceptanceCriteria: string[]` |
| `change_class: trivial|local|cross_cutting|architectural` | `priority: P0|P1|P2` |
| `dependencies: string[]` | (implicit phase numbering in title) |
| Tracked separately as JSON files | Single `prd.json` |
| Authored by planner agent | Authored once, lives at root |
| Verification via `complete.ts` (build/lint/test) | `passes: boolean` flag |

The `prd.json` is **one file in the repo root**, not a per-story directory. Browsing all the work is `cat prd.json`. Factory's per-packet JSON files are richer per packet but harder to browse as a roadmap.

## 4. Lane events — the canonical event schema (US-002)

This is the deepest pattern in the repo. `runtime/src/lane_events.rs` defines:

### 4.1 Event names — typed enum, not strings

```rust
pub enum LaneEventName {
    // Lifecycle
    Started, Ready, Blocked, Red, Green,
    Finished, Failed, Reconciled, Merged, Superseded, Closed,
    // Failures with classification
    PromptMisdelivery,
    // Git correctness
    BranchStaleAgainstMain, BranchWorkspaceMismatch,
    // Code review / merge
    CommitCreated, PrOpened, MergeReady,
    // Ship / provenance
    ShipPrepared, ShipCommitsSelected, ShipMerged, ShipPushedMain,
}
```

22 specific event variants, each `serde`-serialized with the dotted name (`lane.started`, `lane.ready`, `lane.red`, …). This is *much more* specific than factory's `OrchestratorRunRecord` which has just `'success' | 'failed' | 'skipped'`.

### 4.2 Failure classifier — typed error categories

```rust
pub enum LaneFailureClass {
    PromptDelivery, TrustGate, BranchDivergence,
    Compile, Test, PluginStartup,
    McpStartup, McpHandshake, GatewayRouting,
    ToolRuntime, WorkspaceMismatch, Infra,
}
```

12 *specific* failure classes. Factory's `OrchestratorFailureKind` was 3 (`provider_unavailable | provider_error | task_failed`) before being deleted. Claw-code's classifier is what factory aspired to.

The classifier is consumed downstream by recovery recipes (§6).

### 4.3 Event provenance

```rust
pub enum EventProvenance {
    LiveLane,    // event from a real active lane
    Test,        // synthetic test
    Healthcheck, // healthcheck probe
    Replay,      // log replay
    Transport,   // transport layer itself
}
```

Every event is tagged with where it came from. This means:

- Replay events don't trigger production alerts
- Healthcheck events don't get billed against budgets
- Test events don't poison real session ledgers
- The audit log distinguishes "real work happened" from "we exercised the plumbing"

Factory currently has no provenance concept. A `complete.ts` invocation in a test environment looks identical to one in production.

## 5. Task packets — typed work units (US-005)

`runtime/src/task_packet.rs`:

```rust
pub enum TaskScope {
    Workspace,    // entire workspace
    Module,       // one crate/module
    SingleFile,   // one file
    Custom,       // user-defined
}

pub struct TaskPacket {
    pub objective: String,
    pub scope: TaskScope,
    pub scope_path: Option<String>,
    pub repo: String,
    pub worktree: Option<String>,
    pub branch_policy: String,
    pub acceptance_tests: Vec<String>,
    pub commit_policy: String,
    pub reporting_contract: String,
    pub escalation_policy: String,
}

pub struct ValidatedPacket(TaskPacket);  // newtype after validation
```

Compared to factory's packet schema:

| Factory packet field | Claw-code TaskPacket field | Notes |
|---|---|---|
| `id`, `title` | `objective` | similar |
| `change_class` | `scope` | factory tracks risk; claw-code tracks granularity |
| (none) | `scope_path` | factory has `repo` + workspace implied |
| (none) | `worktree` | factory has no worktree concept |
| (none) | `branch_policy` | factory has no branch policy |
| `acceptance_criteria` | `acceptance_tests` | factory's is freer-form |
| `dependencies` | (none) | factory has, claw-code doesn't (lane events handle ordering) |
| (none) | `commit_policy` | factory has none |
| (none) | `reporting_contract` | factory has none |
| (none) | `escalation_policy` | factory has none |

Two patterns worth flagging:

- **Validated newtype.** `TaskPacket` exists as raw data; `ValidatedPacket(TaskPacket)` is the type that's been through validation. The wrapper enforces that validation has happened — you can't construct a `ValidatedPacket` without going through the validation path. Factory's packets are validated by `validate.ts` but the validation is run at integrity-check time, not when *consuming* a packet.
- **Per-packet policy.** Branch policy, commit policy, reporting contract, escalation policy — each is a string (likely a named policy ID). The packet *carries its own governance*. Factory's policy is global (one config), not per-packet.

## 6. Recovery recipes (US-004)

`runtime/src/recovery_recipes.rs` is comment-rich:

> Encodes known automatic recoveries for the six failure scenarios listed in ROADMAP item 8, and **enforces one automatic recovery attempt before escalation**. Each attempt is emitted as a structured recovery event.

```rust
pub enum FailureScenario {
    TrustPromptUnresolved,
    PromptMisdelivery,
    StaleBranch,
    CompileRedCrossCrate,
    McpHandshakeFailure,
    PartialPluginStartup,
    ProviderFailure,
}

impl FailureScenario {
    pub fn from_worker_failure_kind(kind: WorkerFailureKind) -> Self {
        match kind {
            WorkerFailureKind::TrustGate | WorkerFailureKind::ToolPermissionGate
                => Self::TrustPromptUnresolved,
            WorkerFailureKind::PromptDelivery => Self::PromptMisdelivery,
            WorkerFailureKind::Protocol => Self::McpHandshakeFailure,
            WorkerFailureKind::Provider | WorkerFailureKind::StartupNoEvidence
                => Self::ProviderFailure,
        }
    }
}
```

Pattern:

1. Worker reports a typed failure (`WorkerFailureKind`)
2. `FailureScenario::from_worker_failure_kind` maps it to a known scenario
3. A recipe is looked up for that scenario
4. **One recovery attempt** runs automatically; emits a recovery event
5. If the recovery doesn't resolve, the system escalates (likely to humans via clawhip → Discord)

Compared to factory's old `transient_retries` (now deleted): factory's retry was generic ("try again with backoff"). Claw-code's recovery is **scenario-specific** — the recipe for "stale branch" is different from the recipe for "MCP handshake failure."

## 7. The Green Contract (verification grading)

`runtime/src/green_contract.rs`:

```rust
pub enum GreenLevel {
    TargetedTests,    // weakest
    Package,
    Workspace,
    MergeReady,       // strongest
}

pub struct GreenContract {
    pub required_level: GreenLevel,
}

impl GreenContract {
    pub fn evaluate(self, observed_level: Option<GreenLevel>) -> GreenContractOutcome {
        match observed_level {
            Some(level) if level >= self.required_level => Satisfied { ... },
            _ => Unsatisfied { ... },
        }
    }
}
```

GreenLevel is `Ord`, so levels stack. A merge-ready check satisfies a workspace check, etc.

Compared to factory's `complete.ts`:

- Factory: build/lint/test all pass → completion record. Single binary outcome.
- Claw-code: graded levels. A targeted test pass is enough for a single-file scope; merge-ready requires full workspace + integration tests. The contract specifies what level is required for *this work* and the verification is rated against it.

This is **scope-aware verification**. A small refactor doesn't need merge-ready validation.

## 8. The Policy Engine (US-006)

`runtime/src/policy_engine.rs`:

```rust
pub struct PolicyRule {
    pub name: String,
    pub condition: PolicyCondition,
    pub action: PolicyAction,
    pub priority: u32,
}

pub enum PolicyCondition {
    And(Vec<PolicyCondition>),
    Or(Vec<PolicyCondition>),
    GreenAt { level: GreenLevel },
    StaleBranch,
    StartupBlocked,
    LaneCompleted,
    LaneReconciled,
    ReviewPassed,
    ScopedDiff,
    TimedOut { duration: Duration },
}
```

A small DSL for "what should the system do when X happens." Conditions compose (And/Or). The engine evaluates rules against a `LaneContext` and dispatches actions.

Factory's policy is hard-coded in `run.ts` switch statements. Claw-code's policy is *configurable data*.

## 9. Other runtime patterns worth noting

From the file inventory of `runtime/src/`:

| File | What |
|---|---|
| `trust_resolver.rs` | Resolves trust prompts with allowlist auto-trust (US-012) |
| `branch_lock.rs`, `stale_branch.rs`, `stale_base.rs` | Branch correctness gates |
| `permission_enforcer.rs` | Per-tool permission enforcement |
| `bash_validation.rs` | Validate bash before running |
| `sandbox.rs` | Sandbox boundaries |
| `summary_compression.rs` | Context window management |
| `mcp_lifecycle_hardened.rs` | MCP lifecycle with explicit hardening (vs the basic `mcp.rs`) |
| `plugin_lifecycle.rs` | Plugin lifecycle (US-007) |
| `worker_boot.rs` | Worker startup with typed `WorkerFailureKind` |
| `team_cron_registry.rs` | Scheduled work registry across team |
| `session_control.rs` | Session lifecycle outside the main session |

Two themes:

- **Hardening as a feature.** `mcp_lifecycle_hardened.rs` exists *next to* `mcp.rs`. The hardened version is a separate, more defensive implementation; the basic version is kept for tests/comparison. Factory has no equivalent of "two versions, one trusted, one not."
- **Lots of git correctness gates.** Branch staleness, base staleness, workspace mismatch, branch lock. Factory delegates all git correctness to the developer agent's prompt and to `complete.ts` running build/lint/test. Claw-code treats git correctness as first-class runtime infrastructure.

## 10. Doctor / preflight pattern

USAGE.md emphasizes a `claw doctor` command:

> Run this before prompts, sessions, or automation. Once you have a saved session, you can rerun it with `./target/debug/claw --resume latest /doctor`.

`/doctor` is the built-in setup and preflight diagnostic. `--output-format json` makes it scriptable. Diagnostic verbs (`doctor`, `status`, `sandbox`, `version`) reject invalid suffix arguments at parse time rather than falling through.

Factory has `validate.ts` (integrity check) and `status.ts` (state report) but no unified preflight. The "what would happen if I ran X right now" question requires running multiple tools and reading multiple outputs.

## 11. Three-part system positioning

PHILOSOPHY.md frames claw-code as one of three components:

1. **OmX (`oh-my-codex`)** — workflow layer; turns directives into structured execution (planning keywords, execution modes, persistent verification loops, parallel multi-agent workflows)
2. **clawhip** — event router; watches git, tmux, GitHub, agent lifecycle; keeps notifications **outside the agent context window**
3. **OmO (`oh-my-openagent`)** — multi-agent coordination; planning, handoffs, disagreement resolution, verification loops between Architect/Executor/Reviewer

claw-code is the **harness** that the other two systems coordinate around. Factory is closer to OmX in role (workflow layer) but plays harness too. The *separation* matters: clawhip exists explicitly to keep status formatting and notifications **out of the agent context window**.

This is a real insight. Factory currently writes progress to stderr inside the agent invocation; if that progress balloons, it eats context. Routing it elsewhere (a sidecar process, a webhook, a dashboard) is unimplemented.

## 12. Memory — context loading, not learned memory

Claw-code is the negative space of memory: **it consciously doesn't have any.** The contrast with claurst is what makes the pattern worth naming.

### 12.1 What claw-code does have — static project context loading

`runtime/src/prompt.rs` walks specific filenames and injects them into the system prompt at session start:

```rust
// In prompt.rs, the project context loader walks:
dir.join("CLAUDE.md"),
dir.join("CLAUDE.local.md"),
dir.join(".claw").join("CLAUDE.md"),
```

The `ProjectContext` struct that gets injected:

```rust
pub struct ProjectContext {
    pub cwd: PathBuf,
    pub current_date: String,
    pub git_status: Option<String>,
    pub git_diff: Option<String>,
    pub git_context: Option<GitContext>,
    pub instruction_files: Vec<ContextFile>,  // CLAUDE.md, CLAUDE.local.md, etc.
}
```

So every worker-boot loads:
- The user-curated `CLAUDE.md` files (instruction)
- Live git status and diff (current state)
- Working directory and date (environment)

This is **static context**. Nothing here is learned by the agent across sessions. Nothing is written back. The agent's knowledge of the project is exactly what's in the repo right now.

### 12.2 What claw-code uses for context-window management — *not* memory

`runtime/src/summary_compression.rs` is sometimes mistaken for a memory subsystem because of "summary" in the name. It isn't:

```rust
pub struct SummaryCompressionBudget {
    pub max_chars: usize,    // default 1200
    pub max_lines: usize,    // default 24
    pub max_line_chars: usize,  // default 160
}

pub fn compress_summary(summary: &str, budget: SummaryCompressionBudget) -> SummaryCompressionResult {
    // normalize lines, dedupe, truncate, omit
}
```

This is a **truncation utility**. It takes a string summary and shrinks it under a character/line budget. It doesn't persist anything. It doesn't extract anything. It's the moral equivalent of `head -n 24` with deduplication.

`conversation.rs` has an `AUTO_COMPACTION_THRESHOLD_ENV_VAR` for context-compaction triggers — same category. Compaction ≠ memory.

### 12.3 What claw-code consciously omits

There's no equivalent of:
- `memdir` (typed memory taxonomy, frontmatter parsing, freshness annotation, scan-and-inject)
- `session_memory` (post-session fact extraction with categorized output)
- `AutoDream` (background consolidation across sessions)

Search results for memory-pattern keywords across `runtime/src/` come up empty — no `memdir`, no `consolidat*`, no `extract_memor*`, no `learned_*`, no `auto_dream`. The closest hit is `session.rs` which manages session lifecycle (start/stop/resume) but holds no learned content.

### 12.4 Why this is consistent

Per `PHILOSOPHY.md`:

> "The code is evidence. The coordination system is the product lesson."

Claw-code's worker model is **stateless and replaceable**. A claw spawns from a Discord directive, reads `CLAUDE.md` + git context + the task packet, does its work, commits, exits. If the same directive is re-issued an hour later, a fresh claw spawns — and that's *desirable*. The repo is the source of truth; nothing learned outside the repo is supposed to persist.

This works because:
- Workers are short-lived
- Recovery is scenario-based (recovery recipes), not memory-based
- Multi-agent coordination is via clawhip events, not shared scratchpads
- Discord is the long-lived state holder; the system stays out of it

In this design, learned memory would be a **liability**: it would create state divergence between workers, hide failures behind "but this worker remembered X," and undermine the "every claw is replaceable" property.

### 12.5 What this teaches us about when memory matters

The two repos make a crisp tradeoff:

| | Claurst | Claw-code |
|---|---|---|
| Worker model | Single long-lived TUI session | Many short-lived parallel workers |
| Continuity expectation | High (single user, evolving understanding) | Low (each task fresh) |
| Source of truth | memdir + repo | Repo only |
| Failure model | Learn from failures via session_memory | Recover via scenario recipes |
| Memory infrastructure | 2,000+ lines, three subsystems | None (intentional) |
| Cost of being wrong | Lost continuity, slower over time | Slower per-task, but no drift |

**Factory sits in the middle.** A factory pipeline is not a single long-lived session — packets are short-lived, like claw-code's lanes. But factory's *project* is long-lived; the intent → packets decomposition happens many times over the project's life, and each pipeline run *would* benefit from carrying forward what previous runs learned about the codebase.

The right read is: factory's worker layer (per-packet) is claw-code-shaped, but factory's project layer (across runs) is claurst-shaped. **Both kinds of memory matter, but at different scopes.**

---

## 13. What's *not* there

Things factory has that claw-code lacks:

- **Pipeline-style sequential lifecycle.** Claw-code's lanes are concurrent and asynchronous; factory's pipeline is sequential per packet.
- **Single-binary deterministic invocation.** `npx tsx tools/run.ts <intent-id>` does the whole pipeline in one command. Claw-code's run is a multi-process distributed system across OmX/clawhip/OmO.
- **Reproducibility guarantees.** Factory's pipeline is idempotent. Claw-code's is more stateful — typed events, ledgers, tickets.

These tradeoffs are deliberate. Claw-code is built for autonomous long-running work; factory is built for governed, reviewable, reproducible work.

## 14. Patterns of interest for factory

Listed; no recommendations yet — synthesis comes after.

| Pattern | Where | Worth examining for factory? |
|---|---|---|
| Typed lane events with provenance labels | `lane_events.rs` | Yes — factory's run records are too coarse. |
| Specific failure classifier (12 categories) | `LaneFailureClass` | Yes — factory had 3 then deleted them. |
| Scenario-specific recovery recipes (vs generic retry) | `recovery_recipes.rs` | Yes — factory deleted retry, hasn't replaced it with anything scenario-aware. |
| Graded verification (Green Contract) | `green_contract.rs` | Yes — factory has binary pass/fail. |
| Per-packet policies (branch / commit / reporting / escalation) | `task_packet.rs` | Maybe — depends on whether factory wants per-packet customization. |
| Validated newtype pattern for input types | `ValidatedPacket(TaskPacket)` | Yes — factory's tools re-validate ad hoc. |
| Configurable policy engine (DSL with And/Or conditions) | `policy_engine.rs` | Maybe — factory's hardcoded policy is simpler but less extensible. |
| Trust resolver with allowlist auto-trust | `trust_resolver.rs` | Probably no — factory is pre-permission-prompt. |
| Branch correctness gates as first-class runtime | `stale_branch.rs`, `branch_lock.rs` | Yes — factory delegates all of this to agents. |
| Doctor / preflight unified diagnostic | `claw doctor` | Yes — factory has fragmentation here. |
| PRD as a single file with story array, priorities, passes flag | `prd.json` | Yes — factory's intent artifact could absorb this shape. |
| Hardened version next to basic version | `mcp_lifecycle_hardened.rs` | Probably no — factory tools are small enough not to need this. |
| Notifications/status routed outside the agent context window | clawhip role | Yes — factory has a context-bloat risk here. |
| Three-component decomposition (workflow / router / harness) | OmX + clawhip + OmO | Conceptually interesting, structurally unclear for factory. |
| Static project-context loading (CLAUDE.md + CLAUDE.local.md + .claw/CLAUDE.md) | `prompt.rs` ProjectContext | Yes — factory loads fewer files. Useful pattern even without learned memory. |
| Conscious *absence* of learned memory in short-lived-worker designs | (the negative case) | Yes — informs which scope deserves memory in factory (pipeline-level no, project-level yes). |

---

## 15. Quick stats for reference

- 10 Rust workspace crates; the `runtime` crate alone has 40+ files
- `prd.json`: 24 stories, P0/P1/P2 priorities, sequential phase numbering (Phase 1.6 → Phase 5)
- 22 typed lane event variants
- 12 typed failure classes
- 7 known failure scenarios with recovery recipes
- 4 green-contract verification levels
- Three-part system framing: OmX (workflow) + clawhip (event router) + OmO (multi-agent)
- Primary human interface: Discord, not a terminal
