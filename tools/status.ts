#!/usr/bin/env tsx
/**
 * Factory — Status & Next Action
 *
 * Reconstructs workflow state from factory artifacts on disk.
 * Designed for session reconstruction: when context is lost (new session,
 * context compaction), this command tells the agent or operator exactly
 * where things stand and what to do next.
 *
 * Usage:
 *   npx tsx tools/status.ts                  # human-readable report
 *   npx tsx tools/status.ts --json           # machine-readable JSON
 *   npx tsx tools/status.ts --feature <id>   # scoped to a feature
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveArtifactRoot } from './config.js';

// ---------------------------------------------------------------------------
// Types (exported for testing)
// ---------------------------------------------------------------------------

export type PacketLifecycleStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'accepted'
  | 'environment_pending';

export interface PacketSummary {
  readonly id: string;
  readonly title: string;
  readonly change_class: string;
  readonly status: PacketLifecycleStatus;
  readonly has_completion: boolean;
  readonly has_acceptance: boolean;
  readonly audit_pending: boolean;
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
  | 'review_plan'
  | 'complete_packet'
  | 'accept_packet'
  | 'resolve_dependency'
  | 'no_active_work'
  | 'all_clear';

export interface NextAction {
  readonly kind: NextActionKind;
  readonly packet_id: string | null;
  readonly message: string;
  readonly command: string | null;
}

export interface FactoryStatus {
  readonly feature_filter: string | null;
  readonly intents_pending_planning: ReadonlyArray<IntentSummary>;
  readonly features_awaiting_approval: ReadonlyArray<{ readonly id: string; readonly intent_id: string | null }>;
  readonly summary: {
    readonly total: number;
    readonly accepted: number;
    readonly completed: number;
    readonly in_progress: number;
    readonly not_started: number;
    readonly audit_pending: number;
  };
  readonly incomplete: ReadonlyArray<PacketSummary>;
  readonly awaiting_acceptance: ReadonlyArray<PacketSummary>;
  readonly audit_pending: ReadonlyArray<PacketSummary>;
  readonly blocked: ReadonlyArray<PacketSummary>;
  readonly next_action: NextAction;
}

// ---------------------------------------------------------------------------
// Artifact reading
// ---------------------------------------------------------------------------

interface RawPacket {
  readonly id: string;
  readonly title: string;
  readonly change_class: string;
  readonly started_at?: string | null;
  readonly status?: string | null;
  readonly dependencies?: ReadonlyArray<string>;
  readonly environment_dependencies?: ReadonlyArray<string>;
}

interface RawCompletion {
  readonly packet_id: string;
  readonly verification: {
    readonly tests_pass: boolean;
    readonly build_pass: boolean;
    readonly lint_pass: boolean;
    readonly ci_pass: boolean;
  };
}

interface RawAcceptance {
  readonly packet_id: string;
}

function readJsonDir<T>(artifactRoot: string, subdir: string): T[] {
  const dir = join(artifactRoot, subdir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as T;
      } catch {
        return null;
      }
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
  readonly acceptances: ReadonlyArray<RawAcceptance>;
  readonly featureFilter?: string | undefined;
  readonly features?: ReadonlyArray<RawFeature> | undefined;
  readonly intents?: ReadonlyArray<RawIntent> | undefined;
}

function verificationPasses(v: RawCompletion['verification']): boolean {
  return v.tests_pass && v.build_pass && v.lint_pass && v.ci_pass;
}

function derivePacketLifecycle(
  packet: RawPacket,
  completionMap: ReadonlyMap<string, RawCompletion>,
  acceptanceIds: ReadonlySet<string>,
): PacketLifecycleStatus {
  const completion = completionMap.get(packet.id);
  const hasAcceptance = acceptanceIds.has(packet.id);

  if (completion === undefined) {
    return packet.started_at != null ? 'in_progress' : 'not_started';
  }

  if (hasAcceptance) return 'accepted';

  const cc = packet.change_class;
  if ((cc === 'trivial' || cc === 'local' || cc === 'cross_cutting') && verificationPasses(completion.verification)) {
    return 'accepted';
  }

  return 'completed';
}

export function deriveFactoryStatus(input: StatusInput): FactoryStatus {
  const completionMap = new Map<string, RawCompletion>();
  for (const c of input.completions) {
    completionMap.set(c.packet_id, c);
  }

  const acceptanceIds = new Set<string>();
  for (const a of input.acceptances) {
    acceptanceIds.add(a.packet_id);
  }

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

  const allPackets: PacketSummary[] = [];
  const acceptedIds = new Set<string>();

  for (const packet of filteredPackets) {
    const status = derivePacketLifecycle(packet, completionMap, acceptanceIds);
    const hasCompletion = completionMap.has(packet.id);
    const hasAcceptance = acceptanceIds.has(packet.id);

    const auditPending = status === 'accepted' &&
      packet.change_class === 'cross_cutting' &&
      !hasAcceptance;

    const deps = packet.dependencies ?? [];
    const unmetDeps: string[] = [];
    for (const dep of deps) {
      if (!acceptedIds.has(dep)) {
        const depPacket = input.packets.find((p) => p.id === dep);
        if (depPacket !== undefined) {
          const depStatus = derivePacketLifecycle(depPacket, completionMap, acceptanceIds);
          if (depStatus !== 'accepted') {
            unmetDeps.push(dep);
          }
        }
      }
    }

    if (status === 'accepted') {
      acceptedIds.add(packet.id);
    }

    allPackets.push({
      id: packet.id,
      title: packet.title,
      change_class: packet.change_class,
      status,
      has_completion: hasCompletion,
      has_acceptance: hasAcceptance,
      audit_pending: auditPending,
      dependencies: deps,
      unmet_dependencies: unmetDeps,
      started_at: packet.started_at ?? null,
    });
  }

  const incomplete = allPackets.filter((p) => p.status === 'in_progress');
  const awaitingAcceptance = allPackets.filter((p) =>
    p.status === 'completed' && p.change_class === 'architectural' && !p.has_acceptance,
  );
  const auditPending = allPackets.filter((p) => p.audit_pending);
  const blocked = allPackets.filter((p) => p.unmet_dependencies.length > 0 && p.status !== 'accepted');

  const summary = {
    total: allPackets.length,
    accepted: allPackets.filter((p) => p.status === 'accepted').length,
    completed: allPackets.filter((p) => p.status === 'completed').length,
    in_progress: incomplete.length,
    not_started: allPackets.filter((p) => p.status === 'not_started').length,
    audit_pending: auditPending.length,
  };

  const intentsPendingPlanning = (input.intents ?? [])
    .filter((intent) => intent.status === 'proposed')
    .map((intent) => ({
      id: intent.id,
      title: intent.title,
      status: intent.status,
      feature_id: typeof intent.feature_id === 'string' ? intent.feature_id : null,
    }));

  const featuresAwaitingApproval = (input.features ?? [])
    .filter((feature) => feature.status === 'planned')
    .map((feature) => ({
      id: feature.id,
      intent_id: typeof feature.intent_id === 'string' ? feature.intent_id : null,
    }));

  const nextAction = deriveNextAction(incomplete, awaitingAcceptance, blocked, featuresAwaitingApproval, intentsPendingPlanning);

  return {
    feature_filter: featureFilter,
    intents_pending_planning: intentsPendingPlanning,
    features_awaiting_approval: featuresAwaitingApproval,
    summary,
    incomplete,
    awaiting_acceptance: awaitingAcceptance,
    audit_pending: auditPending,
    blocked,
    next_action: nextAction,
  };
}

function deriveNextAction(
  incomplete: ReadonlyArray<PacketSummary>,
  awaitingAcceptance: ReadonlyArray<PacketSummary>,
  blocked: ReadonlyArray<PacketSummary>,
  featuresAwaitingApproval: ReadonlyArray<{ readonly id: string; readonly intent_id: string | null }>,
  intentsPendingPlanning: ReadonlyArray<IntentSummary>,
): NextAction {
  if (incomplete.length > 0) {
    const sorted = [...incomplete].sort((a, b) =>
      (a.started_at ?? '').localeCompare(b.started_at ?? ''),
    );
    const first = sorted[0]!;
    return {
      kind: 'complete_packet',
      packet_id: first.id,
      message: `Packet '${first.id}' is in-progress but has no completion record. Create the completion before proceeding.`,
      command: `npx tsx tools/complete.ts ${first.id}`,
    };
  }

  if (blocked.length > 0) {
    const first = blocked[0]!;
    const dep = first.unmet_dependencies[0]!;
    return {
      kind: 'resolve_dependency',
      packet_id: first.id,
      message: `Packet '${first.id}' is blocked by unmet dependency '${dep}'. Resolve the dependency first.`,
      command: null,
    };
  }

  if (awaitingAcceptance.length > 0) {
    const first = awaitingAcceptance[0]!;
    return {
      kind: 'accept_packet',
      packet_id: first.id,
      message: `Packet '${first.id}' (${first.change_class}) is completed and requires human acceptance.`,
      command: null,
    };
  }

  if (featuresAwaitingApproval.length > 0) {
    const first = featuresAwaitingApproval[0]!;
    return {
      kind: 'review_plan',
      packet_id: null,
      message: `Feature '${first.id}' is planned and awaiting human approval before execution.`,
      command: null,
    };
  }

  if (intentsPendingPlanning.length > 0) {
    const first = intentsPendingPlanning[0]!;
    return {
      kind: 'plan_intent',
      packet_id: null,
      message: `Intent '${first.id}' is proposed and ready for planner decomposition.`,
      command: `npx tsx tools/plan.ts ${first.id}`,
    };
  }

  return {
    kind: 'all_clear',
    packet_id: null,
    message: 'All packets are accepted. No active work. Ready for next packet.',
    command: null,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStatus(status: FactoryStatus, projectName: string): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('\u2550'.repeat(59));
  if (status.feature_filter !== null) {
    lines.push(`  FACTORY STATUS [${projectName}] \u2014 Feature: ${status.feature_filter}`);
  } else {
    lines.push(`  FACTORY STATUS [${projectName}]`);
  }
  lines.push('\u2550'.repeat(59));
  lines.push('');

  lines.push('  Summary:');
  lines.push(`    Total packets:      ${String(status.summary.total)}`);
  lines.push(`    Accepted:           ${String(status.summary.accepted)}`);
  lines.push(`    Completed:          ${String(status.summary.completed)}`);
  lines.push(`    In-progress:        ${String(status.summary.in_progress)}`);
  lines.push(`    Not started:        ${String(status.summary.not_started)}`);
  lines.push(`    Audit pending:      ${String(status.summary.audit_pending)}`);
  lines.push('');

  if (status.incomplete.length > 0) {
    lines.push('  \u26a0 Incomplete packets (started, no completion):');
    for (const p of status.incomplete) {
      lines.push(`    - ${p.id} (${p.change_class})`);
      lines.push(`      "${p.title}"`);
    }
    lines.push('');
  }

  if (status.awaiting_acceptance.length > 0) {
    lines.push('  \u23f3 Awaiting human acceptance:');
    for (const p of status.awaiting_acceptance) {
      lines.push(`    - ${p.id} (${p.change_class})`);
    }
    lines.push('');
  }

  if (status.features_awaiting_approval.length > 0) {
    lines.push('  \u23f3 Planned features awaiting human approval:');
    for (const feature of status.features_awaiting_approval) {
      lines.push(`    - ${feature.id}${feature.intent_id !== null ? ` (intent: ${feature.intent_id})` : ''}`);
    }
    lines.push('');
  }

  if (status.intents_pending_planning.length > 0) {
    lines.push('  \u270d Intent specs awaiting planner decomposition:');
    for (const intent of status.intents_pending_planning) {
      lines.push(`    - ${intent.id}`);
      lines.push(`      "${intent.title}"`);
    }
    lines.push('');
  }

  if (status.audit_pending.length > 0) {
    lines.push('  \ud83d\udccb Audit pending (accepted, review recommended):');
    for (const p of status.audit_pending) {
      lines.push(`    - ${p.id} (${p.change_class})`);
    }
    lines.push('');
  }

  if (status.blocked.length > 0) {
    lines.push('  \ud83d\udeab Blocked by unmet dependencies:');
    for (const p of status.blocked) {
      lines.push(`    - ${p.id} \u2192 needs: ${p.unmet_dependencies.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('\u2500'.repeat(59));
  lines.push('  NEXT ACTION:');
  lines.push(`    ${status.next_action.message}`);
  if (status.next_action.command !== null) {
    lines.push(`    Command: ${status.next_action.command}`);
  }
  lines.push('\u2500'.repeat(59));
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
  const acceptances = readJsonDir<RawAcceptance>(artifactRoot, 'acceptances');
  const features = readJsonDir<RawFeature>(artifactRoot, 'features');
  const intents = readJsonDir<RawIntent>(artifactRoot, 'intents');

  const featureIdx = process.argv.indexOf('--feature');
  const featureFilter = featureIdx !== -1 ? process.argv[featureIdx + 1] : undefined;

  const status = deriveFactoryStatus({ packets, completions, acceptances, featureFilter, features, intents });

  // Read supervisor state if present
  const supervisorStatePath = join(artifactRoot, 'supervisor', 'state.json');
  let supervisorSummary: { enabled: boolean; tracked_features: number; pending_escalations: number; phases: Record<string, number> } | null = null;
  if (existsSync(supervisorStatePath)) {
    try {
      const rawState = JSON.parse(readFileSync(supervisorStatePath, 'utf-8')) as Record<string, unknown>;
      const feats = rawState['features'] as Record<string, Record<string, unknown>> | undefined;
      const escalations = rawState['pending_escalations'] as Array<Record<string, unknown>> | undefined;
      const phases: Record<string, number> = {};
      if (feats !== undefined) {
        for (const ft of Object.values(feats)) {
          const phase = typeof ft['phase'] === 'string' ? ft['phase'] : 'unknown';
          phases[phase] = (phases[phase] ?? 0) + 1;
        }
      }
      const unresolvedEscalations = (escalations ?? []).filter((e) => e['resolved'] !== true).length;
      supervisorSummary = {
        enabled: true,
        tracked_features: feats !== undefined ? Object.keys(feats).length : 0,
        pending_escalations: unresolvedEscalations,
        phases,
      };
    } catch {
      // Ignore parse errors — validate.ts will catch them
    }
  }

  if (process.argv.includes('--json')) {
    const output = supervisorSummary !== null ? { ...status, supervisor: supervisorSummary } : status;
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    let rendered = renderStatus(status, config.project_name);
    if (supervisorSummary !== null) {
      const lines: string[] = [];
      lines.push('');
      lines.push('  Supervisor:');
      lines.push(`    Tracked features: ${String(supervisorSummary.tracked_features)}`);
      lines.push(`    Pending escalations: ${String(supervisorSummary.pending_escalations)}`);
      if (Object.keys(supervisorSummary.phases).length > 0) {
        lines.push(`    Phases: ${Object.entries(supervisorSummary.phases).map(([p, c]) => `${p}(${String(c)})`).join(' ')}`);
      }
      rendered += lines.join('\n') + '\n';
    }
    process.stdout.write(rendered);
  }
}

const isDirectExecution = process.argv[1]?.endsWith('status.ts') ||
  process.argv[1]?.endsWith('status.js');
if (isDirectExecution) {
  main();
}
