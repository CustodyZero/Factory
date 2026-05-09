/**
 * Phase 6 — Tests for the lifecycle stale-branch opt-in.
 *
 * Pins:
 *   - completePacket without `checkStaleBranch` does NOT call git
 *     (preserves CLI/legacy behavior)
 *   - completePacket with `checkStaleBranch: true` and a stale
 *     branch THROWS an Error whose message matches the classifier
 *     STALE_BRANCH_PATTERNS
 *   - requestReview with `checkStaleBranch: true` throws a
 *     RequestReviewError with matching message
 *   - When the helper returns null (offline / no remote), neither
 *     call throws
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { completePacket } from '../lifecycle/complete.ts';
import { requestReview, RequestReviewError } from '../lifecycle/request_review.ts';
import { STALE_BRANCH_PATTERNS } from '../pipeline/recovery.js';
import type { GitCheckRunner } from '../lifecycle/git_check.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-stale-'));
  for (const d of ['packets', 'completions']) {
    if (!existsSync(join(root, d))) mkdirSync(join(root, d), { recursive: true });
  }
  // Write a minimal factory.config.json so loadConfig succeeds.
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify({
      project_name: 'lifecycle-stale-test',
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
    }, null, 2),
    'utf-8',
  );
  dirs.push(root);
  return root;
}

function writeStartedPacket(root: string, id: string, kind: 'dev' | 'qa' = 'dev'): void {
  writeFileSync(
    join(root, 'packets', `${id}.json`),
    JSON.stringify({
      id,
      kind,
      title: `Packet ${id}`,
      status: 'review_approved',
      started_at: '2024-01-01T00:00:00Z',
    }, null, 2),
    'utf-8',
  );
}

function writeImplementingPacket(root: string, id: string): void {
  writeFileSync(
    join(root, 'packets', `${id}.json`),
    JSON.stringify({
      id,
      kind: 'dev',
      title: `Packet ${id}`,
      status: 'implementing',
      started_at: '2024-01-01T00:00:00Z',
      branch: 'feature/x',
    }, null, 2),
    'utf-8',
  );
}

function makeStaleRunner(behindCount: number): GitCheckRunner {
  return (args) => {
    if (args[0] === 'fetch') return { exitCode: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-list') {
      return { exitCode: 0, stdout: `${behindCount}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

function makeOfflineRunner(): GitCheckRunner {
  return () => ({ exitCode: 1, stdout: '', stderr: 'fatal: unable to access' });
}

// ---------------------------------------------------------------------------
// completePacket
// ---------------------------------------------------------------------------

describe('completePacket — checkStaleBranch off by default', () => {
  it('no checkStaleBranch flag: does NOT throw (legacy behavior preserved)', () => {
    const root = mkRoot();
    writeStartedPacket(root, 'pkt-a');
    // Even with a runner that would report stale, NOT passing the
    // flag skips the check entirely.
    expect(() => completePacket({
      packetId: 'pkt-a',
      identity: 'test',
      projectRoot: root,
      gitRunner: makeStaleRunner(5),
    })).not.toThrow();
  });
});

describe('completePacket — checkStaleBranch true with stale branch', () => {
  it('throws an Error whose message matches STALE_BRANCH_PATTERNS', () => {
    const root = mkRoot();
    writeStartedPacket(root, 'pkt-b');
    let caught: Error | null = null;
    try {
      completePacket({
        packetId: 'pkt-b',
        identity: 'test',
        projectRoot: root,
        checkStaleBranch: true,
        gitRunner: makeStaleRunner(3),
      });
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    const msg = caught!.message;
    expect(msg).toMatch(/branch is behind 'origin\/main'/i);
    // Must match the classifier patterns so recovery routes via 'git'.
    expect(STALE_BRANCH_PATTERNS.some((p) => p.test(msg))).toBe(true);
  });
});

describe('completePacket — checkStaleBranch true but offline (helper returns null)', () => {
  it('does NOT throw; proceeds with verification', () => {
    const root = mkRoot();
    writeStartedPacket(root, 'pkt-c');
    expect(() => completePacket({
      packetId: 'pkt-c',
      identity: 'test',
      projectRoot: root,
      checkStaleBranch: true,
      gitRunner: makeOfflineRunner(),
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// requestReview
// ---------------------------------------------------------------------------

describe('requestReview — checkStaleBranch off by default', () => {
  it('no checkStaleBranch flag: succeeds (legacy behavior preserved)', () => {
    const root = mkRoot();
    writeImplementingPacket(root, 'pkt-d');
    const r = requestReview({
      packetId: 'pkt-d',
      projectRoot: root,
      branchOverride: 'feature/x',
      gitRunner: makeStaleRunner(5),
    });
    // Idempotency / state transitions are unrelated to stale-branch
    // — a missing checkStaleBranch flag must skip the detection.
    expect(r.kind).toBe('recorded');
  });
});

describe('requestReview — checkStaleBranch true with stale branch', () => {
  it('throws a RequestReviewError whose message matches STALE_BRANCH_PATTERNS', () => {
    const root = mkRoot();
    writeImplementingPacket(root, 'pkt-e');
    let caught: Error | null = null;
    try {
      requestReview({
        packetId: 'pkt-e',
        projectRoot: root,
        branchOverride: 'feature/x',
        checkStaleBranch: true,
        gitRunner: makeStaleRunner(3),
      });
    } catch (e) {
      caught = e instanceof Error ? e : new Error(String(e));
    }
    expect(caught).not.toBeNull();
    expect(caught instanceof RequestReviewError).toBe(true);
    const msg = caught!.message;
    expect(msg).toMatch(/branch is behind 'origin\/main'/i);
    expect(STALE_BRANCH_PATTERNS.some((p) => p.test(msg))).toBe(true);
  });
});

describe('requestReview — checkStaleBranch true but offline', () => {
  it('does NOT throw; proceeds with the state transition', () => {
    const root = mkRoot();
    writeImplementingPacket(root, 'pkt-f');
    const r = requestReview({
      packetId: 'pkt-f',
      projectRoot: root,
      branchOverride: 'feature/x',
      checkStaleBranch: true,
      gitRunner: makeOfflineRunner(),
    });
    expect(r.kind).toBe('recorded');
  });
});
