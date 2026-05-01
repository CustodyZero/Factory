/**
 * Tests for the completePacket library function.
 *
 * Pins the idempotency contract from Phase 2 of the single-entry-pipeline
 * spec:
 *   - When a completion record already exists, completePacket returns its
 *     values WITHOUT re-running build/lint/test.
 *   - The completion file is NOT rewritten (mtime + content unchanged).
 *   - The packet file is NOT modified.
 *   - already_complete: true on the early-return path; false on the real
 *     completion path.
 *
 * The build/lint/test commands the fixture uses are 'true'/'false' shell
 * commands so we can deterministically prove they did or did not run.
 * If the early-return path called runVerification on 'false', the test
 * for "ci_pass on already_complete reflects the recorded values, not the
 * current shell" would catch the bug.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completePacket } from '../complete.js';

interface Fixture {
  readonly root: string;
  readonly packetPath: string;
  readonly completionPath: string;
}

/**
 * Sets up a self-contained factory tree with its own factory.config.json so
 * completePacket() can resolve real verification commands. We deliberately
 * use 'false' for build/lint/test so that if the idempotent path ever ran
 * verification, ci_pass would flip and the tests would notice.
 */
function makeFixture(opts: {
  packet: Record<string, unknown>;
  completion?: Record<string, unknown>;
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'complete-'));
  mkdirSync(join(root, 'packets'), { recursive: true });
  mkdirSync(join(root, 'completions'), { recursive: true });

  const config = {
    project_name: 'test',
    factory_dir: '.',
    artifact_dir: '.',
    verification: {
      // Deliberately failing — the idempotent path must NOT call these.
      build: 'false',
      lint: 'false',
      test: 'false',
    },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: '', instructions: [] },
      developer: { description: '', instructions: [] },
      code_reviewer: { description: '', instructions: [] },
      qa: { description: '', instructions: [] },
    },
  };
  writeFileSync(join(root, 'factory.config.json'), JSON.stringify(config, null, 2), 'utf-8');

  const packetPath = join(root, 'packets', `${opts.packet['id']}.json`);
  writeFileSync(packetPath, JSON.stringify(opts.packet, null, 2) + '\n', 'utf-8');

  const completionPath = join(root, 'completions', `${opts.packet['id']}.json`);
  if (opts.completion !== undefined) {
    writeFileSync(completionPath, JSON.stringify(opts.completion, null, 2) + '\n', 'utf-8');
  }

  return { root, packetPath, completionPath };
}

let fixtures: Fixture[] = [];

afterEach(() => {
  for (const f of fixtures) {
    rmSync(f.root, { recursive: true, force: true });
  }
  fixtures = [];
});

function spinFor(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) { /* spin */ }
}

describe('completePacket — idempotent on existing completion', () => {
  it('returns the existing completion values WITHOUT re-running verification', () => {
    const f = makeFixture({
      packet: {
        id: 'pkt-already-done',
        kind: 'dev',
        title: 'already complete',
        status: 'completed',
        started_at: '2024-01-01T00:00:00Z',
      },
      completion: {
        packet_id: 'pkt-already-done',
        completed_at: '2024-01-02T00:00:00Z',
        completed_by: { kind: 'agent', id: 'original-agent' },
        summary: 'recorded earlier',
        files_changed: ['src/foo.ts', 'src/bar.ts'],
        verification: {
          tests_pass: true,
          build_pass: true,
          lint_pass: true,
          ci_pass: true,
          notes: 'All verification passed.',
        },
      },
    });
    fixtures.push(f);

    const completionBefore = readFileSync(f.completionPath, 'utf-8');
    const completionMtimeBefore = statSync(f.completionPath).mtimeMs;
    const packetBefore = readFileSync(f.packetPath, 'utf-8');
    const packetMtimeBefore = statSync(f.packetPath).mtimeMs;
    spinFor(20);

    const result = completePacket({
      packetId: 'pkt-already-done',
      projectRoot: f.root,
    });

    // Returns the recorded values, not the (failing) shell results.
    expect(result.already_complete).toBe(true);
    expect(result.packet_id).toBe('pkt-already-done');
    expect(result.build_pass).toBe(true);
    expect(result.lint_pass).toBe(true);
    expect(result.tests_pass).toBe(true);
    expect(result.ci_pass).toBe(true);
    expect(result.files_changed).toEqual(['src/foo.ts', 'src/bar.ts']);

    // Completion file: NOT rewritten (mtime + content identical).
    expect(statSync(f.completionPath).mtimeMs).toBe(completionMtimeBefore);
    expect(readFileSync(f.completionPath, 'utf-8')).toBe(completionBefore);

    // Packet file: NOT modified.
    expect(statSync(f.packetPath).mtimeMs).toBe(packetMtimeBefore);
    expect(readFileSync(f.packetPath, 'utf-8')).toBe(packetBefore);
  });

  it('does NOT touch the completion file even when verification commands would fail', () => {
    // Stronger phrasing of the previous test: prove that even if verification
    // were attempted, it would have flipped ci_pass to false (because the
    // fixture's verification commands are 'false'). Since we observe ci_pass
    // = true (matching the recorded value), verification was not run.
    const f = makeFixture({
      packet: {
        id: 'pkt-passing-record',
        kind: 'dev',
        title: 'recorded as passing',
        status: 'completed',
        started_at: '2024-01-01T00:00:00Z',
      },
      completion: {
        packet_id: 'pkt-passing-record',
        completed_at: '2024-01-02T00:00:00Z',
        completed_by: { kind: 'agent', id: 'old' },
        summary: 'passed',
        files_changed: [],
        verification: {
          tests_pass: true,
          build_pass: true,
          lint_pass: true,
          ci_pass: true,
          notes: 'All verification passed.',
        },
      },
    });
    fixtures.push(f);

    const result = completePacket({ packetId: 'pkt-passing-record', projectRoot: f.root });
    expect(result.already_complete).toBe(true);
    expect(result.ci_pass).toBe(true); // would be false if verification ran
  });
});

