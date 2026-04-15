#!/usr/bin/env tsx
/**
 * Factory — Execute (Work List Resolver)
 *
 * Reads a feature manifest and factory state, returns an ordered list
 * of packets ready for execution with persona assignments.
 *
 * Usage:
 *   npx tsx tools/execute.ts <feature-id>
 *   npx tsx tools/execute.ts <feature-id> --json
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildToolCommand, loadConfig, resolveArtifactRoot } from './config.js';
import type { FactoryConfig, PersonasConfig, ModelTier } from './config.js';
import * as fmt from './output.js';

// ---------------------------------------------------------------------------
// Types (exported for testing)
// ---------------------------------------------------------------------------

export interface Feature {
  readonly id: string;
  readonly intent: string;
  readonly status: 'planned' | 'executing' | 'completed' | 'delivered';
  readonly packets: ReadonlyArray<string>;
  readonly created_by: { readonly kind: string; readonly id: string };
  readonly approved_at?: string | null;
  readonly intent_id?: string | null;
}

export interface RawPacket {
  readonly id: string;
  readonly kind: 'dev' | 'qa';
  readonly title: string;
  readonly change_class?: string;
  readonly verifies?: string | null;
  readonly started_at?: string | null;
  readonly status?: string | null;
  readonly dependencies?: ReadonlyArray<string>;
  readonly branch?: string | null;
  readonly review_iteration?: number;
  readonly model?: ModelTier;
  readonly instructions?: ReadonlyArray<string>;
  readonly acceptance_criteria?: ReadonlyArray<string>;
  readonly feature_id?: string | null;
}

export type Persona = 'developer' | 'code_reviewer' | 'qa';
export type DispatchTask = 'implement' | 'rework' | 'finalize' | 'review' | 'verify';

export interface PacketAssignment {
  readonly packet_id: string;
  readonly persona: Persona;
  readonly task: DispatchTask;
  readonly model: ModelTier;
  readonly instructions: ReadonlyArray<string>;
  readonly start_command: string;
}

export type ExecuteActionKind =
  | 'spawn_packets'
  | 'all_complete'
  | 'blocked'
  | 'not_ready'
  | 'feature_not_found';

export interface ExecuteAction {
  readonly kind: ExecuteActionKind;
  readonly feature_id: string;
  readonly ready_packets: ReadonlyArray<PacketAssignment>;
  readonly in_progress_packets: ReadonlyArray<PacketAssignment>;
  readonly completed_packets: ReadonlyArray<string>;
  readonly blocked_packets: ReadonlyArray<{ readonly id: string; readonly blocked_by: ReadonlyArray<string> }>;
  readonly total_packets: number;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Artifact reading
// ---------------------------------------------------------------------------

interface RawCompletion {
  readonly packet_id: string;
}

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
// Core logic (pure, testable)
// ---------------------------------------------------------------------------

export interface ExecuteInput {
  readonly feature: Feature;
  readonly packets: ReadonlyArray<RawPacket>;
  readonly completionIds: ReadonlySet<string>;
  readonly personas?: PersonasConfig;
  readonly startCommand?: ((packetId: string) => string) | undefined;
}

export function resolveExecuteAction(input: ExecuteInput): ExecuteAction {
  const { feature } = input;

  if (feature.status === 'completed' || feature.status === 'delivered') {
    return {
      kind: 'not_ready',
      feature_id: feature.id,
      ready_packets: [],
      in_progress_packets: [],
      completed_packets: [],
      blocked_packets: [],
      total_packets: feature.packets.length,
      message: `Feature '${feature.id}' is in status '${feature.status}'. Already finished.`,
    };
  }

  const allPacketMap = new Map<string, RawPacket>();
  for (const p of input.packets) {
    allPacketMap.set(p.id, p);
  }

  const completedPackets: string[] = [];
  const inProgressPackets: PacketAssignment[] = [];
  const readyPackets: PacketAssignment[] = [];
  const blockedPackets: Array<{ id: string; blocked_by: string[] }> = [];

  function assignPacket(packet: RawPacket, personaOverride?: Persona, taskOverride?: DispatchTask): PacketAssignment {
    const persona: Persona = personaOverride ?? (packet.kind === 'qa' ? 'qa' : 'developer');
    const task: DispatchTask = taskOverride ?? (persona === 'qa' ? 'verify' : 'implement');
    const personaConfig = input.personas?.[persona];
    const personaInstructions = personaConfig?.instructions ?? [];
    const packetInstructions = [...(packet.instructions ?? [])];
    if (persona === 'code_reviewer' && typeof packet.branch === 'string') {
      packetInstructions.push(`Review branch: ${packet.branch}`);
    }
    const model: ModelTier = packet.model ?? personaConfig?.model ?? 'high';
    return {
      packet_id: packet.id,
      persona,
      task,
      model,
      instructions: [...personaInstructions, ...packetInstructions],
      start_command: input.startCommand?.(packet.id) ?? `npx tsx tools/start.ts ${packet.id}`,
    };
  }

  for (const packetId of feature.packets) {
    const packet = allPacketMap.get(packetId);
    if (packet === undefined) {
      blockedPackets.push({ id: packetId, blocked_by: [`packet '${packetId}' not found`] });
      continue;
    }

    if (input.completionIds.has(packetId)) {
      completedPackets.push(packetId);
      continue;
    }

    // Status-aware routing for dev packets in the review lifecycle
    const pktStatus = packet.status ?? null;
    if (packet.kind === 'dev' && pktStatus === 'review_requested') {
      readyPackets.push(assignPacket(packet, 'code_reviewer', 'review'));
      continue;
    }
    if (packet.kind === 'dev' && pktStatus === 'changes_requested') {
      readyPackets.push(assignPacket(packet, 'developer', 'rework'));
      continue;
    }
    if (packet.kind === 'dev' && pktStatus === 'review_approved') {
      readyPackets.push(assignPacket(packet, 'developer', 'finalize'));
      continue;
    }

    if (packet.started_at != null) {
      inProgressPackets.push(assignPacket(packet));
      continue;
    }

    const deps = packet.dependencies ?? [];
    const unmetDeps: string[] = [];
    for (const dep of deps) {
      if (!input.completionIds.has(dep)) {
        unmetDeps.push(dep);
      }
    }

    if (unmetDeps.length > 0) {
      blockedPackets.push({ id: packetId, blocked_by: unmetDeps });
    } else {
      readyPackets.push(assignPacket(packet));
    }
  }

  if (completedPackets.length === feature.packets.length) {
    return {
      kind: 'all_complete',
      feature_id: feature.id,
      ready_packets: [],
      in_progress_packets: [],
      completed_packets: completedPackets,
      blocked_packets: [],
      total_packets: feature.packets.length,
      message: `Feature '${feature.id}': all ${String(feature.packets.length)} packets complete. Ready for delivery.`,
    };
  }

  if (readyPackets.length > 0 || inProgressPackets.length > 0) {
    const readyDesc = readyPackets.map((r) => `${r.packet_id} (${r.persona})`).join(', ');
    return {
      kind: 'spawn_packets',
      feature_id: feature.id,
      ready_packets: readyPackets,
      in_progress_packets: inProgressPackets,
      completed_packets: completedPackets,
      blocked_packets: blockedPackets,
      total_packets: feature.packets.length,
      message:
        `Feature '${feature.id}': ${String(completedPackets.length)}/${String(feature.packets.length)} complete.\n` +
        (readyPackets.length > 0 ? `  Ready: ${readyDesc}\n` : '') +
        `  Spawn ${String(readyPackets.length)} agent(s) for ready packets.`,
    };
  }

  return {
    kind: 'blocked',
    feature_id: feature.id,
    ready_packets: [],
    in_progress_packets: [],
    completed_packets: completedPackets,
    blocked_packets: blockedPackets,
    total_packets: feature.packets.length,
    message:
      `Feature '${feature.id}': BLOCKED. ${String(completedPackets.length)}/${String(feature.packets.length)} complete.\n` +
      blockedPackets.map((b) => `  - ${b.id} needs: ${b.blocked_by.join(', ')}`).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAction(action: ExecuteAction): string {
  const lines: string[] = [];

  lines.push(fmt.header('EXECUTE'));
  lines.push('');
  lines.push(`  Feature: ${fmt.bold(action.feature_id)}`);
  lines.push(`  Progress: ${fmt.bold(`${String(action.completed_packets.length)}/${String(action.total_packets)}`)} packets complete`);
  lines.push('');

  if (action.completed_packets.length > 0) {
    lines.push(`  ${fmt.sym.ok} ${fmt.success('Completed:')}`);
    for (const id of action.completed_packets) {
      lines.push(`    - ${fmt.muted(id)}`);
    }
    lines.push('');
  }

  if (action.in_progress_packets.length > 0) {
    lines.push(`  ${fmt.sym.pending} ${fmt.warn('In progress:')}`);
    for (const a of action.in_progress_packets) {
      lines.push(`    - ${fmt.bold(a.packet_id)} [${a.persona}] ${fmt.muted(`(${a.model})`)}`);
    }
    lines.push('');
  }

  if (action.ready_packets.length > 0) {
    lines.push(`  ${fmt.sym.arrow} ${fmt.info('Ready to spawn:')}`);
    for (const a of action.ready_packets) {
      lines.push(`    - ${fmt.bold(a.packet_id)} [${a.persona}] ${fmt.muted(`(${a.model})`)}`);
      lines.push(`      start: ${fmt.info(a.start_command)}`);
    }
    lines.push('');
  }

  if (action.blocked_packets.length > 0) {
    lines.push(`  ${fmt.sym.blocked} ${fmt.error('Blocked:')}`);
    for (const b of action.blocked_packets) {
      lines.push(`    - ${fmt.bold(b.id)} ${fmt.sym.arrow} needs: ${b.blocked_by.join(', ')}`);
    }
    lines.push('');
  }

  lines.push(fmt.divider());
  lines.push(`  ${fmt.bold('ACTION:')} ${action.kind}`);
  lines.push(fmt.divider());
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const positional = args.filter((a) => !a.startsWith('-'));
  const resolvedFeatureId = positional[0];

  if (resolvedFeatureId === undefined) {
    console.error('Usage: npx tsx tools/execute.ts <feature-id>');
    process.exit(1);
  }

  const config = loadConfig();
  const artifactRoot = resolveArtifactRoot(undefined, config);
  const featurePath = join(artifactRoot, 'features', `${resolvedFeatureId}.json`);

  if (!existsSync(featurePath)) {
    console.error(`Feature not found: ${featurePath}`);
    process.exit(1);
  }

  const feature = readJson<Feature>(featurePath);
  if (feature === null) {
    console.error(`Failed to parse feature: ${featurePath}`);
    process.exit(1);
  }

  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const completions = readJsonDir<RawCompletion>(join(artifactRoot, 'completions'));

  const completionIds = new Set(completions.map((c) => c.packet_id));

  const action = resolveExecuteAction({
    feature,
    packets,
    completionIds,
    personas: config.personas,
    startCommand: (packetId) => buildToolCommand('start.ts', [packetId], undefined, config),
  });

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(action, null, 2) + '\n');
  } else {
    process.stdout.write(renderAction(action));
  }
}

const isDirectExecution = process.argv[1]?.endsWith('execute.ts') ||
  process.argv[1]?.endsWith('execute.js');
if (isDirectExecution) {
  main();
}
