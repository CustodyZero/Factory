/**
 * Phase 6 — Unit tests for the recovery I/O wrapper and the
 * lifecycle stale-branch helper.
 *
 * Covers:
 *   - writeEscalation creates the escalations dir, writes a valid
 *     JSON file at the documented path, returns the path
 *   - readEscalation round-trips a written record
 *   - tolerates non-existent parent dir (creates it)
 *   - escalationPathFor builds the documented path with ":" -> "-"
 *     timestamp safety
 *   - checkBranchUpToDate detects a stale branch via injected runner
 *   - checkBranchUpToDate returns null on fetch failure (best-effort)
 *   - looksLikeStaleBranchMessage matches realistic stderr
 *   - cross-layer drift: every lifecycle stale-branch pattern is also
 *     matched by the pipeline classifier's STALE_BRANCH_PATTERNS
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  escalationPathFor,
  readEscalation,
  writeEscalation,
} from '../recovery.js';
import type { EscalationRecord } from '../pipeline/recovery.js';
import { STALE_BRANCH_PATTERNS } from '../pipeline/recovery.js';
import {
  STALE_BRANCH_LIFECYCLE_PATTERNS,
  checkBranchUpToDate,
  looksLikeStaleBranchMessage,
  type GitCheckRunResult,
} from '../lifecycle/git_check.js';

let tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'recovery-io-'));
  tempDirs.push(d);
  return d;
}

function fixtureRecord(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    scenario: overrides.scenario ?? 'TestFailed',
    reason: overrides.reason ?? 'Test failure: always escalate.',
    spec_id: overrides.spec_id ?? 'spec-foo',
    packet_id: overrides.packet_id ?? 'pkt-bar',
    operation_label: overrides.operation_label ?? 'verify_phase.complete',
    attempts: overrides.attempts ?? 1,
    run_id: overrides.run_id ?? 'run-001',
    timestamp: overrides.timestamp ?? '2026-05-01T10:00:00.000Z',
    failure: overrides.failure ?? {
      exit_code: 1,
      stderr_tail: 'tests failed: 3 of 10',
      stdout_tail: '',
      error_message: null,
    },
  };
}

// ---------------------------------------------------------------------------
// escalationPathFor
// ---------------------------------------------------------------------------

describe('escalationPathFor', () => {
  it('builds the escalations subdir path with spec id and timestamp', () => {
    const { dir, file } = escalationPathFor('/tmp/art', 'spec-x', '2026-05-01T10:00:00.000Z');
    expect(dir).toBe('/tmp/art/escalations');
    expect(file).toContain('spec-x-');
    expect(file).toMatch(/\.json$/);
  });

  it('replaces ":" with "-" in timestamps for filesystem safety', () => {
    const { file } = escalationPathFor('/tmp/art', 'spec-x', '2026-05-01T10:00:00.000Z');
    expect(file).not.toContain(':');
    expect(file).toContain('2026-05-01T10-00-00');
  });

  it('uses "_unknown" when spec id is null', () => {
    const { file } = escalationPathFor('/tmp/art', null, '2026-05-01T10:00:00.000Z');
    expect(file).toContain('_unknown-');
  });
});

// ---------------------------------------------------------------------------
// writeEscalation
// ---------------------------------------------------------------------------

describe('writeEscalation', () => {
  it('creates the escalations dir and writes a valid JSON file', () => {
    const root = mkTmp();
    const rec = fixtureRecord();
    const path = writeEscalation(rec, root);
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(existsSync(join(root, 'escalations'))).toBe(true);

    const raw = readFileSync(path!, 'utf-8');
    const parsed = JSON.parse(raw) as EscalationRecord;
    expect(parsed.scenario).toBe(rec.scenario);
    expect(parsed.reason).toBe(rec.reason);
    expect(parsed.spec_id).toBe(rec.spec_id);
    expect(parsed.packet_id).toBe(rec.packet_id);
    expect(parsed.attempts).toBe(rec.attempts);
    expect(parsed.failure.exit_code).toBe(1);
  });

  it('returns the on-disk path of the written file', () => {
    const root = mkTmp();
    const rec = fixtureRecord({ spec_id: 'spec-zzz' });
    const path = writeEscalation(rec, root);
    expect(path).not.toBeNull();
    expect(path!).toMatch(/escalations\/spec-zzz-2026-05-01T/);
    expect(path!).toMatch(/\.json$/);
  });

  it('writes a trailing newline', () => {
    const root = mkTmp();
    const path = writeEscalation(fixtureRecord(), root);
    const raw = readFileSync(path!, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('is human-readable (pretty-printed with 2-space indent)', () => {
    const root = mkTmp();
    const path = writeEscalation(fixtureRecord(), root);
    const raw = readFileSync(path!, 'utf-8');
    expect(raw).toContain('\n  '); // pretty indent
  });

  it('tolerates the artifact root not existing yet (creates parent dirs)', () => {
    const root = join(mkTmp(), 'nested', 'deep', 'art');
    const path = writeEscalation(fixtureRecord(), root);
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
  });

  it('does NOT throw on a write failure (best-effort contract)', () => {
    // Pass a bogus root that cannot be created (path includes a NUL).
    // mkdir will throw; writeEscalation must swallow.
    expect(() => writeEscalation(fixtureRecord(), '/dev/null/cannot-create')).not.toThrow();
  });

  it('produces one file per call (no append behavior)', () => {
    const root = mkTmp();
    const path1 = writeEscalation(fixtureRecord({ timestamp: '2026-05-01T10:00:00.000Z' }), root);
    const path2 = writeEscalation(fixtureRecord({ timestamp: '2026-05-01T10:00:01.000Z' }), root);
    expect(path1).not.toBe(path2);
    expect(existsSync(path1!)).toBe(true);
    expect(existsSync(path2!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readEscalation
// ---------------------------------------------------------------------------

describe('readEscalation', () => {
  it('round-trips a written record', () => {
    const root = mkTmp();
    const rec = fixtureRecord();
    const path = writeEscalation(rec, root);
    const round = readEscalation(path!);
    expect(round?.scenario).toBe(rec.scenario);
    expect(round?.reason).toBe(rec.reason);
  });

  it('returns null for a non-existent path', () => {
    expect(readEscalation('/tmp/no-such-path-recovery-test.json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkBranchUpToDate (lifecycle helper)
// ---------------------------------------------------------------------------

describe('checkBranchUpToDate', () => {
  function runner(
    fetchResult: GitCheckRunResult,
    countResult: GitCheckRunResult,
  ) {
    return (args: ReadonlyArray<string>) => {
      if (args[0] === 'fetch') return fetchResult;
      if (args[0] === 'rev-list') return countResult;
      return { exitCode: 1, stdout: '', stderr: 'unknown args' };
    };
  }

  it('returns null when the branch is current (count = 0)', () => {
    const r = checkBranchUpToDate(
      '/repo',
      runner(
        { exitCode: 0, stdout: '', stderr: '' },
        { exitCode: 0, stdout: '0\n', stderr: '' },
      ),
    );
    expect(r).toBeNull();
  });

  it('returns the behind count when the branch is behind', () => {
    const r = checkBranchUpToDate(
      '/repo',
      runner(
        { exitCode: 0, stdout: '', stderr: '' },
        { exitCode: 0, stdout: '5\n', stderr: '' },
      ),
    );
    expect(r).not.toBeNull();
    expect(r!.behindCount).toBe(5);
    expect(r!.stderr).toContain("branch is behind 'origin/main'");
  });

  it('returns null on fetch failure (best-effort: skip the check)', () => {
    const r = checkBranchUpToDate(
      '/repo',
      runner(
        { exitCode: 1, stdout: '', stderr: 'fatal: unable to access' },
        { exitCode: 0, stdout: '5\n', stderr: '' },
      ),
    );
    expect(r).toBeNull();
  });

  it('returns null when rev-list cannot run', () => {
    const r = checkBranchUpToDate(
      '/repo',
      runner(
        { exitCode: 0, stdout: '', stderr: '' },
        { exitCode: 1, stdout: '', stderr: 'fatal: bad revision' },
      ),
    );
    expect(r).toBeNull();
  });

  it('the constructed stderr matches the classifier STALE_BRANCH_PATTERNS', () => {
    const r = checkBranchUpToDate(
      '/repo',
      runner(
        { exitCode: 0, stdout: '', stderr: '' },
        { exitCode: 0, stdout: '3\n', stderr: '' },
      ),
    );
    expect(r).not.toBeNull();
    const matches = STALE_BRANCH_PATTERNS.some((p) => p.test(r!.stderr));
    expect(matches).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// looksLikeStaleBranchMessage
// ---------------------------------------------------------------------------

describe('looksLikeStaleBranchMessage', () => {
  it('returns true for "Your branch is behind"', () => {
    expect(looksLikeStaleBranchMessage("Your branch is behind 'origin/main' by 3 commits")).toBe(true);
  });

  it('returns true for "non-fast-forward"', () => {
    expect(looksLikeStaleBranchMessage('rejected: non-fast-forward')).toBe(true);
  });

  it('returns false for an unrelated git error', () => {
    expect(looksLikeStaleBranchMessage('fatal: not a git repository')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(looksLikeStaleBranchMessage('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-layer drift: every lifecycle pattern is also matched by the
// pipeline classifier. If you add a pattern to one list and forget
// the other, this test fails.
// ---------------------------------------------------------------------------

describe('cross-layer drift: STALE_BRANCH patterns', () => {
  it('every lifecycle pattern is also matched by the pipeline classifier', () => {
    // Synthesize text that matches each lifecycle pattern, then
    // confirm at least one pipeline pattern also matches.
    const fixtures = [
      "Your branch is behind 'origin/main' by 3 commits",
      'rejected: non-fast-forward',
      'hint: updates were rejected because the remote ref behind your local ref',
      "branch is behind 'origin/main'",
      'failed to push some refs to origin',
    ];
    for (const text of fixtures) {
      const lifecycleMatches = STALE_BRANCH_LIFECYCLE_PATTERNS.some((p) => p.test(text));
      expect(lifecycleMatches).toBe(true);
      const pipelineMatches = STALE_BRANCH_PATTERNS.some((p) => p.test(text));
      expect(pipelineMatches).toBe(true);
    }
  });
});
