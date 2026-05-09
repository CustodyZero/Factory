#!/usr/bin/env tsx
/**
 * Factory — Status & Next Action
 *
 * Reconstructs workflow state from factory artifacts on disk.
 * Tells the agent or operator where things stand and what to do next.
 *
 * Usage:
 *   npx tsx tools/status.ts                  # human-readable report
 *   npx tsx tools/status.ts --json           # machine-readable JSON
 *   npx tsx tools/status.ts --feature <id>   # scoped to a feature
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildToolCommand, loadConfig, resolveArtifactRoot } from './config.js';
import * as fmt from './output.js';

// ---------------------------------------------------------------------------
// Types (exported for testing)
// ---------------------------------------------------------------------------

export type PacketLifecycleStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'failed';

export interface PacketSummary {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly status: PacketLifecycleStatus;
  readonly has_completion: boolean;
  readonly dependencies: ReadonlyArray<string>;
  readonly unmet_dependencies: ReadonlyArray<string>;
  readonly started_at: string | null;
}

export interface IntentSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly feature_id: string | null;
}

export type NextActionKind =
  | 'plan_intent'
  | 'run_feature'
  | 'no_active_work'
  | 'all_clear';

export interface NextAction {
  readonly kind: NextActionKind;
  readonly target_id: string | null;
  readonly message: string;
  readonly command: string | null;
}

export interface FactoryStatus {
  readonly feature_filter: string | null;
  readonly intents_pending_planning: ReadonlyArray<IntentSummary>;
  readonly features_in_progress: ReadonlyArray<{ readonly id: string; readonly intent_id: string | null; readonly status: string }>;
  readonly summary: {
    readonly total: number;
    readonly completed: number;
    readonly in_progress: number;
    readonly not_started: number;
    /**
     * Phase 6 — packets in terminal `status: "failed"` state.
     * Mutually exclusive with completed/in_progress/not_started.
     * Counted separately so the operator sees the failure cohort.
     */
    readonly failed: number;
  };
  readonly incomplete: ReadonlyArray<PacketSummary>;
  /**
   * Phase 6 — packets in terminal failed state. Surfaced separately
   * from `incomplete` (in-progress) and `blocked` so downstream
   * tooling can distinguish "not yet attempted" from "attempted and
   * abandoned by the recovery layer."
   */
  readonly failed: ReadonlyArray<PacketSummary>;
  readonly blocked: ReadonlyArray<PacketSummary>;
  readonly next_action: NextAction;
}

// ---------------------------------------------------------------------------
// Artifact reading
// ---------------------------------------------------------------------------

interface RawPacket {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly change_class?: string;
  readonly started_at?: string | null;
  readonly status?: string | null;
  readonly dependencies?: ReadonlyArray<string>;
}

interface RawCompletion {
  readonly packet_id: string;
}

function readJsonDir<T>(artifactRoot: string, subdir: string): T[] {
  const dir = join(artifactRoot, subdir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as T; }
      catch { return null; }
    })
    .filter((x): x is T => x !== null);
}

// ---------------------------------------------------------------------------
// Derivation (pure, testable)
// ---------------------------------------------------------------------------

export interface RawFeature {
  readonly id: string;
  readonly intent: string;
  readonly status: string;
  readonly packets: ReadonlyArray<string>;
  readonly intent_id?: string | null;
}

export interface RawIntent {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly feature_id?: string | null;
}

export interface StatusInput {
  readonly packets: ReadonlyArray<RawPacket>;
  readonly completions: ReadonlyArray<RawCompletion>;
  readonly featureFilter?: string | undefined;
  readonly features?: ReadonlyArray<RawFeature> | undefined;
  readonly intents?: ReadonlyArray<RawIntent> | undefined;
  readonly commands?: {
    readonly run?: (featureId: string) => string;
    readonly plan?: (intentId: string) => string;
  } | undefined;
}

function derivePacketLifecycle(
  packet: RawPacket,
  completionIds: ReadonlySet<string>,
): PacketLifecycleStatus {
  if (completionIds.has(packet.id)) return 'completed';
  // Phase 6 — terminal-failed status takes precedence over the
  // started_at heuristic. A packet whose recovery layer escalated
  // has started_at set but is NOT in_progress — it is failed.
  if (packet.status === 'failed') return 'failed';
  return packet.started_at != null ? 'in_progress' : 'not_started';
}

