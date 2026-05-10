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
import { patchJson, formatJsonOutput } from '../run.js';
import type { OrchestratorResult } from '../pipeline/orchestrator/index.js';
import { refreshCompletionId } from '../pipeline/lifecycle_helpers.js';

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
// Phase 3 structural invariants — held by run.ts and the phase modules.
//
// The Phase 3 invariant is "no execSync to lifecycle CLIs anywhere in the
// orchestration code path" — replaced by direct library imports of
// startPacket()/requestReview()/recordReview()/completePacket().
//
// Phase 4.5 moved the imperative phase loops out of run.ts and into
// dedicated phase modules under tools/pipeline/. After that move, run.ts
// no longer imports the lifecycle libraries directly — the phase modules
// do. The Phase 3 invariant therefore now applies at the pipeline-module
// scope.
//
// This block pins both halves:
//   1. run.ts itself is execSync-free and references no lifecycle filename.
//   2. The pipeline modules that took over the phase work (develop_phase,
//      verify_phase) DO import the lifecycle libraries directly, are
//      themselves execSync-free, and never reference a lifecycle script
//      filename.
// ---------------------------------------------------------------------------

const TOOLS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');
const RUN_TS_PATH = join(TOOLS_DIR, 'run.ts');
const DEVELOP_PHASE_PATH = join(TOOLS_DIR, 'pipeline', 'develop_phase.ts');
const VERIFY_PHASE_PATH = join(TOOLS_DIR, 'pipeline', 'verify_phase.ts');

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

