/**
 * Factory — Pipeline / Verify Phase
 *
 * Imperative orchestration of the QA agent: walk QA packets in
 * declaration order, skip those whose dev dependencies aren't
 * complete yet, invoke the QA provider, and complete on success.
 *
 * EXTRACTED FROM run.ts IN PHASE 4.5.
 *
 * The original function in tools/run.ts was named `qaPhase`. The
 * wrapping module is named verify_phase.ts to match the user-facing
 * "verification" terminology used throughout the spec; the public
 * function is `runVerifyPhase`. Behavior is byte-identical to the
 * pre-extraction loop.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, RawPacket } from '../execute.js';
import type { FactoryConfig, ModelTier } from '../config.js';
import * as fmt from '../output.js';
import { invokeAgent } from './agent_invoke.js';
import { computeCascade } from './cascade.js';
import { buildDevPrompt, buildQaPrompt } from './prompts.js';
import { loadMemoryContext } from './memory.js';
import { refreshCompletionId, safeCall } from './lifecycle_helpers.js';
import { startPacket } from '../lifecycle/start.js';
import { completePacket } from '../lifecycle/complete.js';
import { looksLikeStaleBranchMessage } from '../lifecycle/git_check.js';
import {
  makePhaseStarted,
  makePhaseCompleted,
  makeCostCapCrossed,
  makePacketFailed,
} from './events.js';
import { appendEvent } from '../events.js';
import type { InvokeResult } from './agent_invoke.js';
import type { CostRecord } from './cost.js';
import { checkCap } from './cost.js';
import { recordCost, localDateString } from '../cost.js';
import {
  failureFromSubprocess,
  failureFromThrow,
  newPacketRecoveryBudget,
  runWithRecovery,
  type AttemptContext,
  type GitRunner,
  type OperationResult,
  type RecoveryResult,
} from './recovery_loop.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerifyPhaseOptions {
  readonly feature: Feature;
  readonly config: FactoryConfig;
  readonly artifactRoot: string;
  readonly projectRoot: string;
  readonly dryRun: boolean;
  /**
   * Phase 5.5 — events plumbing. When present, the phase emits
   * `phase.started` / `phase.completed` events at its boundaries.
   * Optional so existing verify-phase unit tests don't have to
   * construct an events context.
   *
   * Provenance is NOT passed in — it is derived inside the events
   * envelope from `dryRun` via deriveProvenance. (Round-2 invariant
   * pin: callers cannot supply a free-form provenance value.)
   */
  readonly runId?: string;
  readonly specId?: string | null;
  /**
   * Phase 6 — injectable git runner for the StaleBranch recovery
   * action AND the lifecycle stale-branch detection (forwarded to
   * `completePacket` via its `gitRunner` option). Production callers
   * omit it; tests inject a stub.
   */
  readonly gitRunner?: GitRunner;
}

export interface VerifyPhaseResult {
  readonly completed: string[];
  readonly failed: string[];
  /**
   * Packets skipped because their dev dependency (or `verifies`
   * target) is not yet completed. The original loop reported these
   * separately from outright failures so the operator knows the
   * difference between "QA agent failed" and "QA hasn't been
   * attempted yet because the dev side isn't done".
   */
  readonly skipped: string[];
}

function packetIntentText(packet: RawPacket): string | null {
  const maybeIntent = (packet as unknown as { readonly intent?: unknown }).intent;
  return typeof maybeIntent === 'string' ? maybeIntent : null;
}

// ---------------------------------------------------------------------------
// Module-private fs helpers (mirror of the originals in run.ts).
// See plan_phase.ts for the same rationale: a shared fs module is
// out of scope for Phase 4.5.
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

// ---------------------------------------------------------------------------
// Cost recording + per-packet cap enforcement (Phase 5.7)
//
// Mirrors the helper in develop_phase.ts. The QA path only invokes
// the agent once per packet, so the per-packet tracker is effectively
// a single-shot here. We still use the same shape so the contract is
// uniform across phases — simpler for Phase 6 recovery to consume.
// ---------------------------------------------------------------------------

interface PacketCostTracker {
  total: number;
  crossed: boolean;
}

function newPacketCostTracker(): PacketCostTracker {
  return { total: 0, crossed: false };
}