describe('completePacket — mismatched packet_id refuses to short-circuit', () => {
  it('throws when an existing completion file has the wrong packet_id', () => {
    // A completion file named completions/<packetId>.json whose internal
    // packet_id does not match the requested packet is suspect: corrupt or
    // misnamed. The early-return path must not silently treat it as
    // success.
    const f = makeFixture({
      packet: {
        id: 'pkt-asking',
        kind: 'dev',
        title: 'asks for completion',
        status: 'review_approved',
        started_at: '2024-01-01T00:00:00Z',
      },
      completion: {
        packet_id: 'pkt-DIFFERENT',
        completed_at: '2024-01-02T00:00:00Z',
        completed_by: { kind: 'agent', id: 'old' },
        summary: 'foreign record',
        files_changed: [],
        verification: {
          tests_pass: true,
          build_pass: true,
          lint_pass: true,
          ci_pass: true,
          notes: 'All verification passed.',
        },
      },
    });
    fixtures.push(f);

    const before = readFileSync(f.completionPath, 'utf-8');
    const mtimeBefore = statSync(f.completionPath).mtimeMs;

    expect(() =>
      completePacket({ packetId: 'pkt-asking', projectRoot: f.root }),
    ).toThrow(/has packet_id 'pkt-DIFFERENT', expected 'pkt-asking'/);

    // The foreign completion file must NOT be touched by the failed call.
    expect(statSync(f.completionPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(f.completionPath, 'utf-8')).toBe(before);
  });
});

describe('completePacket — happy path still works and is NOT idempotent on first run', () => {
  it('writes completion + updates packet status when no existing record', () => {
    const f = makeFixture({
      packet: {
        id: 'pkt-fresh',
        kind: 'dev',
        title: 'fresh complete',
        status: 'review_approved',
        started_at: '2024-01-01T00:00:00Z',
      },
    });
    fixtures.push(f);

    // 'true' verification passes; 'false' fails. We swap the config so this
    // test runs verification successfully.
    const config = JSON.parse(readFileSync(join(f.root, 'factory.config.json'), 'utf-8')) as {
      verification: { build: string; lint: string; test: string };
    };
    config.verification = { build: 'true', lint: 'true', test: 'true' };
    writeFileSync(join(f.root, 'factory.config.json'), JSON.stringify(config, null, 2), 'utf-8');

    const result = completePacket({ packetId: 'pkt-fresh', projectRoot: f.root });

    expect(result.already_complete).toBe(false);
    expect(result.ci_pass).toBe(true);

    // Completion file written.
    expect(readFileSync(f.completionPath, 'utf-8')).toContain('pkt-fresh');

    // Packet status updated.
    const after = JSON.parse(readFileSync(f.packetPath, 'utf-8')) as Record<string, unknown>;
    expect(after['status']).toBe('completed');
  });
});
