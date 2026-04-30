# Research Audit — `claurst`

**Source:** `/Users/andyhunter/localrepositories/claurst`
**Surveyed:** 2026-04-30
**Surface:** ~13 MB, 266 files, 205 Rust files across 12 workspace crates
**License:** GPL-3.0
**One-line description:** Open-source Rust reimplementation of Claude Code — clean-room reverse-engineering started from a `spec/` directory, evolved into a TUI pair programmer with multi-provider support and a manager-executor orchestration mode.

---

## 1. What it is

Claurst is a TUI coding agent. The repo reads as four layers stacked:

1. **A spec layer** (`spec/`) — 15 markdown files, ~990 KB total, documenting Claude Code's behavior (entry/query loop, 100+ slash commands, 40+ tools, all React hooks, Ink terminal framework, bridge protocol, every constant). This was the input to the implementation.
2. **A core implementation** (`src-rust/crates/`) — Rust workspace mirroring the spec's structure crate-for-crate.
3. **A TUI / runtime** — terminal UI, query loop, plugin/MCP/ACP support.
4. **A divergence layer** — features that go beyond Claude Code parity: multi-provider, managed agents, plugin system, companion ("Rustle" the crab), chat forking, memory consolidation, voice modes.

It started as a port; it now treats Claude Code as one provider behavior among many.

## 2. Workspace structure

```
src-rust/
  Cargo.toml           # workspace root
  crates/
    core/              # message/agent core types
    query/             # the run_query_loop — the central agent loop
    tools/             # 40+ tool implementations (BashTool, FileEditTool, AgentTool, ...)
    commands/          # 100+ slash commands
    tui/               # terminal UI (Ink-port-style)
    cli/               # CLI entrypoint
    api/               # HTTP API surface
    bridge/            # CLI ↔ Remote bridge (SSE/WebSocket/Hybrid)
    plugins/           # plugin system
    mcp/               # MCP client/server support
    buddy/             # Rustle companion (Tamagotchi-style)
    acp/               # Agent Communication Protocol
```

Twelve crates is more than factory has tools. The split is by *concern*, not by lifecycle phase. This is the opposite of factory's structure (factory's tools are split by *what they do in the pipeline*: plan, start, complete, etc., not by concern).

## 3. Core pattern — `run_query_loop` as the only loop

> **Claurst has exactly one orchestration loop.** Everything that talks to a model goes through `run_query_loop` with a `QueryConfig`.

Sub-agents, slash commands that invoke a model, the manager in managed-agents mode — they're all `run_query_loop` calls with different configs. From `plan.md`:

> "Manager IS the query loop — no new loop type. The manager's `QueryConfig` uses the manager model; executor spawns use `AgentTool` with the executor model override."

This is a **strong design constraint**. Adding orchestration capability never adds new loops; it adds new configurations of the one loop. Factory has multiple lifecycles (plan, dev, review, qa, finalize) executed inside `run.ts`, but the `run.ts` pipeline is itself a single loop calling agents through a uniform interface — so factory has a similar shape, but doesn't enforce it as a rule the way claurst does.

## 4. The Managed Agents architecture (recent work, `plan.md`)

This is the most directly relevant pattern for factory. From the Apr 2026 plan:

### 4.1 Manager-Executor model

A larger "manager" model (Opus, Pro, o1) delegates work to smaller, cheaper "executor" models (Sonnet, Flash, Haiku) via the existing `AgentTool` infrastructure. The manager reasons; executors do.

```
User Input
    |
    v
+-------------------+
|   Manager Model   |   Opus / Pro / o1
|  system prompt:   |
|  "You delegate    |
|   to executors"   |
+-------------------+
    |          |          |
    | AgentTool(model=sonnet) ...
    v          v          v
+--------+ +--------+ +--------+
| Exec 1 | | Exec 2 | | Exec 3 |
+--------+ +--------+ +--------+
    |          |          |
    +----------+----------+
               |
               v
       Manager synthesizes
               |
               v
       Final Response
```

### 4.2 The `ManagedAgentConfig` data model