function recordInvocationCost(
  invokeResult: InvokeResult,
  runId: string | undefined,
  packetId: string | null,
  specId: string | null,
  artifactRoot: string,
  perPacketCap: number | undefined,
  tracker: PacketCostTracker,
  dryRun: boolean,
): { capCrossed: boolean } {
  if (runId === undefined) return { capCrossed: false };
  const record: CostRecord = {
    run_id: runId,
    packet_id: packetId,
    spec_id: specId,
    provider: invokeResult.cost.provider,
    model: invokeResult.cost.model,
    tokens_in: invokeResult.cost.tokens_in,
    tokens_out: invokeResult.cost.tokens_out,
    dollars: invokeResult.cost.dollars,
    timestamp: new Date().toISOString(),
  };
  recordCost(record, artifactRoot);

  if (invokeResult.cost.dollars !== null) {
    tracker.total += invokeResult.cost.dollars;
  }
  if (!tracker.crossed && checkCap(tracker.total, perPacketCap)) {
    tracker.crossed = true;
    appendEvent(
      makeCostCapCrossed(
        { run_id: runId, dry_run: dryRun },
        {
          scope: 'per_packet',
          cap_dollars: perPacketCap as number,
          running_total: tracker.total,
          packet_id: packetId,
          spec_id: specId,
        },
      ),
      artifactRoot,
    );
    return { capCrossed: true };
  }
  return { capCrossed: false };
}

// ---------------------------------------------------------------------------
// Packet escalation (Phase 6) — same shape as develop_phase.
// ---------------------------------------------------------------------------

interface MarkPacketFailedArgs {
  readonly packetId: string;
  readonly artifactRoot: string;
  readonly recovery: RecoveryResult<unknown> & { readonly kind: 'escalated' };
  readonly runId: string | undefined;
  readonly dryRun: boolean;
}

