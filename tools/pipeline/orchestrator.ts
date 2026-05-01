/**
 * Factory — Pipeline / Orchestrator (driver layer)
 *
 * Phase 5 of specs/single-entry-pipeline.md. Multi-spec dependency-
 * aware sequencing.
 *
 *   npx tsx tools/run.ts <spec-1> <spec-2> <spec-3>
 *
 * Each argument resolves to a spec or legacy intent. Specs declare
 * `depends_on` in their frontmatter; the orchestrator topologically
 * sorts the resolved set and runs each spec's pipeline (plan ->
 * develop -> verify) in dependency order.
 *
 * RESPONSIBILITIES (driver layer per docs/decisions/single_entry_pipeline.md):
 *
 *   - Resolve every CLI arg to a spec/intent (reuse resolveRunArg).
 *   - Build the dependency graph from spec frontmatter (intents have
 *     no depends_on by definition; treat as []).
 *   - Detect missing-target deps before any agent invocation.
 *   - Detect cycles before any agent invocation.
 *   - Topologically sort using the existing topoSort primitive.
 *   - Run each spec sequentially via runPlanPhase / runDevelopPhase /
 *     runVerifyPhase. The orchestrator does NOT re-implement per-
 *     spec execution; it sequences the existing phase functions.
 *   - Propagate spec failures: if any depends_on of a spec failed
 *     or was blocked, the spec is itself blocked and not attempted.
 *   - Aggregate per-spec outcomes for the caller to render.
 *
 * NON-RESPONSIBILITIES:
 *
 *   - Per-spec recovery / retry — Phase 6.
 *   - Parallel execution — deferred per the spec.
 *   - Transitive-dep auto-resolution — the user passes all needed
 *     spec IDs explicitly; missing transitive deps are an error.
 *   - Recovery / event emission / cost — later phases.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryConfig } from '../config.js';
import type { Feature, RawPacket } from '../execute.js';
import type { RawIntentArtifact } from '../plan.js';
import { hydrateIntent } from '../plan.js';
import * as fmt from '../output.js';
import { resolveRunArg } from './resolve_arg.js';
import { runPlanPhase } from './plan_phase.js';
import { runDevelopPhase } from './develop_phase.js';
import { runVerifyPhase } from './verify_phase.js';
import { topoSort } from './topo.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  readonly args: ReadonlyArray<string>;
  readonly config: FactoryConfig;
  readonly projectRoot: string;
  readonly artifactRoot: string;
  readonly dryRun: boolean;
}

export type SpecOutcome =
  | {
      readonly id: string;
      readonly status: 'completed';
      readonly feature_id: string | null;
      readonly packets_completed: ReadonlyArray<string>;
      readonly packets_failed: ReadonlyArray<string>;
    }
  | {
      readonly id: string;
      readonly status: 'failed';
      readonly feature_id: string | null;
      readonly packets_completed: ReadonlyArray<string>;
      readonly packets_failed: ReadonlyArray<string>;
      readonly reason: string;
    }
  | {
      readonly id: string;
      readonly status: 'blocked';
      readonly blocked_by: ReadonlyArray<string>;
      readonly reason: string;
    };

export interface OrchestratorResult {
  readonly specs: ReadonlyArray<SpecOutcome>;
  /** True iff every spec resolved successfully and finished with `completed`. */
  readonly success: boolean;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Module-private fs helpers (mirror of the originals in run.ts and the
// phase modules; see plan_phase.ts for the rationale on why these are
// duplicated rather than centralised).
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; }
  catch { return null; }
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<T>(join(dir, f)))
    .filter((x): x is T => x !== null);
}

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Best-effort JSON patch: applies the mutator to the parsed file
 * contents and writes back only when the mutator returns true (the
 * dirty-flag contract pinned by run.test.ts).
 */