```rust
pub struct ManagedAgentConfig {
    pub enabled: bool,
    pub manager_model: String,                 // "anthropic/claude-opus-4"
    pub executor_model: String,                // "anthropic/claude-sonnet-4"
    pub executor_max_turns: u32,
    pub max_concurrent_executors: u32,
    pub budget_split: BudgetSplitPolicy,       // Percentage | FixedCaps | SharedPool
    pub total_budget_usd: Option<f64>,
    pub preset_name: Option<String>,
    pub executor_isolation: bool,              // worktree isolation
}
```

### 4.3 Pre-built presets

The plan ships six presets that name common combinations:

| Preset | Manager | Executor | Note |
|---|---|---|---|
| `anthropic-tiered` | opus-4 | sonnet-4 | same-provider, cost-optimized |
| `google-tiered` | gemini-2.5-pro | gemini-2.5-flash | same-provider Google |
| `cross-opus-flash` | opus-4 | gemini-2.5-flash | cheapest cross-provider |
| `cross-pro-sonnet` | gemini-2.5-pro | sonnet-4 | cross-provider alternative |
| `budget` | sonnet-4 | haiku-4 | lowest cost |
| `custom` | (user picks) | (user picks) | interactive setup |

Naming the combinations gives users a vocabulary. Factory currently lets users configure `pipeline.persona_providers` per persona but has no preset concept — every project hand-rolls its tier mapping.

### 4.4 Budget splitting

`BudgetSplitPolicy` is a real first-class concept:

```rust
pub enum BudgetSplitPolicy {
    Percentage { manager_pct: u8 },                   // 30% manager, 70% executors
    FixedCaps { manager_usd: f64, executor_usd: f64 },
    SharedPool,                                       // no split, default
}
```

The manager and executors share an `Arc<CostTracker>` and the loop checks the policy on every spawn. Factory has zero cost awareness — no per-run budget, no per-persona budget, no cap.

### 4.5 Worktree isolation per executor

`executor_isolation: bool` — when true, each executor runs in its own git worktree. This is a clean primitive for parallel execution that doesn't fight over the working tree.

Factory's pipeline runs sequentially (dev → review → qa per packet, then next packet). Worktree isolation would unlock parallelism that factory cannot do today.

### 4.6 Manager prompt is the orchestration logic

The plan includes a "Managed Agent Mode" section that **is the manager's system prompt**. The orchestration logic lives in natural language, not in code. Sample structure:

> ```
> ## Your Role
> You are a manager. You delegate execution to specialized agents.
> ## Workflow
> 1. Understand the user's request
> 2. Decompose into discrete sub-tasks
> 3. Spawn an executor per sub-task via AgentTool
> 4. Review executor outputs; spawn additional executors if needed
> 5. Synthesize a final answer
> ## Executor Configuration
> {{executor_model}} can do X but not Y. Spawn it with max_turns={{executor_max_turns}}.
> ## Budget
> You have ${{remaining_budget}}. Manager budget: ${{manager_budget}}.
> ```

Two consequences:

- **The orchestration policy is editable without redeploying code.** Change the prompt, change the orchestrator's behavior.
- **Different presets can ship different prompts.** Different "personalities" for different problems.

Factory's orchestration is *all* in code (run.ts state machine, prompt builders). The agents have minimal autonomy in deciding work decomposition.

## 5. Spec-as-input methodology

The `spec/` directory deserves attention as a *method*, not as content.

It documents Claude Code's behavior in such detail that the implementation became mechanical:

- 13 numbered files (00–13), each ~60–95 KB
- Indexed by `INDEX.md` with a "Where is X documented?" lookup table
- File 13 (`13_rust_codebase.md`, 63 KB) is the spec for **the Rust port itself** — the spec authored after the spec, defining the target codebase

**This is the same primitive factory wants:** an authoritative, structured input that the planner can decompose. Factory has `intents/` with `spec` or `spec_path`, but the *form* of that spec is unconstrained markdown. Claurst's spec method shows what a *highly structured* spec looks like.

The `INDEX.md` lookup pattern ("where is X documented?") is also notable — it's the one-entry-per-concept index analog to factory's `MEMORY.md`.

## 6. Slash commands as the user-facing extension surface

Claurst exposes ~100 slash commands. The `commands/` crate lists them all. Each is a struct implementing `SlashCommand`:

