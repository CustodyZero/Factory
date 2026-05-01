/**
 * Tests for the I/O leaf helpers exported from tools/run.ts.
 *
 * These helpers wrap filesystem and child-process calls. They are exported
 * specifically so the contract changes introduced in Phase 1 round-2
 * (patchJson dirty-flag) and Phase 3 (lifecycle library calls instead of
 * execSync) can be pinned.
 *
 * The original (pre-extraction) run.ts only wrote a feature artifact when
 * status === 'planned'. The dirty-flag contract on patchJson preserves
 * that semantics: if the mutator returns false, the file MUST NOT be
 * written (no mtime change, no reformat).
 *
 * Phase 3 removed runLifecycle() — the orchestrator now imports library
 * functions directly from tools/lifecycle/ rather than spawning a
 * subprocess. The "no execSync to lifecycle scripts in run.ts" check is
 * a structural test (grep over the file's source); the behavioral tests
 * for each lifecycle function live in tools/test/lifecycle_*.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchJson, refreshCompletionId } from '../run.js';

function makeTempJson(initial: Record<string, unknown>): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'patchjson-'));
  const path = join(dir, 'thing.json');
  writeFileSync(path, JSON.stringify(initial, null, 2) + '\n', 'utf-8');
  return { dir, path };
}

describe('patchJson', () => {
  it('writes the file when mutator returns true', () => {
    const { dir, path } = makeTempJson({ status: 'planned' });
    try {
      patchJson(path, (d) => {
        d['status'] = 'executing';
        return true;
      });
      const after = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      expect(after['status']).toBe('executing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT write the file when mutator returns false (no mtime change)', () => {
    const { dir, path } = makeTempJson({ status: 'executing' });
    try {
      const mtimeBefore = statSync(path).mtimeMs;
      // Wait long enough that an unintended write would produce a different mtime.
      // Most filesystems have at least 1ms resolution; we use a short busy wait
      // rather than setTimeout to keep the test deterministic and synchronous.
      const start = Date.now();
      while (Date.now() - start < 20) { /* spin */ }

      patchJson(path, (d) => {
        // Inspect-only: same status, no mutation needed.
        if (d['status'] === 'planned') {
          d['status'] = 'executing';
          return true;
        }
        return false;
      });

      const mtimeAfter = statSync(path).mtimeMs;
      expect(mtimeAfter).toBe(mtimeBefore);

      // Content is also unchanged.
      const after = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      expect(after['status']).toBe('executing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swallows errors when the file is missing or invalid', () => {
    // No throw — best-effort contract.
    expect(() => {
      patchJson('/nonexistent/path/that/does/not/exist.json', () => true);
    }).not.toThrow();
  });

  it('swallows errors when the file is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patchjson-bad-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, 'not-json{', 'utf-8');
    try {
      expect(() => {
        patchJson(path, () => true);
      }).not.toThrow();
      // File is not modified by a failed parse.
      expect(readFileSync(path, 'utf-8')).toBe('not-json{');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// refreshCompletionId — Phase 3 round 2 fix.
//
// Both devPhase and qaPhase build completionIds once at phase start. Per the
// same external-mutation model that justifies the per-iteration packet
// re-reads, an external agent may have invoked complete.ts directly on a
// previous packet during the loop. The helper reconciles the in-memory set
// against disk for one packet id at a time.
//
// Contract pinned:
//   - completion file present, set empty   -> set gains the id
//   - completion file present, set has id  -> no-op (idempotent)
//   - completion file absent                -> set unchanged
//   - completions/ dir absent               -> no throw, set unchanged
// ---------------------------------------------------------------------------

describe('refreshCompletionId', () => {
  it('adds packetId to the set when the completion file exists on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'refresh-completion-'));
    try {
      mkdirSync(join(root, 'completions'));
      writeFileSync(
        join(root, 'completions', 'pkt-x.json'),
        JSON.stringify({ packet_id: 'pkt-x' }, null, 2) + '\n',
        'utf-8',
      );
      const set = new Set<string>();
      refreshCompletionId(set, 'pkt-x', root);
      expect(set.has('pkt-x')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a completion file that appears AFTER the phase-start scan but BEFORE the loop reaches that packet', () => {
    // This pins the staleness behavior: the in-memory set was built
    // before the completion file existed; the helper must reconcile.
    const root = mkdtempSync(join(tmpdir(), 'refresh-completion-staleness-'));
    try {
      mkdirSync(join(root, 'completions'));
      // Phase-start scan: empty completions dir, set is empty.
      const completionIds = new Set<string>();
      // ... loop iterates first packet ... external agent runs complete.ts
      // on pkt-2 during/after that iteration, before our loop reaches it:
      writeFileSync(
        join(root, 'completions', 'pkt-2.json'),
        JSON.stringify({ packet_id: 'pkt-2' }, null, 2) + '\n',
        'utf-8',
      );
      // Loop now arrives at pkt-2. Without the refresh, completionIds.has
      // would return false and we would reprocess. With the refresh, the
      // disk fact wins.
      refreshCompletionId(completionIds, 'pkt-2', root);
      expect(completionIds.has('pkt-2')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when the packetId is already in the set', () => {
    // Idempotent: even if the file exists, it should not redundantly
    // touch the set or read the disk in a way that mutates state.
    const root = mkdtempSync(join(tmpdir(), 'refresh-completion-idem-'));
    try {
      mkdirSync(join(root, 'completions'));
      writeFileSync(
        join(root, 'completions', 'pkt-y.json'),
        JSON.stringify({ packet_id: 'pkt-y' }, null, 2) + '\n',
        'utf-8',
      );
      const set = new Set<string>(['pkt-y']);
      const sizeBefore = set.size;
      refreshCompletionId(set, 'pkt-y', root);
      expect(set.has('pkt-y')).toBe(true);
      expect(set.size).toBe(sizeBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the set unchanged when the completion file does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'refresh-completion-missing-'));
    try {
      mkdirSync(join(root, 'completions'));
      // No completion file for pkt-z.
      const set = new Set<string>();
      refreshCompletionId(set, 'pkt-z', root);
      expect(set.has('pkt-z')).toBe(false);
      expect(set.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not throw when the completions directory itself is missing', () => {
    // Defensive: artifactRoot exists, but completions/ has not been
    // created yet. existsSync returns false; helper returns cleanly.
    const root = mkdtempSync(join(tmpdir(), 'refresh-completion-nodir-'));
    try {
      const set = new Set<string>();
      expect(() => refreshCompletionId(set, 'pkt-w', root)).not.toThrow();
      expect(set.has('pkt-w')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3 structural test: run.ts must NOT call lifecycle CLIs via execSync.
//
// The whole point of Phase 3 was to replace execSync('npx tsx tools/start.ts
// ...') with direct imports of startPacket()/requestReview()/etc. Future
// refactors that re-introduce that pattern would silently undo the work.
//
// We verify by reading the file's source: if a lifecycle script name
// appears inside a child_process call, the test fails. This is more
// reliable than a behavioral test (which would require a fixture
// pipeline run) and catches regressions on the very next CI run.
// ---------------------------------------------------------------------------

const RUN_TS_PATH = resolve(fileURLToPath(import.meta.url), '..', '..', 'run.ts');

/**
 * Strip block comments and line comments from TypeScript source so the
 * structural invariants below can match against actual code, not the
 * file's own narrative description of what it stopped doing.
 */
function stripComments(source: string): string {
  // Block comments first (greedy across newlines), then line comments.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('run.ts — Phase 3 structural invariants', () => {
  const source = readFileSync(RUN_TS_PATH, 'utf-8');
  const code = stripComments(source);

  it('does not import or call execSync', () => {
    // execSync is the smoking gun. The previous runLifecycle() helper
    // was the only consumer; now that it is gone, no import or call
    // should remain in the actual code. spawnSync is still used (for
    // provider CLIs) — that is expected and orthogonal.
    expect(code).not.toMatch(/\bexecSync\b/);
  });

  it('imports the four lifecycle library functions', () => {
    expect(code).toMatch(/from\s+['"]\.\/lifecycle\/start\.js['"]/);
    expect(code).toMatch(/from\s+['"]\.\/lifecycle\/request_review\.js['"]/);
    expect(code).toMatch(/from\s+['"]\.\/lifecycle\/review\.js['"]/);
    expect(code).toMatch(/from\s+['"]\.\/lifecycle\/complete\.js['"]/);
  });

  it('does not invoke any lifecycle script by filename', () => {
    // Belt-and-suspenders: even if execSync were re-introduced, the
    // string literals 'start.ts', 'complete.ts' etc. should not
    // appear anywhere in code. (Comments are stripped above.)
    expect(code).not.toMatch(/['"]start\.ts['"]/);
    expect(code).not.toMatch(/['"]request-review\.ts['"]/);
    expect(code).not.toMatch(/['"]review\.ts['"]/);
    expect(code).not.toMatch(/['"]complete\.ts['"]/);
  });

  it('does not export runLifecycle (deleted in Phase 3)', () => {
    expect(code).not.toMatch(/export\s+function\s+runLifecycle/);
    expect(code).not.toMatch(/export\s+interface\s+LifecycleResult/);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 behavioral test: the lifecycle library functions can be
// invoked from a fixture directory and produce the expected on-disk
// effects. This pins the projectRoot-injection contract that run.ts
// relies on when it calls them with a per-pipeline projectRoot value.
// ---------------------------------------------------------------------------

describe('lifecycle libraries — projectRoot injection from a fixture', () => {
  it('startPacket+completePacket on a fixture round-trips through disk state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'run-libcall-'));
    try {
      mkdirSync(join(root, 'packets'));
      mkdirSync(join(root, 'completions'));
      // Minimal config matching the lifecycle_cli.test.ts fixture.
      writeFileSync(
        join(root, 'factory.config.json'),
        JSON.stringify({
          project_name: 'libcall',
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
      writeFileSync(
        join(root, 'packets', 'pkt-libcall.json'),
        JSON.stringify({
          id: 'pkt-libcall',
          kind: 'dev',
          title: 'libcall',
          status: 'ready',
        }, null, 2) + '\n',
        'utf-8',
      );

      const { startPacket } = await import('../lifecycle/start.js');
      const { completePacket } = await import('../lifecycle/complete.js');

      const startResult = startPacket({ packetId: 'pkt-libcall', projectRoot: root });
      expect(startResult.already_started).toBe(false);
      expect(startResult.status).toBe('implementing');

      const completeResult = completePacket({ packetId: 'pkt-libcall', projectRoot: root });
      expect(completeResult.already_complete).toBe(false);
      expect(completeResult.ci_pass).toBe(true);

      // Idempotent rerun: completePacket returns already_complete: true
      // without changing the on-disk record.
      const second = completePacket({ packetId: 'pkt-libcall', projectRoot: root });
      expect(second.already_complete).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
