/**
 * Tests for the I/O leaf helpers exported from tools/run.ts.
 *
 * These helpers wrap filesystem and child-process calls. They are exported
 * specifically so the contract changes introduced in Phase 1 round-2
 * (patchJson dirty-flag, runLifecycle error-detail shape) can be pinned.
 *
 * The original (pre-extraction) run.ts only wrote a feature artifact when
 * status === 'planned'. The dirty-flag contract on patchJson preserves
 * that semantics: if the mutator returns false, the file MUST NOT be
 * written (no mtime change, no reformat).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchJson, runLifecycle } from '../run.js';
import { loadConfig } from '../config.js';

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

describe('runLifecycle', () => {
  it('returns { ok: false, error } when the script does not exist', () => {
    const config = loadConfig();
    const result = runLifecycle('does-not-exist-fake-script.ts', [], config, 5_000);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    // The error message must contain something diagnosable. We don't pin the
    // exact text (it depends on the OS / shell), but it must not be empty.
    expect(result.error?.length ?? 0).toBeGreaterThan(0);
  });
});