```rust
#[async_trait]
impl SlashCommand for ManagedAgentsCommand {
    fn name(&self) -> &str { "managed-agents" }
    fn aliases(&self) -> Vec<&str> { vec!["ma"] }
    fn description(&self) -> &str { "..." }
    async fn execute(&self, args: &str, ctx: &mut CommandContext) -> CommandResult { ... }
}
```

Slash commands handle the configure/setup/status/disable/preset subcommand pattern uniformly. Factory has `tools/*.ts` files that are CLI entries, but no shared "subcommand within a tool" abstraction. Every factory tool reinvents argument parsing.

## 7. Provider abstraction

A `ProviderRegistry` (in core) holds multiple provider implementations simultaneously. `QueryConfig.provider_registry` carries it through; each `run_query_loop` call resolves its own provider. This is what enables cross-provider managed-agent setups in a single session.

Factory's pipeline config has `persona_providers` mapping personas to one provider each at config time. There's no runtime registry, and a pipeline run can't mix providers per packet beyond the per-persona mapping.

## 8. Plan-driven implementation

`plan.md` is a 1000+ line implementation roadmap for managed agents. It includes:

- Architecture (Sec 2): mermaid-style ASCII diagrams, design decisions
- Implementation phases (Sec 3): six numbered phases with **per-phase checklists**
- Risk assessment (Sec 4): high/medium/low risk items
- Cost analysis (Sec 5): estimated USD per interaction with concrete numbers
- Provider compatibility matrix (Sec 6): cross-provider constraints
- File change summary (Sec 7): touch list for every phase
- Timeline estimate (Sec 8)

It's a *living artifact* tracked in git. Phase checklists with `[ ]` items are checked off as work lands. This is essentially a richer version of factory's `intent` artifact — but written by a human as the plan, not by an agent during planning. Factory currently has no equivalent: the planner agent produces packets but doesn't produce a single readable plan document.

## 9. What's *not* there

Things factory has that claurst lacks:

- **Verification gates.** No equivalent to factory's `complete.ts` build/lint/test enforcement. Claurst is a pair programmer; it doesn't enforce that work passed CI before "completing" a task.
- **Identity separation.** No FI-7 equivalent — the same model can do dev and review.
- **Pipeline / lifecycle artifacts.** No notion of features → packets → completions written to disk as governance trail.
- **Acceptance criteria as schema.** Acceptance is conversational, not structured.

This makes sense: claurst is a *pair programmer*, factory is a *governed work pipeline*. Different problems.

## 10. Patterns of interest for factory

Listed; no recommendations yet — synthesis comes after the claw-code report.

| Pattern | Where | Worth examining for factory? |
|---------|-------|------------------------------|
| Single uniform agent loop, all orchestration is loop config | `run_query_loop` | Likely. Factory has this implicitly; could be made explicit. |
| Manager-Executor with budget splitting | `ManagedAgentConfig` | Yes — directly applicable to factory's persona model. |
| Worktree-per-executor isolation | `executor_isolation` | Yes — would unlock parallelism factory can't do today. |
| Pre-built provider presets with vocabulary names | `builtin_presets()` | Yes — easy win. |
| Orchestration policy as system prompt (editable, swappable) | manager prompt | Maybe — factory's policy is in code, not text. Tradeoff. |
| Spec-as-input methodology with index file | `spec/INDEX.md` | Already partially adopted via `docs/decisions/MEMORY.md`. |
| Slash command framework with subcommand dispatch | `SlashCommand` trait | Probably no — factory tools are CLI entries, audience differs. |
| Plan.md as a living implementation roadmap with phase checklists | `plan.md` | Yes — factory's intent artifact could grow toward this shape. |
| Cost tracking shared across nested agent calls | `Arc<CostTracker>` | Yes — factory has none today. |

---

## 11. Quick stats for reference

- 12 workspace crates, all named for concerns (not lifecycle phases)
- 100+ slash commands, 40+ tools, 30+ providers (per README)
- Spec coverage: ~990 KB across 15 numbered markdown files
- `plan.md` for one feature: ~1000 lines, 6 implementation phases, per-phase checklists
- Recent direction: `/managed-agents` — add manager-executor as a configurable mode, not a new architecture