export function deriveFactoryStatus(input: StatusInput): FactoryStatus {
  const completionIds = new Set(input.completions.map((c) => c.packet_id));

  let filteredPackets = input.packets;
  let featureFilter: string | null = null;
  if (input.featureFilter !== undefined) {
    featureFilter = input.featureFilter;
    const feature = (input.features ?? []).find((f) => f.id === input.featureFilter);
    if (feature !== undefined) {
      const featurePacketIds = new Set(feature.packets);
      filteredPackets = input.packets.filter((p) => featurePacketIds.has(p.id));
    }
  }

  const completedIds = new Set<string>();
  const allPackets: PacketSummary[] = [];

  for (const packet of filteredPackets) {
    const status = derivePacketLifecycle(packet, completionIds);
    const deps = packet.dependencies ?? [];
    const unmetDeps = deps.filter((dep) => !completionIds.has(dep));

    if (status === 'completed') completedIds.add(packet.id);

    allPackets.push({
      id: packet.id,
      title: packet.title,
      kind: packet.kind ?? 'dev',
      status,
      has_completion: completionIds.has(packet.id),
      dependencies: deps,
      unmet_dependencies: unmetDeps,
      started_at: packet.started_at ?? null,
    });
  }

  const incomplete = allPackets.filter((p) => p.status === 'in_progress');
  const failed = allPackets.filter((p) => p.status === 'failed');
  // Failed packets are NOT 'blocked' — they are terminal. Excluding
  // them here keeps the blocked bucket meaningful (truly waiting).
  const blocked = allPackets.filter(
    (p) => p.unmet_dependencies.length > 0
      && p.status !== 'completed'
      && p.status !== 'failed',
  );

  const summary = {
    total: allPackets.length,
    completed: allPackets.filter((p) => p.status === 'completed').length,
    in_progress: incomplete.length,
    not_started: allPackets.filter((p) => p.status === 'not_started').length,
    failed: failed.length,
  };

  const intentsPendingPlanning = (input.intents ?? [])
    .filter((intent) =>
      (intent.status === 'proposed' || intent.status === 'approved') &&
      (typeof intent.feature_id !== 'string' || intent.feature_id.length === 0)
    )
    .map((intent) => ({
      id: intent.id, title: intent.title, status: intent.status,
      feature_id: typeof intent.feature_id === 'string' ? intent.feature_id : null,
    }));

  const featuresInProgress = (input.features ?? [])
    .filter((f) => f.status === 'planned' || f.status === 'executing')
    .map((f) => ({
      id: f.id,
      intent_id: typeof f.intent_id === 'string' ? f.intent_id : null,
      status: f.status,
    }));

  const nextAction = deriveNextAction(incomplete, blocked, featuresInProgress, intentsPendingPlanning, input.commands);

  return {
    feature_filter: featureFilter,
    intents_pending_planning: intentsPendingPlanning,
    features_in_progress: featuresInProgress,
    summary,
    incomplete,
    failed,
    blocked,
    next_action: nextAction,
  };
}

