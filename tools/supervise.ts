#!/usr/bin/env tsx
/**
 * Factory — Supervisor Actor (Stateless Tick Function)
 *
 * Reads supervisor state + factory artifacts, returns the single
 * highest-priority action. The caller performs the action, then
 * calls this tool again. Repeat until idle.
 *
 * This tool does NOT spawn agents, complete packets, or accept work.
 * It only decides what should happen next.
 *
 * Usage:
 *   npx tsx tools/supervise.ts                    # Human-readable next action
 *   npx tsx tools/supervise.ts --json             # Machine-readable JSON
 *   npx tsx tools/supervise.ts --feature <id>     # Scope to one feature
 *   npx tsx tools/supervise.ts --init             # Initialize supervisor state
 *
 * Supervisor invariants:
 *   SI-1: State must be consistent with factory artifacts
 *   SI-2: Never performs human-authority actions
 *   SI-3: Actions are idempotent (same input → same output)
 *   SI-4: Audit log is append-only
 *   SI-5: Reuses resolveExecuteAction — does not bypass factory contracts
 *   SI-6: Pending escalations block feature progression
 *   SI-7: One action per tick
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildToolCommand, loadConfig, findProjectRoot, resolveArtifactRoot } from './config.js';
import type { PersonasConfig } from './config.js';
import { resolveExecuteAction } from './execute.js';
import type { Feature, RawPacket, ExecuteAction, PacketAssignment, DispatchTask } from './execute.js';
import * as fmt from './output.js';

// ---------------------------------------------------------------------------
// Types (exported for testing)
// ---------------------------------------------------------------------------

export type SupervisorActionKind =
  | 'execute_feature'
  | 'escalate_acceptance'
  | 'escalate_blocked'
  | 'escalate_failure'
  | 'update_state'
  | 'idle';

export type SupervisorPhase =
  | 'discovered'
  | 'executing'
  | 'blocked'
  | 'awaiting_human'
  | 'complete';

export interface FeatureTracking {
  readonly feature_id: string;
  readonly phase: SupervisorPhase;
  readonly first_seen_at: string;
  readonly last_tick_at: string;
  readonly packets_spawned: ReadonlyArray<string>;
  readonly active_dispatches: ReadonlyArray<DispatchRecord>;
  readonly packets_completed: ReadonlyArray<string>;
  readonly packets_accepted: ReadonlyArray<string>;
  readonly blocked_reason: string | null;
  readonly tick_count: number;
}

export interface DispatchRecord {
  readonly dispatch_id: string;
  readonly feature_id: string;
  readonly packet_id: string;
  readonly persona: 'developer' | 'code_reviewer' | 'qa';
  readonly task?: DispatchTask;
  readonly model: string;
  readonly instructions: ReadonlyArray<string>;
  readonly start_command: string;
  readonly dispatched_at: string;
}

export interface Escalation {
  readonly id: string;
  readonly kind: 'acceptance' | 'blocked' | 'failure';
  readonly feature_id: string;
  readonly packet_ids: ReadonlyArray<string>;
  readonly created_at: string;
  readonly message: string;
  readonly resolved: boolean;
  readonly resolved_at: string | null;
}

export interface AuditEntry {
  readonly timestamp: string;
  readonly action_kind: string;
  readonly feature_id: string;
  readonly packet_id: string | null;
  readonly message: string;
  readonly identity?: { readonly kind: string; readonly id: string };
}

export interface SupervisorState {
  readonly version: number;
  readonly updated_at: string;
  readonly updated_by: { readonly kind: string; readonly id: string };
  readonly features: Readonly<Record<string, FeatureTracking>>;
  readonly pending_escalations: ReadonlyArray<Escalation>;
  readonly audit_log: ReadonlyArray<AuditEntry>;
}

export interface SupervisorAction {
  readonly kind: SupervisorActionKind;
  readonly feature_id: string | null;
  readonly feature_ids: ReadonlyArray<string>;
  readonly ready_packets: ReadonlyArray<PacketAssignment>;
  readonly dispatches: ReadonlyArray<DispatchRecord>;
  readonly escalation: Escalation | null;
  readonly state_patch: Partial<SupervisorStateMutable> | null;
  readonly message: string;
}

/** Mutable version used for state patches. */
export interface SupervisorStateMutable {
  updated_at: string;
  updated_by: { kind: string; id: string };
  features: Record<string, FeatureTracking>;
  pending_escalations: Escalation[];
  audit_log: AuditEntry[];
}

