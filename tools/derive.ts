#!/usr/bin/env tsx
/**
 * Factory — Derivation Script
 *
 * Pure derivation function: reads all factory artifacts from disk,
 * applies derivation rules, and produces DerivedState as JSON.
 *
 * derived-state.json is NEVER committed — it is always recomputed.
 *
 * Usage:
 *   npx tsx tools/derive.ts              # print to stdout
 *   npx tsx tools/derive.ts --write      # write to derived-state.json
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveFactoryRoot } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChangeClass = 'trivial' | 'local' | 'cross_cutting' | 'architectural';
type PacketStatus = 'not_started' | 'in_progress' | 'completed' | 'environment_pending' | 'accepted';
type AcceptanceMode = 'verification' | 'human' | null;

interface Identity {
  readonly kind: string;
  readonly id: string;
}

interface Packet {
  readonly id: string;
  readonly title: string;
  readonly intent: string;
  readonly change_class: ChangeClass;
  readonly scope: {
    readonly packages: ReadonlyArray<string>;
    readonly files_hint?: ReadonlyArray<string> | null;
    readonly phase_ref?: string | null;
  };
  readonly owner: string;
  readonly created_at: string;
  readonly started_at?: string | null;
  readonly environment_dependencies?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
}

interface Verification {
  readonly tests_pass: boolean;
  readonly build_pass: boolean;
  readonly lint_pass: boolean;
  readonly ci_pass: boolean;
  readonly notes?: string | null;
}

interface Completion {
  readonly packet_id: string;
  readonly completed_at: string;
  readonly completed_by: Identity;
  readonly summary: string;
  readonly files_changed?: ReadonlyArray<string>;
  readonly verification: Verification;
}

interface Acceptance {
  readonly packet_id: string;
  readonly accepted_at: string;
  readonly accepted_by: Identity;
  readonly notes?: string | null;
}

interface Rejection {
  readonly packet_id: string;
  readonly rejected_at: string;
  readonly rejected_by: Identity;
  readonly reason: string;
}

interface Evidence {
  readonly dependency_key: string;
  readonly verified_at: string;
  readonly verified_by: Identity;
  readonly verification_method: string;
  readonly description: string;
  readonly proof?: string | null;
  readonly expires_at?: string | null;
}

interface DerivedPacketStatus {
  readonly packet_id: string;
  readonly change_class: ChangeClass;
  readonly status: PacketStatus;
  readonly acceptance_mode: AcceptanceMode;
  readonly audit_pending: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly has_unmet_dependencies: boolean;
  readonly unmet_dependencies: ReadonlyArray<string>;
}

interface DerivedState {
  readonly computed_at: string;
  readonly packets: ReadonlyArray<DerivedPacketStatus>;
  readonly summary: {
    readonly not_started: number;
    readonly in_progress: number;
    readonly completed: number;
    readonly environment_pending: number;
    readonly accepted: number;
    readonly audit_pending: number;
    readonly total: number;
  };
  readonly errors: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

const FACTORY_ROOT = resolveFactoryRoot(undefined, loadConfig());

function readJsonDir<T>(subdir: string): ReadonlyArray<{ filename: string; data: T }> {
  const dir = join(FACTORY_ROOT, subdir);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const results: Array<{ filename: string; data: T }> = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const data = JSON.parse(raw) as T;
      results.push({ filename: file, data });
    } catch {
      // Parse errors collected in derivation
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Derivation logic (pure)
// ---------------------------------------------------------------------------

function verificationPasses(v: Verification): boolean {
  return v.tests_pass && v.build_pass && v.lint_pass && v.ci_pass;
}

function isEvidenceValid(evidence: Evidence, now: Date): boolean {
  if (evidence.expires_at == null) return true;
  return new Date(evidence.expires_at) > now;
}

function derivePacketStatus(
  packet: Packet,
  completion: Completion | undefined,
  acceptance: Acceptance | undefined,
  rejection: Rejection | undefined,
  evidenceMap: ReadonlyMap<string, Evidence>,
  now: Date,
): DerivedPacketStatus {
  const reasons: string[] = [];
  const deps = packet.environment_dependencies ?? [];

  const unmetDeps: string[] = [];
  for (const depKey of deps) {
    const ev = evidenceMap.get(depKey);
    if (ev == null || !isEvidenceValid(ev, now)) {
      unmetDeps.push(depKey);
    }
  }
  const hasUnmetDeps = unmetDeps.length > 0;

  if (completion == null) {
    if (packet.started_at != null) {
      reasons.push('started_at is set, no completion record');
      return {
        packet_id: packet.id, change_class: packet.change_class,
        status: 'in_progress', acceptance_mode: null, audit_pending: false,
        reasons, has_unmet_dependencies: hasUnmetDeps, unmet_dependencies: unmetDeps,
      };
    }
    reasons.push('no completion record, started_at is null');
    return {
      packet_id: packet.id, change_class: packet.change_class,
      status: 'not_started', acceptance_mode: null, audit_pending: false,
      reasons, has_unmet_dependencies: hasUnmetDeps, unmet_dependencies: unmetDeps,
    };
  }

  if (acceptance != null && rejection == null) {
    reasons.push('human acceptance record exists');
    return {
      packet_id: packet.id, change_class: packet.change_class,
      status: 'accepted', acceptance_mode: 'human', audit_pending: false,
      reasons, has_unmet_dependencies: hasUnmetDeps, unmet_dependencies: unmetDeps,
    };
  }

  if (hasUnmetDeps) {
    reasons.push(`unmet environment dependencies: ${unmetDeps.join(', ')}`);
    return {
      packet_id: packet.id, change_class: packet.change_class,
      status: 'environment_pending', acceptance_mode: null, audit_pending: false,
      reasons, has_unmet_dependencies: true, unmet_dependencies: unmetDeps,
    };
  }

  const isRejected = rejection != null;

  if (packet.change_class === 'trivial' || packet.change_class === 'local') {
    if (verificationPasses(completion.verification)) {
      reasons.push(`change_class '${packet.change_class}' with passing verification — auto-accepted`);
      return {
        packet_id: packet.id, change_class: packet.change_class,
        status: 'accepted', acceptance_mode: 'verification', audit_pending: false,
        reasons, has_unmet_dependencies: false, unmet_dependencies: [],
      };
    }
    reasons.push(`change_class '${packet.change_class}' but verification not fully passing`);
    return {
      packet_id: packet.id, change_class: packet.change_class,
      status: 'completed', acceptance_mode: null, audit_pending: false,
      reasons, has_unmet_dependencies: false, unmet_dependencies: [],
    };
  }

  if (packet.change_class === 'cross_cutting') {
    if (isRejected) {
      reasons.push('cross_cutting auto-acceptance reverted by audit rejection');
      return {
        packet_id: packet.id, change_class: packet.change_class,
        status: 'completed', acceptance_mode: null, audit_pending: false,
        reasons, has_unmet_dependencies: false, unmet_dependencies: [],
      };
    }
    if (verificationPasses(completion.verification)) {
      reasons.push("change_class 'cross_cutting' with passing verification — auto-accepted, audit pending");
      return {
        packet_id: packet.id, change_class: packet.change_class,
        status: 'accepted', acceptance_mode: 'verification', audit_pending: true,
        reasons, has_unmet_dependencies: false, unmet_dependencies: [],
      };
    }
    reasons.push("change_class 'cross_cutting' but verification not fully passing");
    return {
      packet_id: packet.id, change_class: packet.change_class,
      status: 'completed', acceptance_mode: null, audit_pending: false,
      reasons, has_unmet_dependencies: false, unmet_dependencies: [],
    };
  }

  reasons.push("change_class 'architectural' — requires human acceptance record");
  return {
    packet_id: packet.id, change_class: packet.change_class,
    status: 'completed', acceptance_mode: null, audit_pending: false,
    reasons, has_unmet_dependencies: false, unmet_dependencies: [],
  };
}

// ---------------------------------------------------------------------------
// Main derivation
// ---------------------------------------------------------------------------

function derive(now: Date): DerivedState {
  const errors: string[] = [];

  const rawPackets = readJsonDir<Packet>('packets');
  const rawCompletions = readJsonDir<Completion>('completions');
  const rawAcceptances = readJsonDir<Acceptance>('acceptances');
  const rawRejections = readJsonDir<Rejection>('rejections');
  const rawEvidence = readJsonDir<Evidence>('evidence');

  const completionMap = new Map<string, Completion>();
  for (const { filename, data } of rawCompletions) {
    if (completionMap.has(data.packet_id)) {
      errors.push(`FI-1 violation: duplicate completion for packet '${data.packet_id}' (file: ${filename})`);
    }
    completionMap.set(data.packet_id, data);
  }

  const acceptanceMap = new Map<string, Acceptance>();
  for (const { filename, data } of rawAcceptances) {
    if (acceptanceMap.has(data.packet_id)) {
      errors.push(`FI-2 violation: duplicate acceptance for packet '${data.packet_id}' (file: ${filename})`);
    }
    acceptanceMap.set(data.packet_id, data);
  }

  const rejectionMap = new Map<string, Rejection>();
  for (const { data } of rawRejections) {
    rejectionMap.set(data.packet_id, data);
  }

  const evidenceMap = new Map<string, Evidence>();
  for (const { data } of rawEvidence) {
    evidenceMap.set(data.dependency_key, data);
  }

  for (const [packetId] of completionMap) {
    if (!rawPackets.some((p) => p.data.id === packetId)) {
      errors.push(`Orphaned completion: packet '${packetId}' does not exist`);
    }
  }

  for (const [packetId, acc] of acceptanceMap) {
    if (!completionMap.has(packetId)) {
      errors.push(`FI-4 violation: acceptance for '${packetId}' but no completion exists`);
    }
    if (acc.accepted_by.kind === 'agent') {
      errors.push(`FI-3 violation: agent-authored acceptance for '${packetId}'`);
    }
  }

  for (const [packetId, rej] of rejectionMap) {
    if (!rawPackets.some((p) => p.data.id === packetId)) {
      errors.push(`Orphaned rejection: packet '${packetId}' does not exist`);
    }
    if (rej.rejected_by.kind === 'agent') {
      errors.push(`FI-3 violation: agent-authored rejection for '${packetId}'`);
    }
  }

  const sortedPackets = [...rawPackets].sort((a, b) => a.data.id.localeCompare(b.data.id));

  const packetStatuses: DerivedPacketStatus[] = sortedPackets.map(({ data: packet }) => {
    const completion = completionMap.get(packet.id);
    const acceptance = acceptanceMap.get(packet.id);
    const rejection = rejectionMap.get(packet.id);
    return derivePacketStatus(packet, completion, acceptance, rejection, evidenceMap, now);
  });

  const summary = {
    not_started: 0, in_progress: 0, completed: 0,
    environment_pending: 0, accepted: 0, audit_pending: 0,
    total: packetStatuses.length,
  };

  for (const ps of packetStatuses) {
    summary[ps.status]++;
    if (ps.audit_pending) summary.audit_pending++;
  }

  return { computed_at: now.toISOString(), packets: packetStatuses, summary, errors };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const now = new Date();
  const state = derive(now);
  const json = JSON.stringify(state, null, 2);

  if (process.argv.includes('--write')) {
    const outPath = join(FACTORY_ROOT, 'derived-state.json');
    writeFileSync(outPath, json + '\n', 'utf-8');
    console.error(`Derived state written to ${outPath}`);
    console.error(`  ${state.summary.total} packets: ${state.summary.accepted} accepted, ${state.summary.completed} completed, ${state.summary.in_progress} in-progress, ${state.summary.not_started} not-started`);
    if (state.summary.audit_pending > 0) {
      console.error(`  ${state.summary.audit_pending} audit-pending`);
    }
    if (state.errors.length > 0) {
      console.error(`  ${state.errors.length} error(s):`);
      for (const err of state.errors) {
        console.error(`    - ${err}`);
      }
    }
  } else {
    process.stdout.write(json + '\n');
  }

  if (state.errors.length > 0) {
    process.exit(1);
  }
}

main();