function deriveNextAction(
  incomplete: ReadonlyArray<PacketSummary>,
  blocked: ReadonlyArray<PacketSummary>,
  featuresInProgress: ReadonlyArray<{ readonly id: string }>,
  intentsPendingPlanning: ReadonlyArray<IntentSummary>,
  commands?: { readonly run?: (featureId: string) => string; readonly plan?: (intentId: string) => string },
): NextAction {
  if (featuresInProgress.length > 0) {
    const feature = featuresInProgress[0]!;
    return {
      kind: 'run_feature',
      target_id: feature.id,
      message: `Feature '${feature.id}' is in progress. Run the pipeline to continue.`,
      command: commands?.run?.(feature.id) ?? `npx tsx tools/run.ts ${feature.id}`,
    };
  }

  if (incomplete.length > 0) {
    const first = incomplete[0]!;
    return {
      kind: 'run_feature',
      target_id: first.id,
      message: `Packet '${first.id}' is in-progress but has no completion record.`,
      command: null,
    };
  }

  if (intentsPendingPlanning.length > 0) {
    const first = intentsPendingPlanning[0]!;
    return {
      kind: 'plan_intent',
      target_id: first.id,
      message: `Intent '${first.id}' is ready for pipeline execution.`,
      command: commands?.plan?.(first.id) ?? `npx tsx tools/run.ts ${first.id}`,
    };
  }

  if (blocked.length > 0) {
    return {
      kind: 'no_active_work',
      target_id: null,
      message: `${String(blocked.length)} packet(s) blocked by unmet dependencies.`,
      command: null,
    };
  }

  return {
    kind: 'all_clear',
    target_id: null,
    message: 'All packets complete. No active work.',
    command: null,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStatus(status: FactoryStatus, projectName: string): string {
  const lines: string[] = [];
  const detail = status.feature_filter !== null
    ? `[${projectName}] — Feature: ${status.feature_filter}`
    : `[${projectName}]`;

  lines.push(fmt.header('STATUS', detail));
  lines.push('');
  lines.push(`  ${fmt.bold('Summary:')}`);
  lines.push(`    Total packets:  ${String(status.summary.total)}`);
  lines.push(`    Completed:      ${fmt.success(String(status.summary.completed))}`);
  lines.push(`    In-progress:    ${fmt.info(String(status.summary.in_progress))}`);
  lines.push(`    Not started:    ${fmt.muted(String(status.summary.not_started))}`);
  if (status.summary.failed > 0) {
    lines.push(`    Failed:         ${fmt.error(String(status.summary.failed))}`);
  }
  lines.push('');

  if (status.incomplete.length > 0) {
    lines.push(`  ${fmt.sym.warn} ${fmt.warn('In progress:')}`);
    for (const p of status.incomplete) {
      lines.push(`    - ${fmt.bold(p.id)} (${p.kind}) "${p.title}"`);
    }
    lines.push('');
  }

  if (status.failed.length > 0) {
    lines.push(`  ${fmt.sym.fail} ${fmt.error('Failed:')}`);
    for (const p of status.failed) {
      lines.push(`    - ${fmt.bold(p.id)} (${p.kind}) "${p.title}"`);
    }
    lines.push('');
  }

  if (status.intents_pending_planning.length > 0) {
    lines.push(`  ${fmt.sym.plan} ${fmt.info('Intents ready for pipeline:')}`);
    for (const intent of status.intents_pending_planning) {
      lines.push(`    - ${fmt.bold(intent.id)}`);
      lines.push(`      "${intent.title}" ${fmt.muted(`(${intent.status})`)}`);
    }
    lines.push('');
  }

  if (status.blocked.length > 0) {
    lines.push(`  ${fmt.sym.blocked} ${fmt.error('Blocked:')}`);
    for (const p of status.blocked) {
      lines.push(`    - ${fmt.bold(p.id)} ${fmt.sym.arrow} needs: ${p.unmet_dependencies.join(', ')}`);
    }
    lines.push('');
  }

  lines.push(fmt.divider());
  lines.push(`  ${fmt.bold('NEXT ACTION:')}`);
  lines.push(`    ${status.next_action.message}`);
  if (status.next_action.command !== null) {
    lines.push(`    ${fmt.info('Command:')} ${status.next_action.command}`);
  }
  lines.push(fmt.divider());
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const config = loadConfig();
  const artifactRoot = resolveArtifactRoot(undefined, config);

  const packets = readJsonDir<RawPacket>(artifactRoot, 'packets');
  const completions = readJsonDir<RawCompletion>(artifactRoot, 'completions');
  const features = readJsonDir<RawFeature>(artifactRoot, 'features');
  const intents = readJsonDir<RawIntent>(artifactRoot, 'intents');

  const featureIdx = process.argv.indexOf('--feature');
  const featureFilter = featureIdx !== -1 ? process.argv[featureIdx + 1] : undefined;

  const status = deriveFactoryStatus({
    packets, completions, featureFilter, features, intents,
    commands: {
      run: (featureId) => buildToolCommand('run.ts', [featureId], undefined, config),
      plan: (intentId) => buildToolCommand('run.ts', [intentId], undefined, config),
    },
  });

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  } else {
    process.stdout.write(renderStatus(status, config.project_name));
  }
}

const isDirectExecution = process.argv[1]?.endsWith('status.ts') || process.argv[1]?.endsWith('status.js');
if (isDirectExecution) {
  main();
}