function markPacketFailed(args: MarkPacketFailedArgs): void {
  const { packetId, artifactRoot, recovery, runId, dryRun } = args;
  try {
    const packetPath = join(artifactRoot, 'packets', `${packetId}.json`);
    if (existsSync(packetPath)) {
      const data = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
      data['status'] = 'failed';
      data['failure'] = {
        scenario: recovery.scenario,
        reason: recovery.reason,
        attempts: recovery.attempts,
        escalation_path: recovery.escalation_path,
      };
      writeFileSync(packetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    }
  } catch { /* best-effort */ }
  if (runId !== undefined) {
    appendEvent(
      makePacketFailed(
        { run_id: runId, dry_run: dryRun },
        {
          packet_id: packetId,
          reason: `${recovery.scenario}: ${recovery.reason}`,
        },
      ),
      artifactRoot,
    );
  }
}

// ---------------------------------------------------------------------------
// runVerifyPhase
// ---------------------------------------------------------------------------

/**
 * Run the verify phase for a feature: invoke the QA agent on each
 * QA packet whose dev dependency is complete, then complete the
 * packet. Returns the lists of completed, failed, and skipped
 * packet ids.
 *
 * Async since the convergence pass migrated `invokeAgent` to a
 * Promise-returning shape so long agent runs can yield to heartbeats.
 */
export async function runVerifyPhase(opts: VerifyPhaseOptions): Promise<VerifyPhaseResult> {
  const { feature, config, artifactRoot, projectRoot, dryRun } = opts;

  // Phase 5.5: emit phase.started at entry. Best-effort.
  //
  // Round-2 invariant: callers pass `dry_run` (a hint), never a
  // pre-derived provenance. The pure constructors call
  // deriveProvenance internally — VITEST > dryRun > live_run.
  const eventCtx = opts.runId !== undefined
    ? { run_id: opts.runId, dry_run: opts.dryRun }
    : null;
  if (eventCtx !== null) {
    appendEvent(
      makePhaseStarted(eventCtx, { phase: 'verify', spec_id: opts.specId ?? null }),
      artifactRoot,
    );
  }

  const result = await runVerifyPhaseInner(opts);

  if (eventCtx !== null) {
    // Outcome: 'failed' if any QA packet failed; 'ok' otherwise.
    // Skipped packets are NOT failures here — they're a sequencing
    // signal (dev-not-yet-complete) reflected in the `skipped` list.
    appendEvent(
      makePhaseCompleted(eventCtx, {
        phase: 'verify',
        spec_id: opts.specId ?? null,
        outcome: result.failed.length === 0 ? 'ok' : 'failed',
      }),
      artifactRoot,
    );
  }
  return result;
}

async function runVerifyPhaseInner(opts: VerifyPhaseOptions): Promise<VerifyPhaseResult> {
  const { feature, config, artifactRoot, projectRoot, dryRun } = opts;

  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const completions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const completionIds = new Set(completions.map((c) => c.packet_id));

  const qaPackets = packets.filter((p) => p.kind === 'qa' && feature.packets.includes(p.id));
  const completed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  fmt.log('verify', `${qaPackets.length} QA packet(s) to process`);

  // Phase 7 — `persona_providers.<persona>` is an ordered list after
  // loader normalization. Index 0 is the PRIMARY CLI; the rest form
  // the cross-CLI failover order consumed by the ProviderUnavailable
  // cascade. Read [0] for the initial invocation.
  const qaProvider = config.pipeline?.persona_providers.qa[0] ?? 'claude';
  const qaTier: ModelTier = config.personas.qa.model ?? 'medium';
  const qaIdentity = config.pipeline?.completion_identities.qa ?? 'claude-qa';
  // For BuildFailed remediation in the QA flow, the dev agent must
  // be invoked against the DEV packet (the `verifies` target), NOT
  // the QA packet. Resolve the developer config up front.
  const devProvider = config.pipeline?.persona_providers.developer[0] ?? 'codex';
  const devTier: ModelTier = config.personas.developer.model ?? 'high';
  // Phase 7 — compute persona cascades once. Closures attach these
  // to every failure context so the ProviderUnavailable recipe can
  // walk the failover order.
  const qaCascade = computeCascade('qa', qaTier, config);
  const devCascade = computeCascade('developer', devTier, config);
  // Phase 7 round-2 fix — the PRIMARY attempt is `cascade[0]`. See
  // develop_phase.ts for full rationale.
  const qaPrimary = qaCascade[0] ?? { provider: qaProvider, model: undefined };
  const devPrimary = devCascade[0] ?? { provider: devProvider, model: undefined };

  for (const packet of qaPackets) {
    // Same external-mutation model as the develop phase: an external
    // agent may have invoked complete.ts directly on this packet
    // since the phase-start scan. Refresh before the early-exit check.
    refreshCompletionId(completionIds, packet.id, artifactRoot);

    if (completionIds.has(packet.id)) {
      fmt.log('verify', `${fmt.sym.ok} ${packet.id} — already complete`);
      completed.push(packet.id);
      continue;
    }

    // Phase 6 — a QA packet already marked failed (e.g. by a prior
    // run's recovery escalation) is not retried.
    if (packet.status === 'failed') {
      fmt.log('verify', `${fmt.sym.fail} ${packet.id} — already failed (terminal)`);
      failed.push(packet.id);
      continue;
    }

    // Check that the dev packet it verifies is completed. Phase 6 —
    // if the dev packet is in terminal `failed` state, the QA packet
    // is also failed (the verification target no longer exists in a
    // verifiable form). This is NOT a skip: the QA packet is
    // terminated, not waiting for a future run. Re-read each
    // dependency from disk because the develop phase may have
    // mutated a dep packet's status during this run.
    const deps = packet.dependencies ?? [];
    const verifies = packet.verifies;
    const allDeps = verifies && !deps.includes(verifies) ? [...deps, verifies] : [...deps];
    const unmetDeps: string[] = [];
    const failedDeps: string[] = [];
    for (const d of allDeps) {
      if (completionIds.has(d)) continue;
      const depPacket = readJson<RawPacket>(join(artifactRoot, 'packets', `${d}.json`));
      if (depPacket !== null && depPacket.status === 'failed') {
        failedDeps.push(d);
        continue;
      }
      unmetDeps.push(d);
    }
    if (failedDeps.length > 0) {
      fmt.log('verify', `${fmt.sym.fail} ${packet.id} — terminated (dev dependency failed: ${failedDeps.join(', ')})`);
      // Stamp the QA packet as failed too so subsequent reads see the
      // cascade. Best-effort write; the failed list below is the
      // controlling artifact.
      try {
        const packetPath = join(artifactRoot, 'packets', `${packet.id}.json`);
        if (existsSync(packetPath)) {
          const data = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
          data['status'] = 'failed';
          data['failure'] = {
            scenario: 'CascadedFromDependency',
            reason: `Dev dependency failed: ${failedDeps.join(', ')}`,
            attempts: 0,
            escalation_path: null,
          };
          writeFileSync(packetPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
        }
      } catch { /* best-effort */ }
      failed.push(packet.id);
      continue;
    }
    if (unmetDeps.length > 0) {
      fmt.log('verify', `${fmt.sym.blocked} ${packet.id} — skipped (dev not complete: ${unmetDeps.join(', ')})`);
      skipped.push(packet.id);
      continue;
    }

    fmt.log('verify', `${fmt.sym.arrow} ${fmt.bold(packet.id)} — "${packet.title}"`);

    if (dryRun) {
      fmt.log('verify', `  [dry-run] Would verify and complete`);
      continue;
    }

    safeCall(() => startPacket({ packetId: packet.id, projectRoot }));

    // Phase 6 — per-packet recovery budget + cap snapshot.
    const perPacketCap = config.pipeline?.cost_caps?.per_packet;
    const packetCostTracker = newPacketCostTracker();
    const recoveryBudget = newPacketRecoveryBudget();
    const recoveryOptions = {
      perRunCap: config.pipeline?.cost_caps?.per_run,
      perDayCap: config.pipeline?.cost_caps?.per_day,
      today: localDateString(),
      ...(opts.gitRunner !== undefined ? { gitRunner: opts.gitRunner } : {}),
    };
    const recoveryRunId = opts.runId ?? 'no-run';

    fmt.log('verify', `  Verifying via ${qaProvider} (${qaTier})...`);
    // Wrap the QA-agent invocation in runWithRecovery. ProviderTransient
    // and AgentNonResponsive failures retry; BuildFailed/LintFailed/
    // TestFailed don't apply at this boundary (the QA agent is not
    // expected to produce those classifications until completePacket
    // runs verification).
    const qaRecovered = await runWithRecovery<InvokeResult>(
      async (attempt: AttemptContext): Promise<OperationResult<InvokeResult>> => {
        // Phase 7 round-2 — primary derived from cascade[0]; see
        // develop_phase.ts for the rationale.
        const target = attempt.cascade ?? qaPrimary;
        const qaMemory = loadMemoryContext({
          persona: 'qa',
          projectRoot,
          config,
          title: packet.title,
          intent: packetIntentText(packet),
          acceptanceCriteria: packet.acceptance_criteria,
          changeClass: packet.change_class,
        });
        const qaPromptStr = buildQaPrompt(packet, config, qaMemory.block);
        const r = await invokeAgent(
          target.provider, qaPromptStr, config, qaTier, target.model,
          {
            message: `qa verification running for packet '${packet.id}'...`,
            channel: 'verify',
          },
        );
        recordInvocationCost(
          r, opts.runId, packet.id, opts.specId ?? null, artifactRoot,
          perPacketCap, packetCostTracker, dryRun,
        );
        if (r.exit_code === 0) return { outcome: 'ok', value: r };
        return {
          outcome: 'fail',
          failure: {
            ...failureFromSubprocess({
              exitCode: r.exit_code,
              stdout: r.stdout,
              stderr: r.stderr,
              kind: 'agent_invocation',
              specId: opts.specId ?? null,
              packetId: packet.id,
              operationLabel: 'verify_phase.qa',
            }),
            cascade: qaCascade,
          },
        };
      },
      {
        runId: recoveryRunId,
        artifactRoot,
        dryRun,
        specId: opts.specId ?? null,
        packetId: packet.id,
        operationLabel: 'verify_phase.qa',
        budget: recoveryBudget,
      },
      recoveryOptions,
    );
    if (packetCostTracker.crossed) {
      fmt.log('verify', `  ${fmt.sym.fail} ${fmt.error(`Per-packet cost cap crossed ($${packetCostTracker.total.toFixed(4)} >= $${perPacketCap})`)}`);
      failed.push(packet.id);
      continue;
    }
    if (qaRecovered.kind === 'escalated') {
      fmt.log('verify', `  ${fmt.sym.fail} ${fmt.error(`Escalated (${qaRecovered.scenario}): ${qaRecovered.reason}`)}`);
      markPacketFailed({
        packetId: packet.id,
        artifactRoot,
        recovery: qaRecovered,
        runId: opts.runId,
        dryRun,
      });
      failed.push(packet.id);
      continue;
    }

    // Closing transition line for the QA-agent invocation — pairs
    // with the in-flight heartbeats from `invokeAgent`. Routed through
    // the 'agent' channel to match the heartbeat surface from the
    // convergence pass. Emitted BEFORE `Running verification...` so
    // the operator-visible order is:
    //   1. qa heartbeat (in-flight)
    //   2. qa transition (closing)
    //   3. verification runs (completePacket)
    fmt.log('agent', `qa verification complete for '${packet.id}'`);

    fmt.log('verify', `  Running verification...`);

    // Phase 6 — wrap the QA completion in runWithRecovery so
    // BuildFailed remediation, LintFailed, TestFailed, StaleBranch,
    // CompletionGateBlocked all classify correctly at this boundary.
    //
    // QA BuildFailed remediation specifics:
    //   The QA persona only verifies; the dev persona writes code.
    //   Re-running completePacket without code remediation would
    //   observe the same failure forever. So when the recovery layer
    //   dispatches retry_with_guardrail_prompt, the closure invokes
    //   the DEV agent against the DEV packet referenced by
    //   `packet.verifies` (NOT the QA packet — that was the bug the
    //   round-3 codex review caught in the previous attempt). The QA
    //   packet context is appended so the dev agent knows which QA
    //   invocation surfaced the failure.
    //
    // Defensive: an orphan QA packet (verifies points at a missing
    // dev packet) returns a structured failure so recovery escalates
    // rather than misdirecting the dev prompt.
    const devPacketForRemediation: RawPacket | null = (() => {
      const verifiesId = packet.verifies;
      if (verifiesId === undefined || verifiesId === null) return null;
      const direct = packets.find((p) => p.id === verifiesId && p.kind === 'dev');
      return direct ?? null;
    })();

    // Phase 7 round-2 fix — remediation prompt preservation across
    // recovery actions. Mirrors develop_phase.ts; see that file for
    // the full rationale. Briefly: when a remediation-step dev-agent
    // failure triggers a cascade_provider hop, the next closure
    // invocation must STILL re-issue the remediation against the new
    // hop with the SAME guardrail prompt — otherwise completePacket
    // re-runs against unchanged code and the QA packet eventually
    // exhausts its BuildFailed budget without the dev-agent ever
    // running on the cascade hop.
    let pendingRemediationPrompt: string | null = null;
    let lastRemediationTarget: typeof devPrimary | null = null;

    const runRemediation = async (
      target: typeof devPrimary,
      guardrail: string,
    ): Promise<OperationResult<true> | null> => {
      if (devPacketForRemediation === null) {
        return {
          outcome: 'fail',
          failure: {
            exit_code: null,
            stdout: '',
            stderr:
              `Cannot dispatch dev-agent remediation: QA packet ${packet.id} ` +
              `references missing dev packet '${String(packet.verifies)}'.`,
            error_message: 'orphan QA packet',
            kind: 'lifecycle',
            spec_id: opts.specId ?? null,
            packet_id: packet.id,
            operation_label: 'verify_phase.complete.remediation',
          },
        };
      }
      const devMemory = loadMemoryContext({
        persona: 'developer',
        projectRoot,
        config,
        title: devPacketForRemediation.title,
        intent: packetIntentText(devPacketForRemediation),
        acceptanceCriteria: devPacketForRemediation.acceptance_criteria,
        changeClass: devPacketForRemediation.change_class,
      });
      const basePrompt = buildDevPrompt(devPacketForRemediation, config, devMemory.block);
      const qaContext =
        `This dev packet is being verified by QA packet ${packet.id} ` +
        `("${packet.title}"); QA reported build failure.`;
      const remediationPrompt =
        `${basePrompt}\n\n---\n${qaContext}\n\n${guardrail}`;
      lastRemediationTarget = target;
      const r = await invokeAgent(
        target.provider, remediationPrompt, config, devTier, target.model,
        {
          message: `build remediation invoked for packet '${packet.id}' (dev packet '${devPacketForRemediation.id}')...`,
          channel: 'verify',
        },
      );
      recordInvocationCost(
        r, opts.runId, packet.id, opts.specId ?? null, artifactRoot,
        perPacketCap, packetCostTracker, dryRun,
      );
      if (r.exit_code !== 0) {
        return {
          outcome: 'fail',
          failure: {
            ...failureFromSubprocess({
              exitCode: r.exit_code,
              stdout: r.stdout,
              stderr: r.stderr,
              kind: 'agent_invocation',
              specId: opts.specId ?? null,
              packetId: packet.id,
              operationLabel: 'verify_phase.complete.remediation',
            }),
            // Attach the dev cascade so a remediation-step
            // ProviderUnavailable failure can fail over.
            cascade: devCascade,
          },
        };
      }
      return null;
    };

    const completeRecovered = await runWithRecovery<true>(
      async (attempt: AttemptContext): Promise<OperationResult<true>> => {
        // Step 1: handle the remediation half of the compound
        // BuildFailed action. See develop_phase.ts for the three-
        // case rationale (retry_with_guardrail_prompt /
        // cascade_provider mid-remediation / retry_same mid-
        // remediation).
        if (attempt.action === 'retry_with_guardrail_prompt'
          && attempt.guardrailPrompt !== undefined) {
          pendingRemediationPrompt = attempt.guardrailPrompt;
          const fail = await runRemediation(devPrimary, pendingRemediationPrompt);
          if (fail !== null) return fail;
        } else if (attempt.action === 'cascade_provider'
          && attempt.cascade !== undefined
          && pendingRemediationPrompt !== null) {
          const fail = await runRemediation(attempt.cascade, pendingRemediationPrompt);
          if (fail !== null) return fail;
        } else if (attempt.action === 'retry_same'
          && pendingRemediationPrompt !== null
          && lastRemediationTarget !== null) {
          const fail = await runRemediation(lastRemediationTarget, pendingRemediationPrompt);
          if (fail !== null) return fail;
        }
        try {
          const r = completePacket({
            packetId: packet.id,
            identity: qaIdentity,
            projectRoot,
            // Phase 6 — opt in to lifecycle stale-branch detection.
            checkStaleBranch: true,
            ...(opts.gitRunner !== undefined ? { gitRunner: opts.gitRunner } : {}),
          });
          // Phase 6: completePacket is atomic — it does NOT write a
          // record on ci_pass=false. So `already_complete` only
          // appears on success (existing successful completion) and
          // never as a false-success short-circuit on a failed
          // verification. Branch on ci_pass alone.
          if (r.ci_pass) {
            pendingRemediationPrompt = null;
            lastRemediationTarget = null;
            return { outcome: 'ok', value: true };
          }
          const failedChecks: Array<'build' | 'lint' | 'tests' | 'ci'> = [];
          if (!r.build_pass) failedChecks.push('build');
          if (!r.lint_pass) failedChecks.push('lint');
          if (!r.tests_pass) failedChecks.push('tests');
          if (failedChecks.length === 0) failedChecks.push('ci');
          return {
            outcome: 'fail',
            failure: failureFromSubprocess({
              exitCode: 1,
              stdout: '',
              stderr: `Verification failed: ${failedChecks.join(', ')}`,
              kind: 'verification',
              failedChecks,
              specId: opts.specId ?? null,
              packetId: packet.id,
              operationLabel: 'verify_phase.complete',
            }),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const kind: 'git' | 'lifecycle' = looksLikeStaleBranchMessage(msg)
            ? 'git'
            : 'lifecycle';
          return {
            outcome: 'fail',
            failure: failureFromThrow({
              error: err,
              kind,
              specId: opts.specId ?? null,
              packetId: packet.id,
              operationLabel: 'verify_phase.complete',
            }),
          };
        }
      },
      {
        runId: recoveryRunId,
        artifactRoot,
        dryRun,
        specId: opts.specId ?? null,
        packetId: packet.id,
        operationLabel: 'verify_phase.complete',
        budget: recoveryBudget,
      },
      recoveryOptions,
    );
    if (completeRecovered.kind === 'escalated') {
      fmt.log('verify', `  ${fmt.sym.fail} ${fmt.error(`Escalated (${completeRecovered.scenario}): ${completeRecovered.reason}`)}`);
      markPacketFailed({
        packetId: packet.id,
        artifactRoot,
        recovery: completeRecovered,
        runId: opts.runId,
        dryRun,
      });
      failed.push(packet.id);
      continue;
    }
    fmt.log('verify', `  ${fmt.sym.ok} ${fmt.success('Completed')}`);
    completionIds.add(packet.id);
    completed.push(packet.id);
  }

  return { completed, failed, skipped };
}
