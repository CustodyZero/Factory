/**
 * Factory — Lifecycle / Start
 *
 * Library function for claiming a packet (the "start" lifecycle step).
 * The CLI wrapper at tools/start.ts re-exports from here.
 *
 * SCOPE FOR PHASE 3
 *
 * Phase 3 of specs/single-entry-pipeline.md library-izes the lifecycle
 * scripts so run.ts (and any future orchestrator) can call them directly
 * via import rather than spawning a subprocess. Agents continue to call
 * the CLI entry points; only internal callers switch.
 *
 * This file does I/O (it reads/writes packet JSON) — that is unavoidable
 * because "claim a packet" is a state-mutation operation. What it does
 * NOT do is shell out to other lifecycle scripts. That distinction is
 * what lets Phase 3 collapse run.ts's runLifecycle() helper.
 *
 * Idempotency contract (carried forward from Phase 2):
 *   - If the packet has already been started (started_at present), the
 *     function returns `already_started: true` without modifying the
 *     file. The caller can detect this from the return value.
 *   - Abandoned/deferred packets throw (cannot be started).
 *   - A packet that already has a completion record throws (cannot be
 *     re-claimed).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from '../config.js';
import type { FactoryConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StartPacketOptions {
  readonly packetId: string;
  readonly projectRoot?: string;
  readonly config?: FactoryConfig;
}

export interface StartPacketResult {
  readonly packet_id: string;
  readonly status: string;
  readonly started_at: string;
  readonly already_started: boolean;
}

/**
 * Structured error so the CLI can render the original multi-line output
 * (`ERROR: <summary>`) and library callers can distinguish a precondition
 * failure from a generic Error. Mirrors the pattern used by the other
 * lifecycle modules.
 */
export class StartPacketError extends Error {
  readonly details: ReadonlyArray<string>;
  constructor(summary: string, details: ReadonlyArray<string> = []) {
    super(summary);
    this.name = 'StartPacketError';
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Library entry
// ---------------------------------------------------------------------------

/**
 * Claim a packet by setting started_at and status='implementing'.
 *
 * Throws StartPacketError on precondition failures (missing packet,
 * already-completed packet, abandoned/deferred packet). Returns a
 * result object with `already_started: true` when the packet was
 * previously started; the file is NOT rewritten in that case.
 */
export function startPacket(options: StartPacketOptions): StartPacketResult {
  const config = options.config ?? loadConfig(options.projectRoot);
  const projectRoot = options.projectRoot ?? findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);
  const { packetId } = options;

  const packetPath = join(artifactRoot, 'packets', `${packetId}.json`);
  if (!existsSync(packetPath)) {
    throw new StartPacketError(`Packet not found: packets/${packetId}.json`);
  }

  const completionPath = join(artifactRoot, 'completions', `${packetId}.json`);
  if (existsSync(completionPath)) {
    throw new StartPacketError(`Packet '${packetId}' already has a completion record.`);
  }

  const raw = readFileSync(packetPath, 'utf-8');
  const packet = JSON.parse(raw) as Record<string, unknown>;
  const status = typeof packet['status'] === 'string' ? packet['status'] : null;

  if (status === 'abandoned' || status === 'deferred') {
    throw new StartPacketError(
      `Packet '${packetId}' is marked '${status}' and cannot be started.`,
    );
  }

  // Idempotency: already started → return without modifying the file.
  if (typeof packet['started_at'] === 'string' && packet['started_at'].length > 0) {
    return {
      packet_id: packetId,
      status: status ?? '',
      started_at: packet['started_at'],
      already_started: true,
    };
  }

  const now = new Date().toISOString();
  packet['started_at'] = now;
  packet['status'] = 'implementing';
  writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');

  return {
    packet_id: packetId,
    status: 'implementing',
    started_at: now,
    already_started: false,
  };
}
