/**
 * Tests for the dev-phase state machine extracted from tools/run.ts.
 *
 * These pin the decision logic that decides where to resume a
 * partially-completed dev packet, and how to advance after each
 * imperative step in the loop. The decisions are pure: given the
 * input state, the output resume point is deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveDevResumePoint,
  nextPointAfterImplement,
  nextPointAfterReview,
  nextPointAfterRework,
  nextPointAfterFinalize,
  runDevelopPhase,
} from '../pipeline/develop_phase.js';
import type { DevResumePoint } from '../pipeline/develop_phase.js';
import type { Feature, RawPacket } from '../execute.js';
import type { FactoryConfig } from '../config.js';

function makePacket(overrides: Partial<RawPacket> = {}): RawPacket {
  return {
    id: overrides.id ?? 'pkt-1',
    kind: overrides.kind ?? 'dev',
    title: overrides.title ?? 'Test packet',
    ...overrides,
  } as RawPacket;
}

// ---------------------------------------------------------------------------
// deriveDevResumePoint
// ---------------------------------------------------------------------------

describe('deriveDevResumePoint', () => {
  it('returns "completed" when a completion record exists, regardless of status', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'implementing' }), true)).toBe('completed');
    expect(deriveDevResumePoint(makePacket({ status: 'review_requested' }), true)).toBe('completed');
    expect(deriveDevResumePoint(makePacket({ status: null }), true)).toBe('completed');
  });

  it('returns "implement" for null/undefined status (no completion)', () => {
    expect(deriveDevResumePoint(makePacket({ status: null }), false)).toBe('implement');
    expect(deriveDevResumePoint(makePacket({}), false)).toBe('implement');
  });

  it('returns "implement" for "draft" / "ready" / "implementing" statuses', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'draft' }), false)).toBe('implement');
    expect(deriveDevResumePoint(makePacket({ status: 'ready' }), false)).toBe('implement');
    expect(deriveDevResumePoint(makePacket({ status: 'implementing' }), false)).toBe('implement');
  });

  it('returns "review" for status "review_requested"', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'review_requested' }), false)).toBe('review');
  });

  it('returns "rework" for status "changes_requested"', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'changes_requested' }), false)).toBe('rework');
  });

  it('returns "finalize" for status "review_approved"', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'review_approved' }), false)).toBe('finalize');
  });

  it('falls back to "implement" for unknown status strings', () => {
    expect(deriveDevResumePoint(makePacket({ status: 'mystery_status' }), false)).toBe('implement');
  });
});

// ---------------------------------------------------------------------------
// nextPointAfterImplement
// ---------------------------------------------------------------------------

describe('nextPointAfterImplement', () => {
  it('returns "request_review" on success', () => {
    expect(nextPointAfterImplement(true)).toBe('request_review');
  });

  it('returns null on failure (signals loop to stop)', () => {
    expect(nextPointAfterImplement(false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextPointAfterReview
// ---------------------------------------------------------------------------

describe('nextPointAfterReview', () => {
  it('returns null when the reviewer agent failed (regardless of status)', () => {
    expect(nextPointAfterReview(false, 'review_approved')).toBeNull();
    expect(nextPointAfterReview(false, 'changes_requested')).toBeNull();
    expect(nextPointAfterReview(false, null)).toBeNull();
  });

  it('returns "finalize" when reviewer succeeded and packet was approved', () => {
    expect(nextPointAfterReview(true, 'review_approved')).toBe('finalize');
  });

  it('returns "rework" when reviewer succeeded and packet had changes requested', () => {
    expect(nextPointAfterReview(true, 'changes_requested')).toBe('rework');
  });

  it('returns "finalize" when reviewer succeeded but did not transition status (force-approve case)', () => {
    // Original loop: when status didn't transition, the imperative
    // path force-approves on disk and falls through to finalize.
    // The pure decision says: target finalize.
    expect(nextPointAfterReview(true, null)).toBe('finalize');
    expect(nextPointAfterReview(true, 'implementing')).toBe('finalize');
    expect(nextPointAfterReview(true, 'review_requested')).toBe('finalize');
  });
});

// ---------------------------------------------------------------------------
// nextPointAfterRework
// ---------------------------------------------------------------------------

describe('nextPointAfterRework', () => {
  it('returns "request_review" on success — re-enter the review loop', () => {
    expect(nextPointAfterRework(true)).toBe('request_review');
  });

  it('returns null on failure', () => {
    expect(nextPointAfterRework(false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nextPointAfterFinalize
// ---------------------------------------------------------------------------

describe('nextPointAfterFinalize', () => {
  it('returns "completed" on success', () => {
    const out: DevResumePoint | null = nextPointAfterFinalize(true);
    expect(out).toBe('completed');
  });

  it('returns null on failure', () => {
    expect(nextPointAfterFinalize(false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runDevelopPhase — imperative loop (Phase 4.5 extraction)
//
// The full state-machine path requires invoking real provider CLIs, which
// the broader integration tests already exercise end-to-end. Here we pin
// only the deterministic branches that don't shell out:
//
//   - Structural: the function is exported and produces the documented
//     result shape.
//   - Empty-feature: no dev packets to process produces empty arrays.
//   - Already-complete short-circuit: a packet whose completion record
//     exists at phase start is reported as completed without invoking
//     the developer agent.
//   - Dry-run: per-packet dry-run logging without invoking any agent
//     and without mutating disk state.
//   - Blocked-by-deps: a packet whose dependency hasn't completed is
//     reported as failed (without invoking the agent).
// ---------------------------------------------------------------------------

function makeMinimalConfig(): FactoryConfig {
  return {
    project_name: 'test',
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
  } as FactoryConfig;
}

function makeFeature(packetIds: string[]): Feature {
  return {
    id: 'feat-test',
    intent: 'test',
    status: 'executing',
    packets: packetIds,
    created_by: { kind: 'agent', id: 'test' },
  } as Feature;
}

function setupArtifactRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'develop-phase-'));
  mkdirSync(join(root, 'packets'));
  mkdirSync(join(root, 'completions'));
  mkdirSync(join(root, 'features'));
  return root;
}

describe('runDevelopPhase — structural shape', () => {
  it('exports a callable named runDevelopPhase', () => {
    expect(typeof runDevelopPhase).toBe('function');
  });

  it('returns the documented { completed, failed } shape with empty arrays for an empty feature', () => {
    const root = setupArtifactRoot();
    try {
      const result = runDevelopPhase({
        feature: makeFeature([]),
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: false,
      });
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runDevelopPhase — already-complete short-circuit', () => {
  it('reports a pre-completed packet without invoking the developer agent', () => {
    const root = setupArtifactRoot();
    try {
      writeFileSync(
        join(root, 'packets', 'pkt-done.json'),
        JSON.stringify({
          id: 'pkt-done',
          kind: 'dev',
          title: 'A dev packet',
          status: 'review_approved',
        }, null, 2),
        'utf-8',
      );
      writeFileSync(
        join(root, 'completions', 'pkt-done.json'),
        JSON.stringify({ packet_id: 'pkt-done' }, null, 2),
        'utf-8',
      );

      const result = runDevelopPhase({
        feature: makeFeature(['pkt-done']),
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: false, // no agent invoked because completion exists
      });

      expect(result.completed).toEqual(['pkt-done']);
      expect(result.failed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runDevelopPhase — dry-run', () => {
  it('does not invoke any agent or mutate packet status in dry-run mode', () => {
    const root = setupArtifactRoot();
    try {
      const packetPath = join(root, 'packets', 'pkt-dry.json');
      const initial = JSON.stringify({
        id: 'pkt-dry',
        kind: 'dev',
        title: 'Dry-run packet',
        status: 'ready',
      }, null, 2) + '\n';
      writeFileSync(packetPath, initial, 'utf-8');

      const result = runDevelopPhase({
        feature: makeFeature(['pkt-dry']),
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: true,
      });

      // Dry-run reports neither completed nor failed for a fresh packet
      // that would normally be implemented — the `continue` branch is
      // taken before either array is appended to.
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([]);

      // Disk state unchanged: no completion file created, packet
      // contents identical, no status mutation.
      expect(existsSync(join(root, 'completions', 'pkt-dry.json'))).toBe(false);
      expect(readFileSync(packetPath, 'utf-8')).toBe(initial);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runDevelopPhase — blocked dependency', () => {
  it('reports a packet whose dependency is unmet as failed without invoking the agent', () => {
    const root = setupArtifactRoot();
    try {
      // pkt-blocked depends on pkt-prereq which is NOT in completions.
      writeFileSync(
        join(root, 'packets', 'pkt-blocked.json'),
        JSON.stringify({
          id: 'pkt-blocked',
          kind: 'dev',
          title: 'Blocked packet',
          status: 'ready',
          dependencies: ['pkt-prereq'],
        }, null, 2),
        'utf-8',
      );

      const result = runDevelopPhase({
        feature: makeFeature(['pkt-blocked']),
        config: makeMinimalConfig(),
        artifactRoot: root,
        projectRoot: root,
        dryRun: false,
      });

      expect(result.failed).toEqual(['pkt-blocked']);
      expect(result.completed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