describe('run.ts — Phase 3 + 4.5 structural invariants', () => {
  const code = stripComments(readFileSync(RUN_TS_PATH, 'utf-8'));

  it('does not import or call execSync', () => {
    // execSync is the smoking gun. After Phase 3 removed runLifecycle(),
    // no import or call should remain. spawnSync is still allowed for
    // provider CLIs, but that pathway lives in the phase modules now.
    expect(code).not.toMatch(/\bexecSync\b/);
  });

  it('does not invoke any lifecycle script by filename', () => {
    // Belt-and-suspenders against an execSync regression — even if it
    // came back, the lifecycle script names should never appear inside
    // run.ts code (comments are stripped above).
    expect(code).not.toMatch(/['"]start\.ts['"]/);
    expect(code).not.toMatch(/['"]request-review\.ts['"]/);
    expect(code).not.toMatch(/['"]review\.ts['"]/);
    expect(code).not.toMatch(/['"]complete\.ts['"]/);
  });

  it('does not export runLifecycle (deleted in Phase 3)', () => {
    expect(code).not.toMatch(/export\s+function\s+runLifecycle/);
    expect(code).not.toMatch(/export\s+interface\s+LifecycleResult/);
  });

  it('imports the orchestrator (Phase 5: multi-spec sequencing)', () => {
    // After Phase 5 the entry layer delegates to runOrchestrator. The
    // per-spec phase calls (runPlanPhase / runDevelopPhase /
    // runVerifyPhase) live in the orchestrator now, so run.ts only
    // imports the driver. A regression that re-inlined the per-spec
    // body would either drop this import or pull the phase imports
    // back into run.ts.
    expect(code).toMatch(/from\s+['"]\.\/pipeline\/orchestrator\/index\.js['"]/);
    // The phase-function imports moved to the orchestrator; run.ts
    // itself should not import them anymore.
    expect(code).not.toMatch(/from\s+['"]\.\/pipeline\/plan_phase\.js['"]/);
    expect(code).not.toMatch(/from\s+['"]\.\/pipeline\/develop_phase\.js['"]/);
    expect(code).not.toMatch(/from\s+['"]\.\/pipeline\/verify_phase\.js['"]/);
  });
});

describe('pipeline phase modules — Phase 3 invariants (post-Phase-4.5 scope)', () => {
  // The lifecycle-library imports moved with the phase loops. Pin them
  // at their new home so a future refactor that re-introduces execSync
  // here is caught by the same kind of structural test that protected
  // run.ts before.
  const developCode = stripComments(readFileSync(DEVELOP_PHASE_PATH, 'utf-8'));
  const verifyCode = stripComments(readFileSync(VERIFY_PHASE_PATH, 'utf-8'));

  it('develop_phase.ts imports the lifecycle libraries it actually uses', () => {
    // Develop touches three lifecycle steps directly: start,
    // request_review, complete. The review verdict comes from the
    // reviewer agent calling review.ts itself (the load-bearing
    // protocol channel — see prompts.ts:buildReviewPrompt). The
    // convergence-pass control flow no longer force-approves on
    // disk from the orchestrator, so the orchestrator does NOT
    // import review.ts. (A reviewer that exits without recording a
    // verdict is escalated as ReviewDecisionMissing.)
    expect(developCode).toMatch(/from\s+['"]\.\.\/lifecycle\/start\.js['"]/);
    expect(developCode).toMatch(/from\s+['"]\.\.\/lifecycle\/request_review\.js['"]/);
    expect(developCode).toMatch(/from\s+['"]\.\.\/lifecycle\/complete\.js['"]/);
    expect(developCode).not.toMatch(/from\s+['"]\.\.\/lifecycle\/review\.js['"]/);
  });

  it('verify_phase.ts imports only the lifecycle libraries it uses (start + complete)', () => {
    // Verify only invokes start and complete — there's no review step
    // for QA packets. A regression that pulls in extra lifecycle
    // libraries here would point at a logic mistake.
    expect(verifyCode).toMatch(/from\s+['"]\.\.\/lifecycle\/start\.js['"]/);
    expect(verifyCode).toMatch(/from\s+['"]\.\.\/lifecycle\/complete\.js['"]/);
    expect(verifyCode).not.toMatch(/from\s+['"]\.\.\/lifecycle\/request_review\.js['"]/);
    expect(verifyCode).not.toMatch(/from\s+['"]\.\.\/lifecycle\/review\.js['"]/);
  });

  it('phase modules are free of execSync and lifecycle-filename strings', () => {
    for (const code of [developCode, verifyCode]) {
      expect(code).not.toMatch(/\bexecSync\b/);
      expect(code).not.toMatch(/['"]start\.ts['"]/);
      expect(code).not.toMatch(/['"]request-review\.ts['"]/);
      expect(code).not.toMatch(/['"]review\.ts['"]/);
      expect(code).not.toMatch(/['"]complete\.ts['"]/);
    }
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

// ---------------------------------------------------------------------------
// formatJsonOutput — Phase 5 round 2 backward-compat shim.
//
// Pre-Phase-5 `tools/run.ts --json` emitted a flat RunResult shape
// keyed by `intent_id`. Phase 5 round 1 silently switched to the
// new `OrchestratorResult` envelope (`{ specs, success, message }`)
// for ALL runs, breaking single-arg consumers. Round 2 keeps the
// new envelope for multi-arg runs but adapts back to the legacy
// flat shape when exactly one positional arg was passed.
//
// These tests pin the contract end-to-end (the helper is a pure
// function over an already-constructed OrchestratorResult, so a
// subprocess test is unnecessary).
// ---------------------------------------------------------------------------

describe('formatJsonOutput', () => {
  it('emits the legacy flat RunResult shape for single-arg success', () => {
    const result: OrchestratorResult = {
      specs: [{
        id: 'foo',
        status: 'completed',
        feature_id: 'feat-foo',
        packets_completed: ['pkt-1', 'pkt-2'],
        packets_failed: [],
      }],
      success: true,
      message: 'All 1 spec(s) completed',
    };
    const out = formatJsonOutput(['foo'], result);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    // Legacy keys present.
    expect(parsed['intent_id']).toBe('foo');
    expect(parsed['feature_id']).toBe('feat-foo');
    expect(parsed['packets_completed']).toEqual(['pkt-1', 'pkt-2']);
    expect(parsed['packets_failed']).toEqual([]);
    expect(parsed['success']).toBe(true);
    expect(parsed['message']).toBe('All 1 spec(s) completed');
    // New envelope keys absent.
    expect(parsed['specs']).toBeUndefined();
  });

  it('emits the legacy flat shape for single-arg failure', () => {
    const result: OrchestratorResult = {
      specs: [{
        id: 'bar',
        status: 'failed',
        feature_id: 'feat-bar',
        packets_completed: ['pkt-1'],
        packets_failed: ['pkt-2'],
        reason: '1 packet(s) failed: pkt-2',
      }],
      success: false,
      message: '0 completed, 1 failed, 0 blocked',
    };
    const out = formatJsonOutput(['bar'], result);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['intent_id']).toBe('bar');
    expect(parsed['feature_id']).toBe('feat-bar');
    expect(parsed['packets_completed']).toEqual(['pkt-1']);
    expect(parsed['packets_failed']).toEqual(['pkt-2']);
    expect(parsed['success']).toBe(false);
    expect(parsed['specs']).toBeUndefined();
  });

  it('emits empty-array fallback for single-arg with NO per-spec outcome (resolution failed)', () => {
    // Top-level failure (resolution / cycle / missing-dep) produces a
    // result with `specs: []`. The legacy single-arg shape must still
    // be preserved with sensible defaults.
    const result: OrchestratorResult = {
      specs: [],
      success: false,
      message: "No spec or intent found for 'ghost'",
    };
    const out = formatJsonOutput(['ghost'], result);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['intent_id']).toBe('ghost');
    expect(parsed['feature_id']).toBeNull();
    expect(parsed['packets_completed']).toEqual([]);
    expect(parsed['packets_failed']).toEqual([]);
    expect(parsed['success']).toBe(false);
    expect(parsed['message']).toBe("No spec or intent found for 'ghost'");
    expect(parsed['specs']).toBeUndefined();
  });

  it('emits empty-array fallback for single-arg whose outcome is `blocked`', () => {
    // A blocked outcome has no feature_id / packets_* fields — the
    // SpecOutcome variant for `blocked` only carries blocked_by and
    // reason. The legacy shape uses null + [] sentinels in this case.
    const result: OrchestratorResult = {
      specs: [{
        id: 'blocked-spec',
        status: 'blocked',
        blocked_by: ['upstream'],
        reason: 'Blocked by upstream spec(s) that did not complete: upstream',
      }],
      success: false,
      message: '0 completed, 0 failed, 1 blocked',
    };
    const out = formatJsonOutput(['blocked-spec'], result);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['intent_id']).toBe('blocked-spec');
    expect(parsed['feature_id']).toBeNull();
    expect(parsed['packets_completed']).toEqual([]);
    expect(parsed['packets_failed']).toEqual([]);
    expect(parsed['specs']).toBeUndefined();
  });

  it('emits the new envelope shape (specs, success, message) for multi-arg runs', () => {
    const result: OrchestratorResult = {
      specs: [
        {
          id: 'a',
          status: 'completed',
          feature_id: 'feat-a',
          packets_completed: [],
          packets_failed: [],
        },
        {
          id: 'b',
          status: 'completed',
          feature_id: 'feat-b',
          packets_completed: [],
          packets_failed: [],
        },
      ],
      success: true,
      message: 'All 2 spec(s) completed',
    };
    const out = formatJsonOutput(['a', 'b'], result);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    // New envelope keys present.
    expect(Array.isArray(parsed['specs'])).toBe(true);
    expect((parsed['specs'] as unknown[])).toHaveLength(2);
    expect(parsed['success']).toBe(true);
    expect(parsed['message']).toBe('All 2 spec(s) completed');
    // Legacy single-arg keys absent in multi-arg mode.
    expect(parsed['intent_id']).toBeUndefined();
    expect(parsed['feature_id']).toBeUndefined();
    expect(parsed['packets_completed']).toBeUndefined();
    expect(parsed['packets_failed']).toBeUndefined();
  });
});