function patchJson(
  path: string,
  mutator: (data: Record<string, unknown>) => boolean,
): void {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const dirty = mutator(data);
    if (dirty) {
      writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Resolution: each CLI arg -> ResolvedSpec node for the topo graph
//
// Internal helpers below are exported with a leading underscore so the
// orchestrator's public surface stays narrow (runOrchestrator + types)
// while still letting unit tests pin the resolution / cycle / missing-
// dep behaviors that the public function relies on. Renaming or
// removing an underscore-prefixed export still requires a matching
// test update — they are NOT private to this file.
// ---------------------------------------------------------------------------

export interface ResolvedSpec {
  readonly id: string;
  /** depends_on as declared in the spec (always [] for legacy intent inputs). */
  readonly dependsOn: ReadonlyArray<string>;
  readonly intentPath: string;
  readonly source: 'spec' | 'intent';
}

export interface ResolveAllOk {
  readonly ok: true;
  readonly resolved: ReadonlyArray<ResolvedSpec>;
}

export interface ResolveAllError {
  readonly ok: false;
  readonly error: string;
}

/**
 * Resolve every CLI arg via `resolveRunArg`, deduping repeated args by
 * id. Bails on the first resolution error. Results are returned in the
 * order each unique id first appeared in `args` (the topo sort below
 * is order-independent, but we want a stable trace).
 *
 * Exported for testing.
 */
export function _resolveAll(
  args: ReadonlyArray<string>,
  artifactRoot: string,
  projectRoot: string,
): ResolveAllOk | ResolveAllError {
  if (args.length === 0) {
    return { ok: false, error: 'No spec or intent ids supplied' };
  }
  const seen = new Set<string>();
  const out: ResolvedSpec[] = [];
  for (const arg of args) {
    if (seen.has(arg)) continue;
    seen.add(arg);
    const r = resolveRunArg(arg, artifactRoot, projectRoot);
    if (!r.ok) {
      return { ok: false, error: r.error };
    }
    out.push({
      id: arg,
      dependsOn: r.dependsOn ?? [],
      intentPath: r.intentPath,
      source: r.source,
    });
  }
  return { ok: true, resolved: out };
}

// ---------------------------------------------------------------------------
// Cycle detection — runs BEFORE any agent invocation.
//
// Pattern adapted from the validateSpecCycles helper in
// pipeline/integrity.ts. The integrity layer reports cycles for spec-
// validation purposes; here we need a yes/no answer that lets the
// orchestrator bail before doing any work.
// ---------------------------------------------------------------------------

export interface CycleReport {
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
}

/** Exported for testing — pin cycle-detection behavior independently of runOrchestrator. */
export function _detectCycles(
  resolved: ReadonlyArray<ResolvedSpec>,
): CycleReport {
  const graph = new Map<string, ReadonlyArray<string>>();
  for (const s of resolved) graph.set(s.id, s.dependsOn);

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const reported = new Set<string>();

  function dfs(node: string): void {
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue; // missing target — handled elsewhere
      if (!visited.has(dep)) {
        dfs(dep);
      } else if (onStack.has(dep)) {
        // Back-edge: dep is somewhere on the current DFS stack.
        const cycleStart = stack.indexOf(dep);
        const cycleMembers = stack.slice(cycleStart);
        // Self-loop: stack has [..., dep]; cycleStart finds dep, members = [dep].
        // We still report this as a cycle.
        const cycleKey = cycleMembers.slice().sort().join('|');
        if (!reported.has(cycleKey)) {
          reported.add(cycleKey);
          cycles.push([...cycleMembers, dep]);
        }
      }
    }
    onStack.delete(node);
    stack.pop();
  }

  for (const id of graph.keys()) {
    if (!visited.has(id)) dfs(id);
  }

  return { cycles };
}

function formatCycle(cycle: ReadonlyArray<string>): string {
  return cycle.join(' -> ');
}

// ---------------------------------------------------------------------------
// Missing transitive dependency detection
// ---------------------------------------------------------------------------

export interface MissingDep {
  readonly specId: string;
  readonly missingId: string;
}

/** Exported for testing — pin missing-dep detection independently of runOrchestrator. */
export function _findMissingDeps(
  resolved: ReadonlyArray<ResolvedSpec>,
): ReadonlyArray<MissingDep> {
  const ids = new Set(resolved.map((s) => s.id));
  const missing: MissingDep[] = [];
  for (const s of resolved) {
    for (const dep of s.dependsOn) {
      if (!ids.has(dep)) missing.push({ specId: s.id, missingId: dep });
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Per-spec execution
//
// Internally this is the same logic that lived in run.ts before Phase 5
// — load + hydrate the intent, call runPlanPhase / runDevelopPhase /
// runVerifyPhase, update feature status, return outcome. Extracting it
// here is what enables the multi-arg outer loop above.
// ---------------------------------------------------------------------------

type RunSpecOutcome =
  | {
      readonly status: 'completed';
      readonly feature_id: string | null;
      readonly packets_completed: ReadonlyArray<string>;
      readonly packets_failed: ReadonlyArray<string>;
    }
  | {
      readonly status: 'failed';
      readonly feature_id: string | null;
      readonly packets_completed: ReadonlyArray<string>;
      readonly packets_failed: ReadonlyArray<string>;
      readonly reason: string;
    };

function runSingleSpec(
  spec: ResolvedSpec,
  config: FactoryConfig,
  projectRoot: string,
  artifactRoot: string,
  dryRun: boolean,
): RunSpecOutcome {
  if (!existsSync(spec.intentPath)) {
    const msg = `Intent not found: ${spec.id}`;
    fmt.log('error', fmt.error(msg));
    return { status: 'failed', feature_id: null, packets_completed: [], packets_failed: [], reason: msg };
  }
  const rawIntent = readJson<RawIntentArtifact>(spec.intentPath);
  if (rawIntent === null) {
    const msg = `Failed to parse intent: ${spec.id}`;
    fmt.log('error', fmt.error(msg));
    return { status: 'failed', feature_id: null, packets_completed: [], packets_failed: [], reason: msg };
  }
  const hydrated = hydrateIntent(rawIntent, projectRoot, (p) => readFileSync(p, 'utf-8'));
  if (!hydrated.ok) {
    fmt.log('error', fmt.error(hydrated.error));
    return { status: 'failed', feature_id: null, packets_completed: [], packets_failed: [], reason: hydrated.error };
  }

  // Phase 1: Plan.
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('PLANNING'));
  const planResult = runPlanPhase({
    intent: hydrated.intent,
    config,
    artifactRoot,
    dryRun,
  });
  if (planResult.feature_id === null) {
    const msg = dryRun ? 'Dry run — planning would be invoked' : 'Planning failed';
    return {
      status: 'failed',
      feature_id: null,
      packets_completed: [],
      packets_failed: [],
      reason: msg,
    };
  }

  // Load the planned feature.
  const featurePath = join(artifactRoot, 'features', `${planResult.feature_id}.json`);
  const feature = readJson<Feature>(featurePath);
  if (feature === null) {
    const msg = `Failed to load feature: ${planResult.feature_id}`;
    fmt.log('error', fmt.error(msg));
    return {
      status: 'failed',
      feature_id: planResult.feature_id,
      packets_completed: [],
      packets_failed: [],
      reason: msg,
    };
  }

  // Early exit: feature already fully done.
  if (feature.status === 'completed' || feature.status === 'delivered') {
    const msg = `Feature '${feature.id}' is already ${feature.status}. Nothing to do.`;
    fmt.log('done', fmt.success(msg));
    return {
      status: 'completed',
      feature_id: feature.id,
      packets_completed: [...feature.packets],
      packets_failed: [],
    };
  }

  // Bump feature status to executing on first transition (best-effort).
  patchJson(featurePath, (d) => {
    if (d['status'] === 'planned') {
      d['status'] = 'executing';
      return true;
    }
    return false;
  });

  // Operator banner.
  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const featurePackets = packets.filter((p) => feature.packets.includes(p.id));
  const devCount = featurePackets.filter((p) => p.kind === 'dev').length;
  const qaCount = featurePackets.filter((p) => p.kind === 'qa').length;
  const existingCompletions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const existingCompletionIds = new Set(existingCompletions.map((c) => c.packet_id));
  const alreadyDone = featurePackets.filter((p) => existingCompletionIds.has(p.id)).length;
  fmt.log('plan', `Feature ${fmt.bold(feature.id)}: ${devCount} dev + ${qaCount} qa packets (${alreadyDone} already complete)`);

  // Phase 2: Develop.
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('DEVELOPMENT'));
  const devResult = runDevelopPhase({ feature, config, artifactRoot, projectRoot, dryRun });

  // Phase 3: Verify.
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('VERIFICATION'));
  const qaResult = runVerifyPhase({ feature, config, artifactRoot, projectRoot, dryRun });

  // Update feature status if all packets completed.
  const allCompleted = [...devResult.completed, ...qaResult.completed];
  const allFailed = [...devResult.failed, ...qaResult.failed];
  const allSkipped = qaResult.skipped;
  if (allFailed.length === 0 && allSkipped.length === 0 && !dryRun && allCompleted.length === feature.packets.length) {
    patchJson(featurePath, (d) => {
      d['status'] = 'completed';
      d['completed_at'] = timestamp();
      return true;
    });
  }

  const success = allFailed.length === 0 && allSkipped.length === 0;
  if (success) {
    return {
      status: 'completed',
      feature_id: feature.id,
      packets_completed: allCompleted,
      packets_failed: [],
    };
  }
  const reasonParts: string[] = [];
  if (allFailed.length > 0) reasonParts.push(`${allFailed.length} packet(s) failed: ${allFailed.join(', ')}`);
  if (allSkipped.length > 0) reasonParts.push(`${allSkipped.length} QA packet(s) skipped`);
  return {
    status: 'failed',
    feature_id: feature.id,
    packets_completed: allCompleted,
    packets_failed: allFailed,
    reason: reasonParts.join('; ') || 'Pipeline did not complete cleanly',
  };
}

// ---------------------------------------------------------------------------
// Public driver
// ---------------------------------------------------------------------------

/**
 * Run the orchestrator across one or more spec/intent ids. Returns
 * per-spec outcomes plus a top-level success flag and a renderable
 * message. Caller is responsible for writing to stdout/stderr and
 * choosing an exit code.
 *
 * Failure semantics:
 *
 *   - Resolution errors (missing spec/intent, parse error) are top-
 *     level failures: orchestrator returns success=false with no per-
 *     spec outcomes and a message describing the resolution problem.
 *   - Cycles are top-level failures: orchestrator returns success=
 *     false with no per-spec outcomes and a message naming the cycle.
 *   - Missing transitive deps are top-level failures: orchestrator
 *     returns success=false with a message naming the missing dep(s).
 *   - Within an executable run, per-spec failures are local: the
 *     spec's outcome is `failed`, and any spec that depends on it
 *     (transitively) becomes `blocked`. Independent specs continue.
 */
export function runOrchestrator(opts: OrchestratorOptions): OrchestratorResult {
  const { args, config, projectRoot, artifactRoot, dryRun } = opts;

  fmt.resetTimer();
  process.stderr.write(fmt.header('RUN', `[${config.project_name}]`) + '\n\n');

  // 1. Resolve every arg.
  const resolution = _resolveAll(args, artifactRoot, projectRoot);
  if (!resolution.ok) {
    fmt.log('error', fmt.error(resolution.error));
    return { specs: [], success: false, message: resolution.error };
  }
  const resolved = resolution.resolved;

  // 2. Detect missing transitive deps before any agent invocation.
  const missing = _findMissingDeps(resolved);
  if (missing.length > 0) {
    const lines = missing.map((m) => `'${m.specId}' depends_on '${m.missingId}' which was not given as an argument`);
    const msg = `Missing transitive dependency: ${lines.join('; ')}. Pass all transitive deps explicitly.`;
    fmt.log('error', fmt.error(msg));
    return { specs: [], success: false, message: msg };
  }

  // 3. Detect cycles before any agent invocation.
  const { cycles } = _detectCycles(resolved);
  if (cycles.length > 0) {
    const formatted = cycles.map(formatCycle).join('; ');
    const msg = `Cyclic spec dependency detected: ${formatted}. Resolve the cycle before running.`;
    fmt.log('error', fmt.error(msg));
    return { specs: [], success: false, message: msg };
  }

  // 4. Topo-sort using the existing primitive.
  const order = topoSort<ResolvedSpec>(
    resolved,
    (s) => s.id,
    (s) => s.dependsOn,
  );

  if (resolved.length > 1) {
    fmt.log('plan', `Multi-spec run: ${order.map((s) => s.id).join(' -> ')}`);
  }

  // 5. Sequential per-spec execution. Track outcomes so dependents can
  //    be marked blocked.
  const outcomeById = new Map<string, SpecOutcome>();
  const collected: SpecOutcome[] = [];

  for (const spec of order) {
    // Compute which (if any) of this spec's depends_on have already
    // failed or been blocked. Empty depsBlocked means we are clear to
    // run this spec.
    const depsBlocked: string[] = [];
    for (const dep of spec.dependsOn) {
      const prior = outcomeById.get(dep);
      if (prior !== undefined && prior.status !== 'completed') {
        depsBlocked.push(dep);
      }
    }
    if (depsBlocked.length > 0) {
      const reason = `Blocked by upstream spec(s) that did not complete: ${depsBlocked.join(', ')}`;
      const outcome: SpecOutcome = {
        id: spec.id,
        status: 'blocked',
        blocked_by: depsBlocked,
        reason,
      };
      outcomeById.set(spec.id, outcome);
      collected.push(outcome);
      process.stderr.write('\n');
      fmt.log('plan', fmt.warn(`Skipping '${spec.id}': ${reason}`));
      continue;
    }

    // Banner per spec when there's more than one.
    if (resolved.length > 1) {
      process.stderr.write('\n');
      fmt.log('plan', fmt.bold(`Spec: ${spec.id}`));
    }

    const result = runSingleSpec(spec, config, projectRoot, artifactRoot, dryRun);
    let outcome: SpecOutcome;
    if (result.status === 'completed') {
      outcome = {
        id: spec.id,
        status: 'completed',
        feature_id: result.feature_id,
        packets_completed: result.packets_completed,
        packets_failed: result.packets_failed,
      };
    } else {
      outcome = {
        id: spec.id,
        status: 'failed',
        feature_id: result.feature_id,
        packets_completed: result.packets_completed,
        packets_failed: result.packets_failed,
        reason: result.reason,
      };
    }
    outcomeById.set(spec.id, outcome);
    collected.push(outcome);
  }

  // 6. Aggregate.
  const allCompleted = collected.every((o) => o.status === 'completed');
  const totals = {
    completed: collected.filter((o) => o.status === 'completed').length,
    failed: collected.filter((o) => o.status === 'failed').length,
    blocked: collected.filter((o) => o.status === 'blocked').length,
  };
  const message = allCompleted
    ? `All ${totals.completed} spec(s) completed`
    : `${totals.completed} completed, ${totals.failed} failed, ${totals.blocked} blocked`;

  return { specs: collected, success: allCompleted, message };
}
