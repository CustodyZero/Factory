/**
 * Phase 5.5 — lifecycle event emission tests.
 *
 * The four lifecycle library functions (startPacket, requestReview,
 * recordReview, completePacket) emit packet.* / verification.* events
 * when FACTORY_RUN_ID is set in the environment. They must:
 *
 *   1. Emit the right event type on the success path.
 *   2. Be a no-op (no events file created) when FACTORY_RUN_ID is unset.
 *   3. Always carry provenance: 'test' under vitest.
 *
 * These tests exercise the lifecycle functions directly (not through
 * the orchestrator) so the env-var-based emission path is pinned in
 * isolation. The orchestrator's separate integration tests cover the
 * full pipeline-events sequence.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPacket } from '../lifecycle/start.js';
import { requestReview } from '../lifecycle/request_review.js';
import { recordReview } from '../lifecycle/review.js';
import { completePacket } from '../lifecycle/complete.js';
import { readEvents } from '../events.js';
import type { FactoryConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let dirs: string[] = [];
const RUN_ID = 'lc-test-run-xyz';
let savedRunId: string | undefined;

beforeEach(() => {
  savedRunId = process.env['FACTORY_RUN_ID'];
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  if (savedRunId === undefined) {
    delete process.env['FACTORY_RUN_ID'];
  } else {
    process.env['FACTORY_RUN_ID'] = savedRunId;
  }
});

function baseConfig(): FactoryConfig {
  return ({
    project_name: 'lc-events',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: '', instructions: [] },
      developer: { description: '', instructions: [] },
      code_reviewer: { description: '', instructions: [] },
      qa: { description: '', instructions: [] },
    },
  } as unknown) as FactoryConfig;
}

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-evt-'));
  dirs.push(root);
  mkdirSync(join(root, 'packets'), { recursive: true });
  mkdirSync(join(root, 'completions'), { recursive: true });
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(baseConfig(), null, 2),
    'utf-8',
  );
  return root;
}

function writePacket(root: string, packet: Record<string, unknown>): void {
  const id = String(packet['id']);
  writeFileSync(
    join(root, 'packets', `${id}.json`),
    JSON.stringify(packet, null, 2),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// startPacket — packet.started
// ---------------------------------------------------------------------------

describe('startPacket events', () => {
  it('emits packet.started when FACTORY_RUN_ID is set', () => {
    const root = mkRoot();
    process.env['FACTORY_RUN_ID'] = RUN_ID;
    writePacket(root, { id: 'p1', kind: 'dev', title: 't', status: 'ready', dependencies: [] });
    startPacket({ packetId: 'p1', projectRoot: root });
    const events = readEvents(RUN_ID, root);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('packet.started');
    expect(events[0]!.provenance).toBe('test');
    if (events[0]!.payload.event_type === 'packet.started') {
      expect(events[0]!.payload.packet_id).toBe('p1');
    }
  });

  it('is a no-op when FACTORY_RUN_ID is unset (no events file)', () => {
    const root = mkRoot();
    delete process.env['FACTORY_RUN_ID'];
    writePacket(root, { id: 'p1', kind: 'dev', title: 't', status: 'ready', dependencies: [] });
    startPacket({ packetId: 'p1', projectRoot: root });
    expect(existsSync(join(root, 'events'))).toBe(false);
  });

  it('does NOT emit when the packet was already started (idempotent path)', () => {
    const root = mkRoot();
    process.env['FACTORY_RUN_ID'] = RUN_ID;
    // started_at populated -> idempotent return without writing
    writePacket(root, {
      id: 'p1', kind: 'dev', title: 't', status: 'implementing',
      dependencies: [], started_at: '2026-01-01T00:00:00.000Z',
    });
    startPacket({ packetId: 'p1', projectRoot: root });
    // events file may not exist at all (idempotent path returns early)
    expect(readEvents(RUN_ID, root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// requestReview — packet.review_requested
// ---------------------------------------------------------------------------

describe('requestReview events', () => {
  it('emits packet.review_requested with the iteration number', () => {
    const root = mkRoot();
    process.env['FACTORY_RUN_ID'] = RUN_ID;
    writePacket(root, {
      id: 'p1', kind: 'dev', title: 't', status: 'implementing',
      dependencies: [], started_at: '2026-01-01T00:00:00.000Z',
      review_iteration: 0,
    });
    requestReview({ packetId: 'p1', projectRoot: root, branchOverride: 'feature/test' });
    const events = readEvents(RUN_ID, root);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('packet.review_requested');
    if (events[0]!.payload.event_type === 'packet.review_requested') {
      expect(events[0]!.payload.packet_id).toBe('p1');
      expect(events[0]!.payload.review_iteration).toBe(0);
    }
  });

  it('does NOT emit on the already-requested idempotent path', () => {
    const root = mkRoot();
    process.env['FACTORY_RUN_ID'] = RUN_ID;
    writePacket(root, {
      id: 'p1', kind: 'dev', title: 't', status: 'review_requested',
      dependencies: [], started_at: '2026-01-01T00:00:00.000Z',
      review_iteration: 1, branch: 'feat/x',
    });
    requestReview({ packetId: 'p1', projectRoot: root });
    expect(readEvents(RUN_ID, root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// recordReview — packet.review_approved / packet.changes_requested
// ---------------------------------------------------------------------------

describe('recordReview events', () => {
  it('emits packet.review_approved on --approve', () => {
    const root = mkRoot();
    process.env['FACTORY_RUN_ID'] = RUN_ID;
    writePacket(root, {
      id: 'p1', kind: 'dev', title: 't', status: 'review_requested',
      dependencies: [], started_at: '2026-01-01T00:00:00.000Z',
      review_iteration: 1, branch: 'feat/x',
    });
    recordReview({ packetId: 'p1', decision: 'approve', projectRoot: root });
    const events = readEvents(RUN_ID, root);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('packet.review_approved');
  });

  it('emits packet.changes_requested on --request-changes', () => {
    const root = mkRoot();
    process.env['FACTORY_RUN_ID'] = RUN_ID;
    writePacket(root, {
      id: 'p1', kind: 'dev', title: 't', status: 'review_requested',
      dependencies: [], started_at: '2026-01-01T00:00:00.000Z',
      review_iteration: 1, branch: 'feat/x',
    });
    recordReview({ packetId: 'p1', decision: 'request_changes', projectRoot: root });
    const events = readEvents(RUN_ID, root);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('packet.changes_requested');
  });
});

// ---------------------------------------------------------------------------
// completePacket — verification.* + packet.completed/failed
// ---------------------------------------------------------------------------

describe('completePacket events', () => {
  it('emits verification.passed + packet.completed when all checks pass', () => {
    const root = mkRoot();
    process.env['FACTORY_RUN_ID'] = RUN_ID;
    writePacket(root, {
      id: 'p1', kind: 'dev', title: 't', status: 'review_approved',
      dependencies: [], started_at: '2026-01-01T00:00:00.000Z',
    });
    completePacket({ packetId: 'p1', projectRoot: root });
    const events = readEvents(RUN_ID, root);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('verification.passed');
    expect(types).toContain('packet.completed');
    expect(types).not.toContain('verification.failed');
    expect(types).not.toContain('packet.failed');
  });

  it('emits verification.failed + packet.failed when verification fails', () => {
    const root = mkRoot();
    process.env['FACTORY_RUN_ID'] = RUN_ID;
    // Override config: build command exits non-zero so ciPass=false.
    const cfg: FactoryConfig = ({
      ...baseConfig(),
      verification: { build: 'false', lint: 'true', test: 'true' },
    } as unknown) as FactoryConfig;
    writeFileSync(
      join(root, 'factory.config.json'),
      JSON.stringify(cfg, null, 2),
      'utf-8',
    );
    writePacket(root, {
      id: 'p1', kind: 'dev', title: 't', status: 'review_approved',
      dependencies: [], started_at: '2026-01-01T00:00:00.000Z',
    });
    completePacket({ packetId: 'p1', projectRoot: root });
    const events = readEvents(RUN_ID, root);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('verification.failed');
    expect(types).toContain('packet.failed');
    expect(types).not.toContain('verification.passed');
    expect(types).not.toContain('packet.completed');
    // Failed checks must enumerate which verifications failed.
    const failed = events.find((e) => e.event_type === 'verification.failed');
    if (failed && failed.payload.event_type === 'verification.failed') {
      expect(failed.payload.failed_checks).toContain('build');
      expect(failed.payload.failed_checks).not.toContain('lint');
    }
  });

  it('does NOT emit on the idempotent already-complete path', () => {
    const root = mkRoot();
    process.env['FACTORY_RUN_ID'] = RUN_ID;
    writePacket(root, {
      id: 'p1', kind: 'dev', title: 't', status: 'completed',
      dependencies: [], started_at: '2026-01-01T00:00:00.000Z',
    });
    // Pre-write the completion file so completePacket short-circuits.
    writeFileSync(
      join(root, 'completions', 'p1.json'),
      JSON.stringify({
        packet_id: 'p1',
        completed_at: '2026-01-01T00:00:00.000Z',
        completed_by: { kind: 'agent', id: 'test' },
        summary: 'pre-existing',
        files_changed: [],
        verification: { tests_pass: true, build_pass: true, lint_pass: true, ci_pass: true, notes: '' },
      }, null, 2),
      'utf-8',
    );
    completePacket({ packetId: 'p1', projectRoot: root });
    expect(readEvents(RUN_ID, root)).toEqual([]);
  });

  it('is a no-op when FACTORY_RUN_ID is unset', () => {
    const root = mkRoot();
    delete process.env['FACTORY_RUN_ID'];
    writePacket(root, {
      id: 'p1', kind: 'dev', title: 't', status: 'review_approved',
      dependencies: [], started_at: '2026-01-01T00:00:00.000Z',
    });
    completePacket({ packetId: 'p1', projectRoot: root });
    expect(existsSync(join(root, 'events'))).toBe(false);
  });
});
