/**
 * Tests for the start-packet lifecycle library function.
 *
 * Phase 3 of specs/single-entry-pipeline.md introduced startPacket() as a
 * typed library entry point. These tests pin the contract that run.ts
 * (and any future orchestrator) relies on:
 *
 *   - precondition errors throw StartPacketError
 *   - happy-path returns already_started: false and writes the packet
 *   - re-invoking on an already-started packet returns already_started:
 *     true WITHOUT modifying the packet file
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
import { startPacket, StartPacketError } from '../lifecycle/start.js';
import type { FactoryConfig } from '../config.js';

interface Fixture {
  readonly root: string;
  readonly packetPath: string;
  readonly completionPath: string;
  readonly config: FactoryConfig;
}

function baseConfig(): FactoryConfig {
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

function makeFixture(opts: {
  packet?: Record<string, unknown>;
  completion?: Record<string, unknown>;
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-start-'));
  mkdirSync(join(root, 'packets'), { recursive: true });
  mkdirSync(join(root, 'completions'), { recursive: true });
  const packetId = opts.packet ? String(opts.packet['id']) : 'dummy';
  const packetPath = join(root, 'packets', `${packetId}.json`);
  const completionPath = join(root, 'completions', `${packetId}.json`);
  if (opts.packet !== undefined) {
    writeFileSync(packetPath, JSON.stringify(opts.packet, null, 2) + '\n', 'utf-8');
  }
  if (opts.completion !== undefined) {
    writeFileSync(completionPath, JSON.stringify(opts.completion, null, 2) + '\n', 'utf-8');
  }
  return { root, packetPath, completionPath, config: baseConfig() };
}

let fixture: Fixture | null = null;
afterEach(() => {
  if (fixture !== null) {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = null;
  }
});

describe('startPacket — happy path', () => {
  it('records started_at, sets status to implementing, returns already_started: false', () => {
    fixture = makeFixture({
      packet: {
        id: 'pkt-fresh',
        kind: 'dev',
        title: 'fresh start',
        status: 'ready',
      },
    });
    const f = fixture;

    const result = startPacket({
      packetId: 'pkt-fresh',
      projectRoot: f.root,
      config: f.config,
    });

    expect(result.already_started).toBe(false);
    expect(result.packet_id).toBe('pkt-fresh');
    expect(result.status).toBe('implementing');
    expect(typeof result.started_at).toBe('string');
    expect(result.started_at.length).toBeGreaterThan(0);

    const after = JSON.parse(readFileSync(f.packetPath, 'utf-8')) as Record<string, unknown>;
    expect(after['status']).toBe('implementing');
    expect(after['started_at']).toBe(result.started_at);
  });
});

describe('startPacket — idempotent rerun', () => {
  it('returns already_started: true and does NOT modify the packet file', () => {
    fixture = makeFixture({
      packet: {
        id: 'pkt-already',
        kind: 'dev',
        title: 'already started',
        status: 'implementing',
        started_at: '2024-01-01T00:00:00Z',
      },
    });
    const f = fixture;
    const before = readFileSync(f.packetPath, 'utf-8');
    const mtimeBefore = statSync(f.packetPath).mtimeMs;
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin so any write produces distinct mtime */ }

    const result = startPacket({
      packetId: 'pkt-already',
      projectRoot: f.root,
      config: f.config,
    });

    expect(result.already_started).toBe(true);
    expect(result.packet_id).toBe('pkt-already');
    expect(result.started_at).toBe('2024-01-01T00:00:00Z');
    expect(result.status).toBe('implementing');

    expect(statSync(f.packetPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(f.packetPath, 'utf-8')).toBe(before);
  });
});

describe('startPacket — preconditions', () => {
  it('throws StartPacketError when packet does not exist', () => {
    fixture = makeFixture({});
    const f = fixture;
    expect(() => {
      startPacket({
        packetId: 'pkt-missing',
        projectRoot: f.root,
        config: f.config,
      });
    }).toThrow(StartPacketError);
  });

  it('throws when packet already has a completion record', () => {
    fixture = makeFixture({
      packet: {
        id: 'pkt-completed',
        kind: 'dev',
        title: 'completed',
        status: 'completed',
        started_at: '2024-01-01T00:00:00Z',
      },
      completion: {
        packet_id: 'pkt-completed',
        completed_at: '2024-01-02T00:00:00Z',
        completed_by: { kind: 'agent', id: 'test' },
        summary: 'done',
        files_changed: [],
        verification: {
          tests_pass: true, build_pass: true, lint_pass: true, ci_pass: true,
          notes: 'ok',
        },
      },
    });
    const f = fixture;
    expect(() => {
      startPacket({
        packetId: 'pkt-completed',
        projectRoot: f.root,
        config: f.config,
      });
    }).toThrow(/already has a completion record/);
  });

  it('throws when packet is abandoned or deferred', () => {
    fixture = makeFixture({
      packet: {
        id: 'pkt-abandoned',
        kind: 'dev',
        title: 'abandoned',
        status: 'abandoned',
      },
    });
    const f = fixture;
    expect(() => {
      startPacket({
        packetId: 'pkt-abandoned',
        projectRoot: f.root,
        config: f.config,
      });
    }).toThrow(/cannot be started/);
  });
});