// ---------------------------------------------------------------------------
// Input (gathered by CLI, passed to pure function)
// ---------------------------------------------------------------------------

export interface SuperviseInput {
  readonly supervisorState: SupervisorState;
  readonly features: ReadonlyArray<Feature>;
  readonly packets: ReadonlyArray<RawPacket>;
  readonly intents?: ReadonlyArray<{ readonly id: string; readonly status: 'proposed' | 'approved' | 'planned' | 'superseded' | 'delivered' }> | undefined;
  readonly completionIds: ReadonlySet<string>;
  readonly acceptanceIds: ReadonlySet<string>;
  readonly personas: PersonasConfig;
  readonly now: Date;
  readonly featureFilter?: string;
  readonly commands?: {
    readonly start?: (packetId: string) => string;
    readonly accept?: (packetId: string) => string;
  } | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAction(
  kind: SupervisorActionKind,
  feature_id: string | null,
  message: string,
  overrides?: Partial<SupervisorAction>,
): SupervisorAction {
  return {
    kind,
    feature_id,
    feature_ids: feature_id === null ? [] : [feature_id],
    ready_packets: [],
    dispatches: [],
    escalation: null,
    state_patch: null,
    message,
    ...overrides,
  };
}

function escalationId(kind: string, featureId: string, now: Date): string {
  return `${kind}-${featureId}-${now.toISOString().replace(/[:.]/g, '-')}`;
}

function dispatchId(featureId: string, packetId: string, now: Date): string {
  return `dispatch-${featureId}-${packetId}-${now.toISOString().replace(/[:.]/g, '-')}`;
}

function pruneActiveDispatches(
  activeDispatches: ReadonlyArray<DispatchRecord>,
  completionIds: ReadonlySet<string>,
  acceptanceIds: ReadonlySet<string>,
): DispatchRecord[] {
  return activeDispatches.filter((dispatch) =>
    !completionIds.has(dispatch.packet_id) &&
    !acceptanceIds.has(dispatch.packet_id),
  );
}

// ---------------------------------------------------------------------------
// Pure function core (SI-3: deterministic, SI-5: reuses resolveExecuteAction)
// ---------------------------------------------------------------------------

export function resolveSupervisorAction(input: SuperviseInput): SupervisorAction {
  const { supervisorState, features, now } = input;
  const nowIso = now.toISOString();

  // Filter to approved/executing features only
  const intentStatusById = new Map((input.intents ?? []).map((intent) => [intent.id, intent.status]));
  const activeFeatures = features.filter((f) =>
    f.status === 'approved' ||
    f.status === 'executing' ||
    f.status === 'completed' ||
    f.status === 'delivered' ||
    (f.status === 'planned' && typeof f.intent_id === 'string' && intentStatusById.get(f.intent_id) === 'approved'),
  );

  // If scoped to one feature, filter further
  const targetFeatures = input.featureFilter !== undefined
    ? activeFeatures.filter((f) => f.id === input.featureFilter)
    : activeFeatures;

  if (targetFeatures.length === 0) {
    return makeAction('idle', null, 'No active features to supervise.');
  }

  // ---------------------------------------------------------------------------
  // Priority 1: Stale state detection (SI-1)
  // If supervisor thinks a feature is executing but factory says all_complete,
  // or supervisor has no record of an approved feature, we need to update state.
  // ---------------------------------------------------------------------------

  for (const feature of targetFeatures) {
    const tracking = supervisorState.features[feature.id];

    // New feature not yet tracked
    if (tracking === undefined) {
      const newTracking: FeatureTracking = {
        feature_id: feature.id,
        phase: 'discovered',
        first_seen_at: nowIso,
        last_tick_at: nowIso,
        packets_spawned: [],
        active_dispatches: [],
        packets_completed: [],
        packets_accepted: [],
        blocked_reason: null,
        tick_count: 0,
      };
      return makeAction('update_state', feature.id, `New feature '${feature.id}' discovered. Adding to supervisor state.`, {
        state_patch: {
          updated_at: nowIso,
          features: { ...supervisorState.features, [feature.id]: newTracking },
          audit_log: [
            ...supervisorState.audit_log,
            { timestamp: nowIso, action_kind: 'update_state', feature_id: feature.id, packet_id: null, message: `Discovered feature '${feature.id}'.` },
          ],
        },
      });
    }

    // Detect stale: supervisor says executing but completions have changed
    if (tracking.phase === 'executing' || tracking.phase === 'discovered') {
      const currentCompleted = feature.packets.filter((pid) => input.completionIds.has(pid));
      const currentAccepted = feature.packets.filter((pid) => input.acceptanceIds.has(pid));
      const trackedCompleted = new Set(tracking.packets_completed);
      const trackedAccepted = new Set(tracking.packets_accepted);

      const newCompletions = currentCompleted.filter((id) => !trackedCompleted.has(id));
      const newAcceptances = currentAccepted.filter((id) => !trackedAccepted.has(id));

      if (newCompletions.length > 0 || newAcceptances.length > 0) {
        const updatedTracking: FeatureTracking = {
          ...tracking,
          last_tick_at: nowIso,
          active_dispatches: pruneActiveDispatches(tracking.active_dispatches, input.completionIds, input.acceptanceIds),
          packets_completed: currentCompleted,
          packets_accepted: currentAccepted,
          tick_count: tracking.tick_count + 1,
        };
        return makeAction('update_state', feature.id, `State refresh for '${feature.id}': ${String(newCompletions.length)} new completion(s), ${String(newAcceptances.length)} new acceptance(s).`, {
          state_patch: {
            updated_at: nowIso,
            features: { ...supervisorState.features, [feature.id]: updatedTracking },
            audit_log: [
              ...supervisorState.audit_log,
              { timestamp: nowIso, action_kind: 'update_state', feature_id: feature.id, packet_id: null, message: `Synced: +${String(newCompletions.length)} completions, +${String(newAcceptances.length)} acceptances.` },
            ],
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Priority 2: Pending escalations block progression (SI-6)
  // ---------------------------------------------------------------------------

  const unresolvedEscalations = supervisorState.pending_escalations.filter((e) => !e.resolved);
  for (const esc of unresolvedEscalations) {
    // Only block if we're looking at this feature (or unfiltered)
    if (input.featureFilter !== undefined && esc.feature_id !== input.featureFilter) continue;
    const tracking = supervisorState.features[esc.feature_id];
    if (tracking === undefined) continue;

    // Check if the escalation has been resolved in factory artifacts
    if (esc.kind === 'acceptance') {
      const allAccepted = esc.packet_ids.every((pid) => input.acceptanceIds.has(pid));
      if (allAccepted) {
        // Resolve the escalation
        const resolvedEscalations = supervisorState.pending_escalations.map((e2) =>
          e2.id === esc.id ? { ...e2, resolved: true, resolved_at: nowIso } : e2,
        );
        const updatedTracking: FeatureTracking = {
          ...tracking,
          phase: 'executing',
          last_tick_at: nowIso,
          active_dispatches: pruneActiveDispatches(tracking.active_dispatches, input.completionIds, input.acceptanceIds),
          packets_accepted: [...new Set([...tracking.packets_accepted, ...esc.packet_ids])],
          tick_count: tracking.tick_count + 1,
        };
        return makeAction('update_state', esc.feature_id, `Escalation '${esc.id}' resolved — acceptances received. Resuming execution.`, {
          state_patch: {
            updated_at: nowIso,
            features: { ...supervisorState.features, [esc.feature_id]: updatedTracking },
            pending_escalations: resolvedEscalations,
            audit_log: [
              ...supervisorState.audit_log,
              { timestamp: nowIso, action_kind: 'update_state', feature_id: esc.feature_id, packet_id: null, message: `Resolved acceptance escalation '${esc.id}'.` },
            ],
          },
        });
      }
    }

    // Escalation still unresolved — report it
    if (esc.kind === 'acceptance') {
      return makeAction('escalate_acceptance', esc.feature_id, esc.message, { escalation: esc });
    }
    if (esc.kind === 'blocked') {
      return makeAction('escalate_blocked', esc.feature_id, esc.message, { escalation: esc });
    }
    return makeAction('escalate_failure', esc.feature_id, esc.message, { escalation: esc });
  }

  // ---------------------------------------------------------------------------
  // Priority 3: Process each tracked feature (SI-5: via resolveExecuteAction)
  // ---------------------------------------------------------------------------

  const aggregatedReadyPackets: PacketAssignment[] = [];
  const aggregatedDispatches: DispatchRecord[] = [];
  const aggregatedFeatureIds: string[] = [];
  const aggregatedFeaturePatches: Record<string, FeatureTracking> = {};
  const aggregatedAuditEntries: AuditEntry[] = [];
  let hasInProgressOnlyFeature = false;

  for (const feature of targetFeatures) {
    const tracking = supervisorState.features[feature.id];
    if (tracking === undefined) continue; // Should have been handled by P1
    if (tracking.phase === 'complete') continue;

    // Get factory's view of this feature
    const featurePackets = input.packets.filter((p) => feature.packets.includes(p.id));
    const executeAction: ExecuteAction = resolveExecuteAction({
      feature,
      packets: featurePackets,
      completionIds: input.completionIds,
      acceptanceIds: input.acceptanceIds,
      linkedIntentStatus: typeof feature.intent_id === 'string' ? intentStatusById.get(feature.intent_id) : undefined,
      personas: input.personas,
      startCommand: input.commands?.start,
      acceptCommand: input.commands?.accept,
    });

    switch (executeAction.kind) {
      case 'spawn_packets': {
        if (executeAction.ready_packets.length > 0) {
          const newSpawned = [...new Set([...tracking.packets_spawned, ...executeAction.ready_packets.map((p) => p.packet_id)])];
          const retainedDispatches = pruneActiveDispatches(tracking.active_dispatches, input.completionIds, input.acceptanceIds);
          const dispatches: DispatchRecord[] = executeAction.ready_packets.map((packet) => {
            const existing = retainedDispatches.find((dispatch) => dispatch.packet_id === packet.packet_id);
            const isStale = existing !== undefined && (
              existing.persona !== packet.persona ||
              (existing.task !== undefined && packet.task !== undefined && existing.task !== packet.task)
            );
            if (existing !== undefined && !isStale) {
              return existing;
            }
            return {
              dispatch_id: dispatchId(feature.id, packet.packet_id, now),
              feature_id: feature.id,
              packet_id: packet.packet_id,
              persona: packet.persona,
              task: packet.task,
              model: packet.model,
              instructions: packet.instructions,
              start_command: packet.start_command,
              dispatched_at: nowIso,
            };
          });
          const updatedTracking: FeatureTracking = {
            ...tracking,
            phase: 'executing',
            last_tick_at: nowIso,
            packets_spawned: newSpawned,
            active_dispatches: [
              ...retainedDispatches.filter((dispatch) =>
                !dispatches.some((nextDispatch) => nextDispatch.packet_id === dispatch.packet_id)
              ),
              ...dispatches,
            ],
            tick_count: tracking.tick_count + 1,
          };
          aggregatedReadyPackets.push(...executeAction.ready_packets);
          aggregatedDispatches.push(...dispatches);
          aggregatedFeatureIds.push(feature.id);
          aggregatedFeaturePatches[feature.id] = updatedTracking;
          aggregatedAuditEntries.push(
            ...executeAction.ready_packets.map((rp) => ({
              timestamp: nowIso,
              action_kind: 'execute_feature' as const,
              feature_id: feature.id,
              packet_id: rp.packet_id,
              message: `Spawning ${rp.persona} agent for packet '${rp.packet_id}' (${rp.model}).`,
            })),
          );
          continue;
        }
        // Only in-progress packets — waiting
        if (executeAction.in_progress_packets.length > 0) {
          hasInProgressOnlyFeature = true;
        }
        continue;
      }

      case 'awaiting_acceptance': {
        // Create escalation for acceptance
        const needsAcceptance = feature.packets.filter((pid) => {
          const pkt = featurePackets.find((p) => p.id === pid);
          return pkt !== undefined && pkt.kind === 'dev' && pkt.change_class === 'architectural' && !input.acceptanceIds.has(pid);
        });

        const esc: Escalation = {
          id: escalationId('acceptance', feature.id, now),
          kind: 'acceptance',
          feature_id: feature.id,
          packet_ids: needsAcceptance,
          created_at: nowIso,
          message: `Feature '${feature.id}': all packets complete. Architectural packets need human acceptance:\n` +
            needsAcceptance.map((id) => `  - ${id}`).join('\n') +
            `\n  Use: ${input.commands?.accept?.('<packet-id>') ?? 'npx tsx tools/accept.ts <packet-id>'}`,
          resolved: false,
          resolved_at: null,
        };

        const updatedTracking: FeatureTracking = {
          ...tracking,
          phase: 'awaiting_human',
          last_tick_at: nowIso,
          active_dispatches: pruneActiveDispatches(tracking.active_dispatches, input.completionIds, input.acceptanceIds),
          tick_count: tracking.tick_count + 1,
        };

        return makeAction('escalate_acceptance', feature.id, esc.message, {
          escalation: esc,
          state_patch: {
            updated_at: nowIso,
            features: { ...supervisorState.features, [feature.id]: updatedTracking },
            pending_escalations: [...supervisorState.pending_escalations, esc],
            audit_log: [
              ...supervisorState.audit_log,
              { timestamp: nowIso, action_kind: 'escalate_acceptance', feature_id: feature.id, packet_id: null, message: `Escalated: ${String(needsAcceptance.length)} architectural packet(s) need acceptance.` },
            ],
          },
        });
      }

      case 'all_complete': {
        const updatedTracking: FeatureTracking = {
          ...tracking,
          phase: 'complete',
          last_tick_at: nowIso,
          active_dispatches: [],
          tick_count: tracking.tick_count + 1,
        };
        return makeAction('update_state', feature.id,
          `Feature '${feature.id}': all packets complete and accepted. Feature delivered.`,
          {
            state_patch: {
              updated_at: nowIso,
              features: { ...supervisorState.features, [feature.id]: updatedTracking },
              audit_log: [
                ...supervisorState.audit_log,
                { timestamp: nowIso, action_kind: 'update_state', feature_id: feature.id, packet_id: null, message: `Feature '${feature.id}' completed.` },
              ],
            },
          },
        );
      }

      case 'blocked': {
        const blockedDesc = executeAction.blocked_packets.map((b) => `${b.id} → needs: ${b.blocked_by.join(', ')}`).join('; ');
        const esc: Escalation = {
          id: escalationId('blocked', feature.id, now),
          kind: 'blocked',
          feature_id: feature.id,
          packet_ids: executeAction.blocked_packets.map((b) => b.id),
          created_at: nowIso,
          message: `Feature '${feature.id}' is blocked: ${blockedDesc}`,
          resolved: false,
          resolved_at: null,
        };

        const updatedTracking: FeatureTracking = {
          ...tracking,
          phase: 'blocked',
          blocked_reason: blockedDesc,
          last_tick_at: nowIso,
          active_dispatches: pruneActiveDispatches(tracking.active_dispatches, input.completionIds, input.acceptanceIds),
          tick_count: tracking.tick_count + 1,
        };

        return makeAction('escalate_blocked', feature.id, esc.message, {
          escalation: esc,
          state_patch: {
            updated_at: nowIso,
            features: { ...supervisorState.features, [feature.id]: updatedTracking },
            pending_escalations: [...supervisorState.pending_escalations, esc],
            audit_log: [
              ...supervisorState.audit_log,
              { timestamp: nowIso, action_kind: 'escalate_blocked', feature_id: feature.id, packet_id: null, message: esc.message },
            ],
          },
        });
      }

      case 'not_approved': {
        // Feature not approved — skip silently (it'll be picked up when approved)
        continue;
      }

      case 'feature_not_found': {
        // Shouldn't happen since we read features from disk, but handle gracefully
        continue;
      }
    }
  }

  if (aggregatedReadyPackets.length > 0) {
    const featureSummary = aggregatedFeatureIds.length === 1
      ? `Feature '${aggregatedFeatureIds[0]}': ${String(aggregatedReadyPackets.length)} packet(s) ready to spawn.`
      : `${String(aggregatedReadyPackets.length)} packet(s) ready to spawn across ${String(aggregatedFeatureIds.length)} feature(s): ${aggregatedFeatureIds.join(', ')}.`;
    const primaryFeatureId = aggregatedFeatureIds.length === 1 ? aggregatedFeatureIds[0]! : null;
    return makeAction('execute_feature', primaryFeatureId, featureSummary, {
      feature_ids: aggregatedFeatureIds,
      ready_packets: aggregatedReadyPackets,
      dispatches: aggregatedDispatches,
      state_patch: {
        updated_at: nowIso,
        features: { ...supervisorState.features, ...aggregatedFeaturePatches },
        audit_log: [
          ...supervisorState.audit_log,
          ...aggregatedAuditEntries,
        ],
      },
    });
  }

  // All features are either complete, not approved, or waiting
  if (hasInProgressOnlyFeature) {
    return makeAction('idle', null, 'No new packets are ready. Active features are waiting on in-progress work or external action.');
  }

  return makeAction('idle', null, 'All tracked features are complete or awaiting external action.');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAction(action: SupervisorAction): string {
  const lines: string[] = [];

  lines.push(fmt.header('SUPERVISOR'));
  lines.push('');

  if (action.feature_id !== null) {
    lines.push(`  Feature: ${fmt.bold(action.feature_id)}`);
  } else if (action.feature_ids.length > 0) {
    lines.push(`  Features: ${action.feature_ids.map((id) => fmt.bold(id)).join(', ')}`);
  }
  lines.push(`  Action:  ${fmt.info(action.kind)}`);
  lines.push('');

  if (action.ready_packets.length > 0) {
    lines.push(`  ${fmt.sym.arrow} ${fmt.info('Spawn agents:')}`);
    for (const a of action.ready_packets) {
      lines.push(`    - ${fmt.bold(a.packet_id)} [${a.persona}] ${fmt.muted(`(${a.model})`)}`);
      if (a.instructions.length > 0) {
        for (const instr of a.instructions) {
          lines.push(`      ${fmt.sym.bullet} ${instr}`);
        }
      }
    }
    lines.push('');
  }

  if (action.dispatches.length > 0) {
    lines.push(`  ${fmt.bold('Dispatches:')}`);
    for (const dispatch of action.dispatches) {
      lines.push(`    - ${fmt.bold(dispatch.packet_id)} ${fmt.sym.arrow} ${fmt.muted(dispatch.dispatch_id)}`);
    }
    lines.push('');
  }

  if (action.escalation !== null) {
    lines.push(`  ${fmt.sym.warn} ${fmt.warn('Escalation:')}`);
    lines.push(`    Kind: ${action.escalation.kind}`);
    lines.push(`    ${action.escalation.message.split('\n').join('\n    ')}`);
    lines.push('');
  }

  lines.push(fmt.divider());
  lines.push(`  ${action.message.split('\n').join('\n  ')}`);
  lines.push(fmt.divider());
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

function emptyState(identity: { kind: string; id: string }, now: Date): SupervisorState {
  return {
    version: 1,
    updated_at: now.toISOString(),
    updated_by: identity,
    features: {},
    pending_escalations: [],
    audit_log: [],
  };
}

function readSupervisorState(artifactRoot: string): SupervisorState | null {
  const statePath = join(artifactRoot, 'supervisor', 'state.json');
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as SupervisorState;
  } catch {
    return null;
  }
}

function writeSupervisorState(artifactRoot: string, state: SupervisorState): void {
  const dir = join(artifactRoot, 'supervisor');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function ensureSupervisorMemory(artifactRoot: string): string {
  const dir = join(artifactRoot, 'supervisor');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const memoryPath = join(dir, 'memory.md');
  if (!existsSync(memoryPath)) {
    writeFileSync(
      memoryPath,
      '# Supervisor Memory\n\nPersistent project context and notable execution history.\n',
      'utf-8',
    );
  }
  return memoryPath;
}

function appendSupervisorMemory(memoryPath: string, note: string): void {
  const current = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf-8') : '';
  if (current.includes(note)) return;
  const next = `${current.trimEnd()}\n\n${note}\n`;
  writeFileSync(memoryPath, next, 'utf-8');
}

function memoryNoteForAction(action: SupervisorAction, previousState: SupervisorState): string | null {
  if (action.feature_id === null) return null;

  if (action.kind === 'escalate_blocked' && action.escalation !== null) {
    return `## ${action.escalation.created_at} — Blocked Feature\n- Feature: ${action.feature_id}\n- Issue: ${action.escalation.message.replace(/\n/g, ' ')}`;
  }

  if (action.kind === 'escalate_acceptance' && action.escalation !== null) {
    return `## ${action.escalation.created_at} — Awaiting Acceptance\n- Feature: ${action.feature_id}\n- Issue: ${action.escalation.message.replace(/\n/g, ' ')}`;
  }

  if (action.kind === 'update_state' && action.state_patch?.features !== undefined) {
    const beforePhase = previousState.features[action.feature_id]?.phase ?? null;
    const afterPhase = action.state_patch.features[action.feature_id]?.phase ?? null;
    if (beforePhase !== 'complete' && afterPhase === 'complete') {
      const timestamp = action.state_patch.updated_at ?? new Date().toISOString();
      return `## ${timestamp} — Feature Complete\n- Feature: ${action.feature_id}\n- Note: Supervisor observed all packets complete and accepted.`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Artifact reading (same patterns as execute.ts / status.ts)
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<T>(join(dir, f)))
    .filter((x): x is T => x !== null);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const jsonMode = args.includes('--json');
  const initMode = args.includes('--init');
  const featureIdx = args.indexOf('--feature');
  const featureFilter = featureIdx !== -1 ? args[featureIdx + 1] : undefined;

  const config = loadConfig();
  const projectRoot = findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);
  const now = new Date();

  const identity = config.completed_by_default;

  // --init: create empty state file
  if (initMode) {
    const existing = readSupervisorState(artifactRoot);
    if (existing !== null) {
      console.error('ERROR: supervisor/state.json already exists. Delete it first to re-initialize.');
      process.exit(1);
    }
    const state = emptyState(identity, now);
    writeSupervisorState(artifactRoot, state);
    ensureSupervisorMemory(artifactRoot);
    console.log('Supervisor state initialized: supervisor/state.json');
    return;
  }

  // Read supervisor state
  const supervisorState = readSupervisorState(artifactRoot);
  if (supervisorState === null) {
    console.error('ERROR: supervisor/state.json not found.');
    console.error('Run: npx tsx tools/supervise.ts --init');
    process.exit(1);
  }
  const memoryPath = ensureSupervisorMemory(artifactRoot);

  // Read factory artifacts
  const intents = readJsonDir<{ id: string; status: 'proposed' | 'approved' | 'planned' | 'superseded' | 'delivered' }>(join(artifactRoot, 'intents'));
  const features = readJsonDir<Feature>(join(artifactRoot, 'features'));
  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const completions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const acceptances = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'acceptances'));

  const completionIds = new Set(completions.map((c) => c.packet_id));
  const acceptanceIds = new Set(acceptances.map((a) => a.packet_id));

  // Resolve action
  const action = resolveSupervisorAction({
    supervisorState,
    features,
    packets,
    intents,
    completionIds,
    acceptanceIds,
    personas: config.personas,
    now,
    featureFilter,
    commands: {
      start: (packetId) => buildToolCommand('start.ts', [packetId], projectRoot, config),
      accept: (packetId) => buildToolCommand('accept.ts', [packetId], projectRoot, config),
    },
  });

  // Output
  if (jsonMode) {
    console.log(JSON.stringify(action, null, 2));
  } else {
    console.log(renderAction(action));
  }

  // Apply state patch if present
  if (action.state_patch !== null) {
    const patched: SupervisorState = {
      ...supervisorState,
      ...action.state_patch,
      version: supervisorState.version,
    };
    writeSupervisorState(artifactRoot, patched);
    const memoryNote = memoryNoteForAction(action, supervisorState);
    if (memoryNote !== null) {
      appendSupervisorMemory(memoryPath, memoryNote);
    }
    if (!jsonMode) {
      console.log('  State updated: supervisor/state.json');
      if (memoryNote !== null) {
        console.log('  Memory updated: supervisor/memory.md');
      }
    }
  }
}

const isDirectExecution = process.argv[1]?.endsWith('supervise.ts') ||
  process.argv[1]?.endsWith('supervise.js');
if (isDirectExecution) {
  main();
}
