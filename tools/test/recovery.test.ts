/**
 * Phase 6 — Unit tests for the pure recovery module.
 *
 * Pins:
 *   - classifier coverage for every scenario from realistic inputs
 *   - garbage / empty inputs return null without throwing
 *   - each recipe produces the contracted shape and action
 *   - SCENARIO_RETRY_BUDGET matches the brief's table verbatim
 *   - RECIPES has an entry for every scenario in ALL_SCENARIOS
 *   - tailString trims correctly
 *   - recovery event constructors round-trip through the envelope
 *   - RecoveryResult<T> discriminator narrows correctly
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_SCENARIOS,
  BUILD_GUARDRAIL_PROMPT,
  RECIPES,
  SCENARIO_RETRY_BUDGET,
  STALE_BRANCH_PATTERNS,
  classifyFailure,
  tailString,
  type EscalationRecord,
  type FailureContext,
  type FailureScenario,
  type RecoveryResult,
} from '../pipeline/recovery.js';
import {
  makeRecoveryAttemptStarted,
  makeRecoverySucceeded,
  makeRecoveryExhausted,
  makeRecoveryEscalated,
} from '../pipeline/events.js';

function ctx(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    exit_code: overrides.exit_code ?? 1,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    error_message: overrides.error_message ?? null,
    ...(overrides.kind !== undefined ? { kind: overrides.kind } : {}),
    ...(overrides.failed_checks !== undefined ? { failed_checks: overrides.failed_checks } : {}),
    ...(overrides.spec_id !== undefined ? { spec_id: overrides.spec_id } : {}),
    ...(overrides.packet_id !== undefined ? { packet_id: overrides.packet_id } : {}),
    ...(overrides.operation_label !== undefined ? { operation_label: overrides.operation_label } : {}),
  };
}

// ---------------------------------------------------------------------------
// classifier — provider unavailable
// ---------------------------------------------------------------------------

describe('classifyFailure — provider unavailable', () => {
  it("classifies \"Provider 'codex' is disabled\" as ProviderUnavailable", () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: "Provider 'codex' is disabled",
    }))).toBe('ProviderUnavailable');
  });

  it("classifies \"Provider 'claude' not configured\" as ProviderUnavailable", () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: "Provider 'claude' not configured",
    }))).toBe('ProviderUnavailable');
  });

  it('classifies "Pipeline config not found" as ProviderUnavailable', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: 'Pipeline config not found',
    }))).toBe('ProviderUnavailable');
  });

  it('classifies "model gpt-5 not found" as ProviderUnavailable', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: 'Error: model gpt-5 not found',
    }))).toBe('ProviderUnavailable');
  });

  it('prefers ProviderUnavailable over ProviderTransient when both patterns appear', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: "Provider 'codex' is disabled (last response was 503)",
    }))).toBe('ProviderUnavailable');
  });
});

// ---------------------------------------------------------------------------
// classifier — provider transient
// ---------------------------------------------------------------------------

describe('classifyFailure — provider transient', () => {
  it('classifies HTTP 503 in stderr as ProviderTransient', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: 'Error: HTTP 503 Service Unavailable',
    }))).toBe('ProviderTransient');
  });

  it('classifies 502 Bad Gateway as ProviderTransient', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: '502 Bad Gateway',
    }))).toBe('ProviderTransient');
  });

  it('classifies 429 rate-limited as ProviderTransient', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: 'Error: 429 Too Many Requests',
    }))).toBe('ProviderTransient');
  });

  it('classifies ECONNRESET as ProviderTransient', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: 'Error: ECONNRESET',
    }))).toBe('ProviderTransient');
  });

  it('classifies ETIMEDOUT as ProviderTransient', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      stderr: 'fetch failed: ETIMEDOUT',
    }))).toBe('ProviderTransient');
  });

  it('classifies "request timed out" as ProviderTransient', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      error_message: 'request timed out after 60s',
    }))).toBe('ProviderTransient');
  });
});

// ---------------------------------------------------------------------------
// classifier — verification (authoritative kind dispatch)
// ---------------------------------------------------------------------------

describe('classifyFailure — verification kind dispatch', () => {
  it('returns BuildFailed when failed_checks contains "build"', () => {
    expect(classifyFailure(ctx({
      kind: 'verification',
      failed_checks: ['build'],
    }))).toBe('BuildFailed');
  });

  it('returns LintFailed when failed_checks contains only "lint"', () => {
    expect(classifyFailure(ctx({
      kind: 'verification',
      failed_checks: ['lint'],
    }))).toBe('LintFailed');
  });

  it('returns TestFailed when failed_checks contains only "tests"', () => {
    expect(classifyFailure(ctx({
      kind: 'verification',
      failed_checks: ['tests'],
    }))).toBe('TestFailed');
  });

  it('build wins over lint when both fail (root-cause priority)', () => {
    expect(classifyFailure(ctx({
      kind: 'verification',
      failed_checks: ['build', 'lint'],
    }))).toBe('BuildFailed');
  });

  it('falls through to text matching when failed_checks is ci-only', () => {
    expect(classifyFailure(ctx({
      kind: 'verification',
      failed_checks: ['ci'],
      stderr: 'tests failed: 3 of 10 suites',
    }))).toBe('TestFailed');
  });
});

// ---------------------------------------------------------------------------
// classifier — git / stale branch
// ---------------------------------------------------------------------------

describe('classifyFailure — git / stale branch', () => {
  it("classifies kind='git' + 'Your branch is behind' as StaleBranch", () => {
    expect(classifyFailure(ctx({
      kind: 'git',
      stderr: "Your branch is behind 'origin/main' by 3 commits",
    }))).toBe('StaleBranch');
  });

  it("classifies kind='git' + 'non-fast-forward' as StaleBranch", () => {
    expect(classifyFailure(ctx({
      kind: 'git',
      stderr: 'rejected: non-fast-forward',
    }))).toBe('StaleBranch');
  });

  it("returns null for kind='git' with no stale-branch markers", () => {
    expect(classifyFailure(ctx({
      kind: 'git',
      stderr: 'fatal: not a git repository',
    }))).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// classifier — completion gate
// ---------------------------------------------------------------------------

describe('classifyFailure — completion gate', () => {
  it('classifies "FI-7" stderr as CompletionGateBlocked', () => {
    expect(classifyFailure(ctx({
      kind: 'lifecycle',
      stderr: 'FI-7 violation: same identity completed dev and qa',
    }))).toBe('CompletionGateBlocked');
  });

  it('classifies "completion-gate" stderr as CompletionGateBlocked', () => {
    expect(classifyFailure(ctx({
      kind: 'lifecycle',
      stderr: 'completion-gate rejected the commit',
    }))).toBe('CompletionGateBlocked');
  });

  it('classifies "pre-commit hook failed" as CompletionGateBlocked', () => {
    expect(classifyFailure(ctx({
      kind: 'lifecycle',
      stderr: 'pre-commit hook failed (FI-7 enforcement)',
    }))).toBe('CompletionGateBlocked');
  });
});

// ---------------------------------------------------------------------------
// classifier — build / lint / test text fallback
// ---------------------------------------------------------------------------

describe('classifyFailure — build/lint/test text fallback', () => {
  it('classifies "build failed" stderr as BuildFailed', () => {
    expect(classifyFailure(ctx({
      stderr: 'build failed: error TS2304',
    }))).toBe('BuildFailed');
  });

  it('classifies eslint marker as LintFailed', () => {
    expect(classifyFailure(ctx({
      stderr: 'eslint: 12 problems',
    }))).toBe('LintFailed');
  });

  it('classifies "tests failed" as TestFailed', () => {
    expect(classifyFailure(ctx({
      stderr: 'tests failed: see report',
    }))).toBe('TestFailed');
  });
});

// ---------------------------------------------------------------------------
// classifier — agent non-responsive
// ---------------------------------------------------------------------------

describe('classifyFailure — agent non-responsive', () => {
  it('classifies non-zero exit with empty output as AgentNonResponsive', () => {
    expect(classifyFailure(ctx({
      kind: 'agent_invocation',
      exit_code: 1,
      stdout: '',
      stderr: '',
    }))).toBe('AgentNonResponsive');
  });
});

// ---------------------------------------------------------------------------
// classifier — null path (honest unknown)
// ---------------------------------------------------------------------------

describe('classifyFailure — honest unknown', () => {
  it('returns null for an unrecognized failure shape', () => {
    expect(classifyFailure(ctx({
      stderr: 'some unrecognized provider banner with no diagnostic markers',
    }))).toBe(null);
  });

  it('does not throw on garbage input', () => {
    expect(() => classifyFailure(ctx({
      stderr: '\x00\x01\x02\xff',
      stdout: '',
    }))).not.toThrow();
  });

  it('does not throw on very long output', () => {
    expect(() => classifyFailure(ctx({
      stderr: 'A'.repeat(1_000_000),
    }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recipes — produce the contracted shape
// ---------------------------------------------------------------------------

describe('RECIPES — shape and behavior', () => {
  it('has an entry for every FailureScenario in ALL_SCENARIOS', () => {
    for (const s of ALL_SCENARIOS) {
      expect(typeof RECIPES[s]).toBe('function');
    }
    expect(Object.keys(RECIPES).length).toBe(ALL_SCENARIOS.length);
  });

  it('ProviderTransient -> retry_same with wait_ms', () => {
    const out = RECIPES.ProviderTransient('ProviderTransient', ctx());
    expect(out.kind).toBe('attempt');
    if (out.kind === 'attempt') {
      expect(out.action).toBe('retry_same');
      expect(out.wait_ms).toBeGreaterThan(0);
    }
  });

  it('ProviderUnavailable -> escalate (Phase-7-deferred)', () => {
    const out = RECIPES.ProviderUnavailable('ProviderUnavailable', ctx());
    expect(out.kind).toBe('escalate');
    if (out.kind === 'escalate') {
      expect(out.reason).toMatch(/Phase 7/);
    }
  });

  it('BuildFailed -> retry_with_guardrail_prompt; prompt includes BUILD_GUARDRAIL_PROMPT', () => {
    const out = RECIPES.BuildFailed('BuildFailed', ctx({ stderr: 'error TS2304' }));
    expect(out.kind).toBe('attempt');
    if (out.kind === 'attempt') {
      expect(out.action).toBe('retry_with_guardrail_prompt');
      expect(out.guardrail_prompt).toContain(BUILD_GUARDRAIL_PROMPT);
      expect(out.guardrail_prompt).toContain('error TS2304');
    }
  });

  it('LintFailed -> escalate (no retry)', () => {
    const out = RECIPES.LintFailed('LintFailed', ctx());
    expect(out.kind).toBe('escalate');
  });

  it('TestFailed -> escalate (no retry)', () => {
    const out = RECIPES.TestFailed('TestFailed', ctx());
    expect(out.kind).toBe('escalate');
  });

  it('StaleBranch -> git_rebase_then_retry', () => {
    const out = RECIPES.StaleBranch('StaleBranch', ctx());
    expect(out.kind).toBe('attempt');
    if (out.kind === 'attempt') expect(out.action).toBe('git_rebase_then_retry');
  });

  it('AgentNonResponsive -> retry_same', () => {
    const out = RECIPES.AgentNonResponsive('AgentNonResponsive', ctx());
    expect(out.kind).toBe('attempt');
    if (out.kind === 'attempt') expect(out.action).toBe('retry_same');
  });

  it('CompletionGateBlocked -> escalate', () => {
    const out = RECIPES.CompletionGateBlocked('CompletionGateBlocked', ctx());
    expect(out.kind).toBe('escalate');
  });
});

// ---------------------------------------------------------------------------
// SCENARIO_RETRY_BUDGET — pin the brief's table
// ---------------------------------------------------------------------------

describe('SCENARIO_RETRY_BUDGET', () => {
  it('matches the brief: 2/2/1/1/0/0/0/0', () => {
    expect(SCENARIO_RETRY_BUDGET.ProviderTransient).toBe(2);
    expect(SCENARIO_RETRY_BUDGET.AgentNonResponsive).toBe(2);
    expect(SCENARIO_RETRY_BUDGET.BuildFailed).toBe(1);
    expect(SCENARIO_RETRY_BUDGET.StaleBranch).toBe(1);
    expect(SCENARIO_RETRY_BUDGET.LintFailed).toBe(0);
    expect(SCENARIO_RETRY_BUDGET.TestFailed).toBe(0);
    expect(SCENARIO_RETRY_BUDGET.CompletionGateBlocked).toBe(0);
    expect(SCENARIO_RETRY_BUDGET.ProviderUnavailable).toBe(0);
  });

  it('has an entry for every scenario in ALL_SCENARIOS', () => {
    for (const s of ALL_SCENARIOS) {
      expect(typeof SCENARIO_RETRY_BUDGET[s]).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// tailString
// ---------------------------------------------------------------------------

describe('tailString', () => {
  it('returns the input unchanged when shorter than maxBytes', () => {
    expect(tailString('hello', 100)).toBe('hello');
  });

  it('returns the last maxBytes characters when input is too long', () => {
    expect(tailString('abcdefghij', 4)).toBe('ghij');
  });

  it('handles empty string', () => {
    expect(tailString('', 10)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// STALE_BRANCH_PATTERNS — exported for cross-layer drift test
// ---------------------------------------------------------------------------

describe('STALE_BRANCH_PATTERNS', () => {
  it('matches the canonical "Your branch is behind \'origin/main\'" string', () => {
    const text = "Your branch is behind 'origin/main' by 3 commits.";
    expect(STALE_BRANCH_PATTERNS.some((p) => p.test(text))).toBe(true);
  });

  it('matches "non-fast-forward"', () => {
    expect(STALE_BRANCH_PATTERNS.some((p) => p.test('rejected: non-fast-forward'))).toBe(true);
  });

  it('matches "rebase conflict"', () => {
    expect(STALE_BRANCH_PATTERNS.some((p) => p.test('rebase conflict in src/foo.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recovery event constructors round-trip
// ---------------------------------------------------------------------------

describe('Recovery event constructors', () => {
  const base = { run_id: 'r1', dry_run: false } as const;

  it('makeRecoveryAttemptStarted produces the event_type', () => {
    const e = makeRecoveryAttemptStarted(base, {
      scenario: 'BuildFailed',
      attempt_number: 2,
      packet_id: 'p1',
      spec_id: 's1',
    });
    expect(e.event_type).toBe('recovery.attempt_started');
    expect(e.payload.event_type).toBe('recovery.attempt_started');
    expect(e.payload.scenario).toBe('BuildFailed');
    expect(e.payload.attempt_number).toBe(2);
    expect(e.payload.packet_id).toBe('p1');
    expect(e.payload.spec_id).toBe('s1');
    expect(e.run_id).toBe('r1');
  });

  it('makeRecoverySucceeded produces the event_type', () => {
    const e = makeRecoverySucceeded(base, {
      scenario: 'ProviderTransient',
      attempt_number: 2,
      packet_id: null,
      spec_id: 's',
    });
    expect(e.event_type).toBe('recovery.succeeded');
    expect(e.payload.scenario).toBe('ProviderTransient');
  });

  it('makeRecoveryExhausted produces the event_type', () => {
    const e = makeRecoveryExhausted(base, {
      scenario: 'ProviderTransient',
      attempts: 3,
      packet_id: 'p',
      spec_id: 's',
    });
    expect(e.event_type).toBe('recovery.exhausted');
    expect(e.payload.attempts).toBe(3);
  });

  it('makeRecoveryEscalated produces the event_type with reason', () => {
    const e = makeRecoveryEscalated(base, {
      scenario: 'TestFailed',
      reason: 'Test failure: always escalate.',
      packet_id: 'p',
      spec_id: 's',
    });
    expect(e.event_type).toBe('recovery.escalated');
    expect(e.payload.reason).toMatch(/Test failure/);
  });
});

// ---------------------------------------------------------------------------
// RecoveryResult<T> — type-level discriminator narrows
// ---------------------------------------------------------------------------

describe('RecoveryResult<T> discriminator', () => {
  it('narrows on kind: ok and provides value', () => {
    const r: RecoveryResult<number> = { kind: 'ok', value: 42 };
    if (r.kind === 'ok') {
      expect(r.value).toBe(42);
    } else {
      expect.fail('unreachable');
    }
  });

  it('narrows on kind: escalated and provides scenario/reason/attempts/escalation', () => {
    const escalation: EscalationRecord = {
      scenario: 'TestFailed',
      reason: 'because',
      spec_id: null,
      packet_id: null,
      operation_label: null,
      attempts: 1,
      run_id: 'r',
      timestamp: '2026-05-01T00:00:00.000Z',
      failure: { exit_code: 1, stderr_tail: '', stdout_tail: '', error_message: null },
    };
    const r: RecoveryResult<number> = {
      kind: 'escalated',
      scenario: 'TestFailed',
      reason: 'because',
      attempts: 1,
      escalation,
      escalation_path: null,
    };
    if (r.kind === 'escalated') {
      expect(r.scenario).toBe('TestFailed');
      expect(r.reason).toBe('because');
      expect(r.attempts).toBe(1);
      expect(r.escalation.scenario).toBe('TestFailed');
    } else {
      expect.fail('unreachable');
    }
  });
});

// Exported types referenced for type-only assertions; suppress the
// unused-import lint warning by re-exposing.
type _UseFailureScenario = FailureScenario;
