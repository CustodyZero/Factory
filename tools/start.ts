#!/usr/bin/env tsx
/**
 * Factory — Packet Start / Claim (CLI)
 *
 * Marks a packet as started before implementation begins.
 *
 * Usage:
 *   npx tsx tools/start.ts <packet-id>
 *
 * Phase 3 of specs/single-entry-pipeline.md moved the implementation to
 * tools/lifecycle/start.ts so run.ts can call it via import. This file
 * remains as the agent-facing CLI: argument parsing, output rendering,
 * exit codes. The library function stays I/O-pure-ish (it has to write
 * the packet JSON) but no longer mixes presentation with logic.
 *
 * Re-exports startPacket and StartPacketError for backward compat with
 * any caller that imported them from this path before Phase 3.
 */

import { startPacket, StartPacketError } from './lifecycle/start.js';
import type { StartPacketOptions, StartPacketResult } from './lifecycle/start.js';
import * as fmt from './output.js';

export { startPacket, StartPacketError };
export type { StartPacketOptions, StartPacketResult };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const packetId = args[0];

  if (packetId == null || packetId === '' || packetId.startsWith('--')) {
    console.error('Usage: npx tsx tools/start.ts <packet-id>');
    process.exit(1);
  }

  try {
    const result = startPacket({ packetId });

    if (result.already_started) {
      console.log(`Packet already started: ${packetId}`);
      console.log(`  started_at: ${result.started_at}`);
      process.exit(0);
    }

    console.log(`${fmt.sym.ok} ${fmt.success('Packet started:')} ${fmt.bold(result.packet_id)}`);
    console.log(`  started_at: ${fmt.muted(result.started_at)}`);
    console.log(`  status: ${fmt.info(result.status)}`);
  } catch (e) {
    if (e instanceof StartPacketError) {
      console.error(`ERROR: ${e.message}`);
      for (const detail of e.details) {
        console.error(`  ${detail}`);
      }
    } else {
      console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  }
}

const isDirectExecution =
  process.argv[1]?.endsWith('start.ts') || process.argv[1]?.endsWith('start.js');
if (isDirectExecution) {
  main();
}
