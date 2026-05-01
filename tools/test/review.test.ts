/**
 * Tests for the review lifecycle script.
 *
 * Pins the decision-aware idempotency contract from Phase 2 of the
 * single-entry-pipeline spec:
 *   - --approve on already-approved → no-op success
 *   - --request-changes on already-changes_requested → no-op success
 *   - mismatched re-decision → error (must re-open via request-review.ts)
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
import { recordReview } from '../review.js';
import type { FactoryConfig } from '../config.js';

interface Fixture {
  readonly root: string;
  readonly packetPath: string;
  readonly config: FactoryConfig;
}

function makeConfig(): FactoryConfig {
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
  };
}

function makeFixture(packet: Record<string, unknown>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'review-'));
  mkdirSync(join(root, 'packets'), { recursive: true });
  mkdirSync(join(root, 'completions'), { recursive: true });
  const packetPath = join(root, 'packets', `${packet['id']}.json`);
  writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');
  return { root, packetPath, config: makeConfig() };
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

describe('recordReview — idempotent on matching decision', () => {
  it('--approve on already-review_approved is a no-op success', () => {
    const f = makeFixture({
      id: 'pkt-already-approved',
      kind: 'dev',
      title: 'already approved',
      status: 'review_approved',
      review_iteration: 1,
      started_at: '2024-01-01T00:00:00Z',
    });
    fixtures.push(f);

    const before = readFileSync(f.packetPath, 'utf-8');
    const mtimeBefore = statSync(f.packetPath).mtimeMs;
    spinFor(20);

    const outcome = recordReview({
      packetId: 'pkt-already-approved',
      decision: 'approve',
      projectRoot: f.root,
      config: f.config,
    });

    expect(outcome.kind).toBe('already_recorded');
    if (outcome.kind === 'already_recorded') {
      expect(outcome.status).toBe('review_approved');
      expect(outcome.review_iteration).toBe(1);
    }
    expect(statSync(f.packetPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(f.packetPath, 'utf-8')).toBe(before);
  });

  it('--request-changes on already-changes_requested is a no-op success', () => {
    const f = makeFixture({
      id: 'pkt-already-cr',
      kind: 'dev',
      title: 'already changes requested',
      status: 'changes_requested',
      review_iteration: 0,
      started_at: '2024-01-01T00:00:00Z',
    });
    fixtures.push(f);

    const before = readFileSync(f.packetPath, 'utf-8');
    const mtimeBefore = statSync(f.packetPath).mtimeMs;
    spinFor(20);

    const outcome = recordReview({
      packetId: 'pkt-already-cr',
      decision: 'request_changes',
      projectRoot: f.root,
      config: f.config,
    });

    expect(outcome.kind).toBe('already_recorded');
    if (outcome.kind === 'already_recorded') {
      expect(outcome.status).toBe('changes_requested');
    }
    expect(statSync(f.packetPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(f.packetPath, 'utf-8')).toBe(before);
  });
});

describe('recordReview — mismatched re-decision is an error', () => {
  it('--approve on changes_requested throws and does not modify the packet', () => {
    const f = makeFixture({
      id: 'pkt-cr-then-approve',
      kind: 'dev',
      title: 'mismatch',
      status: 'changes_requested',
      review_iteration: 0,
      started_at: '2024-01-01T00:00:00Z',
    });
    fixtures.push(f);
    const before = readFileSync(f.packetPath, 'utf-8');

    expect(() =>
      recordReview({
        packetId: 'pkt-cr-then-approve',
        decision: 'approve',
        projectRoot: f.root,
        config: f.config,
      }),
    ).toThrow(/already has decision 'changes_requested'/);

    // File unchanged.
    expect(readFileSync(f.packetPath, 'utf-8')).toBe(before);
  });

  it('--request-changes on review_approved throws and does not modify the packet', () => {
    const f = makeFixture({
      id: 'pkt-approve-then-cr',
      kind: 'dev',
      title: 'mismatch reverse',
      status: 'review_approved',
      review_iteration: 0,
      started_at: '2024-01-01T00:00:00Z',
    });
    fixtures.push(f);
    const before = readFileSync(f.packetPath, 'utf-8');

    expect(() =>
      recordReview({
        packetId: 'pkt-approve-then-cr',
        decision: 'request_changes',
        projectRoot: f.root,
        config: f.config,
      }),
    ).toThrow(/already has decision 'review_approved'/);

    expect(readFileSync(f.packetPath, 'utf-8')).toBe(before);
  });
});

describe('recordReview — happy path still works', () => {
  it('--approve on review_requested writes the new status', () => {
    const f = makeFixture({
      id: 'pkt-happy-approve',
      kind: 'dev',
      title: 'happy',
      status: 'review_requested',
      review_iteration: 1,
      started_at: '2024-01-01T00:00:00Z',
    });
    fixtures.push(f);

    const outcome = recordReview({
      packetId: 'pkt-happy-approve',
      decision: 'approve',
      projectRoot: f.root,
      config: f.config,
    });

    expect(outcome.kind).toBe('recorded');
    if (outcome.kind === 'recorded') {
      expect(outcome.status).toBe('review_approved');
    }

    const after = JSON.parse(readFileSync(f.packetPath, 'utf-8')) as Record<string, unknown>;
    expect(after['status']).toBe('review_approved');
  });
});
