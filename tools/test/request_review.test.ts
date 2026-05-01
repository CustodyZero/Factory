/**
 * Tests for the request-review lifecycle script.
 *
 * Pins the idempotency contract from Phase 2 of the single-entry-pipeline
 * spec: re-invoking on a packet already in 'review_requested' status must
 * not modify the packet file and must signal "already requested" cleanly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { requestReview } from '../request-review.js';
import type { FactoryConfig } from '../config.js';

interface Fixture {
  readonly root: string;
  readonly packetPath: string;
  readonly config: FactoryConfig;
}

function makeFixture(packet: Record<string, unknown>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'request-review-'));
  // Minimal factory layout
  mkdirSync(join(root, 'packets'), { recursive: true });
  mkdirSync(join(root, 'completions'), { recursive: true });
  const config: FactoryConfig = {
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
  // We avoid writing factory.config.json at root since callers pass config explicitly.
  const packetPath = join(root, 'packets', `${packet['id']}.json`);
  writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');
  return { root, packetPath, config };
}

let fixture: Fixture | null = null;

afterEach(() => {
  if (fixture !== null) {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = null;
  }
});

describe('requestReview — idempotency on review_requested', () => {
  beforeEach(() => {
    fixture = makeFixture({
      id: 'pkt-already-rr',
      kind: 'dev',
      title: 'already requested',
      status: 'review_requested',
      branch: 'feature/foo',
      review_iteration: 2,
      started_at: '2024-01-01T00:00:00Z',
    });
  });

  it('returns already_requested without modifying the packet file', () => {
    const f = fixture!;
    const before = readFileSync(f.packetPath, 'utf-8');
    const mtimeBefore = statSync(f.packetPath).mtimeMs;
    // Brief spin so a stray write would produce a distinct mtime.
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin */ }

    const outcome = requestReview({
      packetId: 'pkt-already-rr',
      projectRoot: f.root,
      config: f.config,
    });

    expect(outcome.kind).toBe('already_requested');
    // Pin the dual-form contract: the kind discriminator and the
    // already_requested boolean alias must agree on the same outcome.
    expect(outcome.already_requested).toBe(true);
    if (outcome.kind === 'already_requested') {
      expect(outcome.packet_id).toBe('pkt-already-rr');
      expect(outcome.branch).toBe('feature/foo');
      expect(outcome.review_iteration).toBe(2);
    }

    // File unchanged: mtime AND content.
    expect(statSync(f.packetPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(f.packetPath, 'utf-8')).toBe(before);
  });
});

describe('requestReview — happy path still works', () => {
  beforeEach(() => {
    fixture = makeFixture({
      id: 'pkt-happy',
      kind: 'dev',
      title: 'normal request',
      status: 'implementing',
      started_at: '2024-01-01T00:00:00Z',
    });
  });

  it('records review_requested and writes the packet', () => {
    const f = fixture!;
    const outcome = requestReview({
      packetId: 'pkt-happy',
      branchOverride: 'feature/happy',
      projectRoot: f.root,
      config: f.config,
    });

    expect(outcome.kind).toBe('recorded');
    // Happy path: the alias must report false to match the kind.
    expect(outcome.already_requested).toBe(false);
    if (outcome.kind === 'recorded') {
      expect(outcome.branch).toBe('feature/happy');
      expect(outcome.was_changes_requested).toBe(false);
    }

    const after = JSON.parse(readFileSync(f.packetPath, 'utf-8')) as Record<string, unknown>;
    expect(after['status']).toBe('review_requested');
    expect(after['branch']).toBe('feature/happy');
  });
});
