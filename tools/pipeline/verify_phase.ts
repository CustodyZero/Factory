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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, RawPacket } from '../execute.js';
import type { FactoryConfig, ModelTier } from '../config.js';
import * as fmt from '../output.js';
import { invokeAgent } from './agent_invoke.js';
import { buildQaPrompt } from './prompts.js';
import { refreshCompletionId, safeCall } from './lifecycle_helpers.js';
import { startPacket } from '../lifecycle/start.js';
import { completePacket } from '../lifecycle/complete.js';
import {
  makePhaseStarted,
  makePhaseCompleted,
} from './events.js';
import { appendEvent } from '../events.js';
import type { InvokeResult } from './agent_invoke.js';
import type { CostRecord } from './cost.js';
import { recordCost } from '../cost.js';

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
// Cost recording (Phase 5.7)
//
// Best-effort wrapper around recordCost. No-op when runId is undefined
// (unit tests that drive runVerifyPhase directly may omit it). Mirrors
// the recordInvocationCost helper in develop_phase.ts.
// ---------------------------------------------------------------------------

function recordInvocationCost(
  invokeResult: InvokeResult,
  runId: string | undefined,
  packetId: string | null,
  specId: string | null,
  artifactRoot: string,
): void {
  if (runId === undefined) return;
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
}

// ---------------------------------------------------------------------------
// runVerifyPhase
// ---------------------------------------------------------------------------

/**
 * Run the verify phase for a feature: invoke the QA agent on each
 * QA packet whose dev dependency is complete, then complete the
 * packet. Returns the lists of completed, failed, and skipped
 * packet ids.
 */
export function runVerifyPhase(opts: VerifyPhaseOptions): VerifyPhaseResult {
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

  const result = runVerifyPhaseInner(opts);

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

function runVerifyPhaseInner(opts: VerifyPhaseOptions): VerifyPhaseResult {
  const { feature, config, artifactRoot, projectRoot, dryRun } = opts;

  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const completions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const completionIds = new Set(completions.map((c) => c.packet_id));

  const qaPackets = packets.filter((p) => p.kind === 'qa' && feature.packets.includes(p.id));
  const completed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  fmt.log('verify', `${qaPackets.length} QA packet(s) to process`);

  const qaProvider = config.pipeline?.persona_providers.qa ?? 'claude';
  const qaTier: ModelTier = config.personas.qa.model ?? 'medium';
  const qaIdentity = config.pipeline?.completion_identities.qa ?? 'claude-qa';

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

    // Check that the dev packet it verifies is completed.
    const deps = packet.dependencies ?? [];
    const verifies = packet.verifies;
    const allDeps = verifies && !deps.includes(verifies) ? [...deps, verifies] : [...deps];
    const unmetDeps = allDeps.filter((d) => !completionIds.has(d));
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

    fmt.log('verify', `  Verifying via ${qaProvider} (${qaTier})...`);
    const qaResult = invokeAgent(qaProvider, buildQaPrompt(packet, config), config, qaTier);
    recordInvocationCost(qaResult, opts.runId, packet.id, opts.specId ?? null, artifactRoot);
    if (qaResult.exit_code !== 0) {
      fmt.log('verify', `  ${fmt.sym.fail} QA agent failed`);
      failed.push(packet.id);
      continue;
    }

    fmt.log('verify', `  Running verification...`);
    if (safeCall(() => completePacket({ packetId: packet.id, identity: qaIdentity, projectRoot })).ok) {
      fmt.log('verify', `  ${fmt.sym.ok} ${fmt.success('Completed')}`);
      completionIds.add(packet.id);
      completed.push(packet.id);
    } else {
      fmt.log('verify', `  ${fmt.sym.fail} Completion failed`);
      failed.push(packet.id);
    }
  }

  return { completed, failed, skipped };
}
