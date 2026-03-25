#!/usr/bin/env tsx
/**
 * Factory — Execute (Stateless Action Resolver)
 *
 * Reads a feature manifest and factory state, then outputs exactly
 * which packets are ready for execution. Does NOT spawn agents.
 * The LLM reads this output and spawns agents accordingly.
 *
 * Designed to be called repeatedly in a loop. Each invocation reads
 * state from disk — no memory between calls.
 *
 * Usage:
 *   npx tsx tools/execute.ts <feature-id>
 *   npx tsx tools/execute.ts <feature-id> --json
 *
 * Exit codes:
 *   0 — action resolved
 *   1 — error (feature not found, invalid state)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveFactoryRoot } from './config.js';
import type { FactoryConfig, PersonasConfig, ModelTier } from './config.js';

// ---------------------------------------------------------------------------
// Types (exported for testing)
// ---------------------------------------------------------------------------

export interface Feature {
  readonly id: string;
  readonly intent: string;
  readonly status: 'draft' | 'planned' | 'approved' | 'executing' | 'completed' | 'delivered';
  readonly packets: ReadonlyArray<string>;
  readonly created_by: { readonly kind: string; readonly id: string };
  readonly approved_at?: string | null;
}

export interface PacketState {
  readonly id: string;
  readonly title: string;
  readonly change_class: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly started_at: string | null;
  readonly has_completion: boolean;
  readonly has_acceptance: boolean;
  readonly is_accepted: boolean;
}

export type ExecuteActionKind =
  | 'spawn_packets'
  | 'awaiting_acceptance'
  | 'all_complete'
  | 'blocked'
  | 'not_approved'
  | 'feature_not_found';

export type Persona = 'developer' | 'reviewer';

export interface PacketAssignment {
  readonly packet_id: string;
  readonly persona: Persona;
  readonly model: ModelTier;
  readonly instructions: ReadonlyArray<string>;
}

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

interface RawPacket {
  readonly id: string;
  readonly kind: 'dev' | 'qa';
  readonly title: string;
  readonly change_class: string;
  readonly verifies?: string | null;
  readonly started_at?: string | null;
  readonly status?: string | null;
  readonly dependencies?: ReadonlyArray<string>;
  readonly model?: ModelTier;
  readonly instructions?: ReadonlyArray<string>;
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
  readonly acceptanceIds: ReadonlySet<string>;
  readonly personas?: PersonasConfig;
}

function isAccepted(
  packet: RawPacket,
  completionMap: ReadonlyMap<string, boolean>,
  acceptanceIds: ReadonlySet<string>,
): boolean {
  if (acceptanceIds.has(packet.id)) return true;
  const passes = completionMap.get(packet.id);
  if (passes === undefined) return false;
  const cc = packet.change_class;
  return (cc === 'trivial' || cc === 'local' || cc === 'cross_cutting') && passes;
}

export function resolveExecuteAction(input: ExecuteInput): ExecuteAction {
  const { feature } = input;

  if (feature.status !== 'approved' && feature.status !== 'executing') {
    return {
      kind: 'not_approved',
      feature_id: feature.id,
      ready_packets: [],
      in_progress_packets: [],
      completed_packets: [],
      blocked_packets: [],
      total_packets: feature.packets.length,
      message: `Feature '${feature.id}' is in status '${feature.status}'. Must be 'approved' or 'executing' to run.`,
    };
  }

  const allPacketMap = new Map<string, RawPacket>();
  for (const p of input.packets) {
    allPacketMap.set(p.id, p);
  }

  const completionVerifMap = new Map<string, boolean>();
  for (const id of input.completionIds) {
    completionVerifMap.set(id, true);
  }

  const featurePacketIds = new Set(feature.packets);

  const completedPackets: string[] = [];
  const inProgressPackets: PacketAssignment[] = [];
  const readyPackets: PacketAssignment[] = [];
  const blockedPackets: Array<{ id: string; blocked_by: string[] }> = [];

  function assignPacket(packet: RawPacket): PacketAssignment {
    const persona: Persona = packet.kind === 'qa' ? 'reviewer' : 'developer';
    const personaConfig = input.personas?.[persona];
    const personaInstructions = personaConfig?.instructions ?? [];
    const packetInstructions = packet.instructions ?? [];
    const model: ModelTier = packet.model ?? personaConfig?.model ?? 'opus';
    return {
      packet_id: packet.id,
      persona,
      model,
      instructions: [...personaInstructions, ...packetInstructions],
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

    if (packet.started_at != null) {
      inProgressPackets.push(assignPacket(packet));
      continue;
    }

    const deps = packet.dependencies ?? [];
    const unmetDeps: string[] = [];
    for (const dep of deps) {
      if (!featurePacketIds.has(dep)) {
        if (!isAccepted(
          allPacketMap.get(dep) ?? { id: dep, title: '', change_class: 'local' },
          completionVerifMap,
          input.acceptanceIds,
        )) {
          unmetDeps.push(dep);
        }
        continue;
      }
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
    // All packets complete — check if architectural dev packets need human acceptance
    // Architectural dev packets require: (1) their QA counterpart is complete, (2) explicit human acceptance
    const needsAcceptance: string[] = [];
    for (const pktId of feature.packets) {
      const packet = allPacketMap.get(pktId);
      if (packet === undefined) continue;
      if (packet.kind === 'dev' && packet.change_class === 'architectural' && !input.acceptanceIds.has(pktId)) {
        // Check that the QA counterpart is complete
        const qaPacket = input.packets.find((p) => p.verifies === pktId);
        const qaComplete = qaPacket !== undefined && input.completionIds.has(qaPacket.id);
        if (qaComplete) {
          needsAcceptance.push(pktId);
        }
      }
    }

    if (needsAcceptance.length > 0) {
      return {
        kind: 'awaiting_acceptance',
        feature_id: feature.id,
        ready_packets: [],
        in_progress_packets: [],
        completed_packets: completedPackets,
        blocked_packets: [],
        total_packets: feature.packets.length,
        message:
          `Feature '${feature.id}': all packets complete. Awaiting human acceptance for architectural packets:\n` +
          needsAcceptance.map((id) => `  - ${id}`).join('\n') +
          `\n  Use npx tsx tools/accept.ts <packet-id> for each.`,
      };
    }

    return {
      kind: 'all_complete',
      feature_id: feature.id,
      ready_packets: [],
      in_progress_packets: [],
      completed_packets: completedPackets,
      blocked_packets: [],
      total_packets: feature.packets.length,
      message:
        `Feature '${feature.id}': all ${String(feature.packets.length)} packets complete.\n` +
        `  All QA verifications and acceptances satisfied.\n` +
        `  Feature is ready for delivery.`,
    };
  }

  if (readyPackets.length > 0) {
    const readyDesc = readyPackets.map((r) => `${r.packet_id} (${r.persona})`).join(', ');
    const ipDesc = inProgressPackets.map((r) => `${r.packet_id} (${r.persona})`).join(', ');
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
        `  Ready to execute: ${readyDesc}\n` +
        (inProgressPackets.length > 0 ? `  In progress: ${ipDesc}\n` : '') +
        (blockedPackets.length > 0 ? `  Blocked: ${blockedPackets.map((b) => b.id).join(', ')}\n` : '') +
        `  Spawn ${String(readyPackets.length)} agent(s) for ready packets.`,
    };
  }

  if (inProgressPackets.length > 0) {
    const ipDesc = inProgressPackets.map((r) => `${r.packet_id} (${r.persona})`).join(', ');
    return {
      kind: 'spawn_packets',
      feature_id: feature.id,
      ready_packets: [],
      in_progress_packets: inProgressPackets,
      completed_packets: completedPackets,
      blocked_packets: blockedPackets,
      total_packets: feature.packets.length,
      message:
        `Feature '${feature.id}': ${String(completedPackets.length)}/${String(feature.packets.length)} complete.\n` +
        `  In progress (awaiting completion): ${ipDesc}\n` +
        (blockedPackets.length > 0 ? `  Blocked: ${blockedPackets.map((b) => b.id).join(', ')}\n` : '') +
        `  Wait for in-progress packets to complete, then re-run.`,
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
      `  Blocked packets:\n` +
      blockedPackets.map((b) => `    - ${b.id} \u2192 needs: ${b.blocked_by.join(', ')}`).join('\n') +
      `\n  Resolve dependencies or replan.`,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAction(action: ExecuteAction): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('\u2550'.repeat(59));
  lines.push('  FACTORY EXECUTE');
  lines.push('\u2550'.repeat(59));
  lines.push('');
  lines.push(`  Feature: ${action.feature_id}`);
  lines.push(`  Progress: ${String(action.completed_packets.length)}/${String(action.total_packets)} packets complete`);
  lines.push('');

  if (action.completed_packets.length > 0) {
    lines.push('  \u2713 Completed:');
    for (const id of action.completed_packets) {
      lines.push(`    - ${id}`);
    }
    lines.push('');
  }

  if (action.in_progress_packets.length > 0) {
    lines.push('  \u23f3 In progress:');
    for (const a of action.in_progress_packets) {
      lines.push(`    - ${a.packet_id} [${a.persona}] (${a.model})`);
    }
    lines.push('');
  }

  if (action.ready_packets.length > 0) {
    lines.push('  \u2192 Ready to spawn:');
    for (const a of action.ready_packets) {
      lines.push(`    - ${a.packet_id} [${a.persona}] (${a.model})`);
      if (a.instructions.length > 0) {
        for (const instr of a.instructions) {
          lines.push(`      \u2022 ${instr}`);
        }
      }
    }
    lines.push('');
  }

  if (action.blocked_packets.length > 0) {
    lines.push('  \ud83d\udeab Blocked:');
    for (const b of action.blocked_packets) {
      lines.push(`    - ${b.id} \u2192 needs: ${b.blocked_by.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('\u2500'.repeat(59));
  lines.push('  ACTION:');
  lines.push(`    ${action.message.split('\n').join('\n    ')}`);
  lines.push('\u2500'.repeat(59));
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
  const factoryRoot = resolveFactoryRoot(undefined, config);
  const featurePath = join(factoryRoot, 'features', `${resolvedFeatureId}.json`);

  if (!existsSync(featurePath)) {
    console.error(`Feature not found: ${featurePath}`);
    console.error(`Available features:`);
    const featDir = join(factoryRoot, 'features');
    if (existsSync(featDir)) {
      const files = readdirSync(featDir).filter((f) => f.endsWith('.json'));
      if (files.length === 0) {
        console.error('  (none)');
      } else {
        for (const f of files) {
          console.error(`  - ${f.replace('.json', '')}`);
        }
      }
    }
    process.exit(1);
  }

  const feature = readJson<Feature>(featurePath);
  if (feature === null) {
    console.error(`Failed to parse feature: ${featurePath}`);
    process.exit(1);
  }

  const packets = readJsonDir<RawPacket>(join(factoryRoot, 'packets'));
  const completions = readJsonDir<RawCompletion>(join(factoryRoot, 'completions'));
  const acceptances = readJsonDir<RawAcceptance>(join(factoryRoot, 'acceptances'));

  const completionIds = new Set(completions.map((c) => c.packet_id));
  const acceptanceIds = new Set(acceptances.map((a) => a.packet_id));

  const action = resolveExecuteAction({
    feature,
    packets,
    completionIds,
    acceptanceIds,
    personas: config.personas,
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
