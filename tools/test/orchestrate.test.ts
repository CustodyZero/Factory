/**
 * Tests for the deterministic orchestrator harness helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  boundedAttempts,
  boundedRuns,
  buildRetrySteps,
  buildPacketPrompt,
  buildPlannerPrompt,
  buildProviderInvocation,
  emptyState,
  resolveProviderForPersona,
  resolveProviderModel,
} from '../orchestrate.js';
import type { FactoryConfig } from '../config.js';
import type { PlanAction } from '../plan.js';
import type { DispatchRecord } from '../supervise.js';

function makeConfig(): FactoryConfig {
  return {
    project_name: 'factory',
    factory_dir: '.',
    artifact_dir: '.',
    verification: {
      build: 'true',
      lint: 'true',
      test: 'pnpm test',
    },
    validation: {
      command: 'npx tsx tools/validate.ts',
    },
    infrastructure_patterns: [],
    completed_by_default: {
      kind: 'agent',
      id: 'claude',
    },
    personas: {
      planner: { description: 'planner', instructions: [], model: 'opus' },
      developer: { description: 'developer', instructions: [], model: 'opus' },
      reviewer: { description: 'reviewer', instructions: [], model: 'sonnet' },
    },
    orchestrator: {
      enabled: true,
      identity: { kind: 'agent', id: 'orchestrator' },
      output_dir: 'reports/orchestrator',
      recent_run_limit: 3,
      recent_attempt_limit: 4,
      completion_identities: {
        developer: 'codex-dev',
        reviewer: 'claude-qa',
      },
      personas: {
        planner: 'claude',
        developer: 'codex',
        reviewer: 'claude',
      },
      retries: {
        max_supervisor_ticks: 10,
        planner: [
          { provider: 'claude', model: 'sonnet' },
          { provider: 'claude', model: 'opus' },
          { provider: 'codex', model: 'opus' },
        ],
        developer: [
          { provider: 'codex', model: 'sonnet' },
          { provider: 'codex', model: 'opus' },
          { provider: 'claude', model: 'sonnet' },
          { provider: 'claude', model: 'opus' },
        ],
        reviewer: [
          { provider: 'claude', model: 'sonnet' },
          { provider: 'claude', model: 'opus' },
          { provider: 'codex', model: 'opus' },
        ],
      },
      providers: {
        codex: {
          enabled: true,
          command: 'codex',
          sandbox: 'workspace-write',
          models: {
            opus: 'gpt-5.4',
            sonnet: 'gpt-5.4-mini',
            haiku: 'gpt-5.4-mini',
          },
        },
        claude: {
          enabled: true,
          command: 'claude',
          permission_mode: 'bypassPermissions',
          models: {
            opus: 'opus',
            sonnet: 'sonnet',
            haiku: 'haiku',
          },
        },
      },
    },
  };
}

function makePlanAction(): PlanAction {
  return {
    kind: 'plan_feature',
    intent_id: 'customer-dashboard',
    feature_id: null,
    planner_assignment: {
      intent_id: 'customer-dashboard',
      persona: 'planner',
      model: 'opus',
      instructions: ['Create exactly one feature artifact', 'Do not approve the feature'],
      feature_path: 'features/customer-dashboard.json',
      packets_dir: 'packets/',
      spec: 'Add a customer dashboard with billing and activity views.',
      constraints: ['Preserve the public API'],
    },
    command: null,
    message: 'Intent is ready for planning.',
  };
}

function makeDispatch(): DispatchRecord {
  return {
    dispatch_id: 'dispatch-f1-p1-1',
    feature_id: 'f1',
    packet_id: 'p1',
    persona: 'reviewer',
    model: 'sonnet',
    instructions: ['Verify all acceptance criteria', 'Capture evidence'],
    start_command: 'npx tsx tools/start.ts p1',
    dispatched_at: '2026-04-09T00:00:00Z',
  };
}

describe('orchestrate helpers', () => {
  it('OR-U1: provider selection is fixed by orchestrator persona mapping', () => {
    const cfg = makeConfig();
    expect(resolveProviderForPersona('planner', cfg.orchestrator!)).toBe('claude');
    expect(resolveProviderForPersona('developer', cfg.orchestrator!)).toBe('codex');
    expect(resolveProviderForPersona('reviewer', cfg.orchestrator!)).toBe('claude');
  });

  it('OR-U2: model resolution maps factory tiers to provider-native model names', () => {
    const cfg = makeConfig();
    expect(resolveProviderModel(cfg.orchestrator!.providers.codex, 'opus')).toBe('gpt-5.4');
    expect(resolveProviderModel(cfg.orchestrator!.providers.claude, 'sonnet')).toBe('sonnet');
  });

  it('OR-U3: planner prompt preserves planning-only contract', () => {
    const prompt = buildPlannerPrompt(makePlanAction(), makeConfig());
    expect(prompt).toContain("intent 'customer-dashboard'");
    expect(prompt).toContain('Create exactly one planned feature artifact');
    expect(prompt).toContain('Do not approve the feature');
    expect(prompt).not.toContain('Start command:');
  });

  it('OR-U4: packet prompt includes start and complete commands', () => {
    const prompt = buildPacketPrompt(makeDispatch(), makeConfig(), makeConfig().orchestrator!);
    expect(prompt).toContain('Start command: npx tsx tools/start.ts p1');
    expect(prompt).toContain('npx tsx tools/complete.ts p1 --identity claude-qa');
    expect(prompt).toContain('Verify all acceptance criteria');
  });

  it('OR-U5: codex invocation uses exec and output file capture', () => {
    const invocation = buildProviderInvocation(
      'codex',
      makeConfig().orchestrator!.providers.codex,
      '/repo',
      '/tmp/out.txt',
      'Do work',
      'opus',
    );
    expect(invocation.command).toBe('codex');
    expect(invocation.args).toContain('exec');
    expect(invocation.args).toContain('/tmp/out.txt');
    expect(invocation.stdin).toBeNull();
  });

  it('OR-U6: claude invocation uses stdin and json output', () => {
    const invocation = buildProviderInvocation(
      'claude',
      makeConfig().orchestrator!.providers.claude,
      '/repo',
      '/tmp/out.txt',
      'Do work',
      'sonnet',
    );
    expect(invocation.command).toBe('claude');
    expect(invocation.args).toContain('--output-format');
    expect(invocation.args).toContain('json');
    expect(invocation.stdin).toBe('Do work');
  });

  it('OR-U7: orchestrator state keeps bounded recent runs', () => {
    const state = emptyState({ kind: 'agent', id: 'orchestrator' }, '2026-04-09T00:00:00Z');
    const runs = boundedRuns([
      { id: '1', kind: 'packet', provider: 'codex', target_id: 'p1', feature_id: 'f1', dispatch_id: 'd1', started_at: '', completed_at: '', attempt: 1, exit_code: 0, result: 'success', output_path: null, message: '', failure_kind: null },
      { id: '2', kind: 'packet', provider: 'codex', target_id: 'p2', feature_id: 'f2', dispatch_id: 'd2', started_at: '', completed_at: '', attempt: 1, exit_code: 0, result: 'success', output_path: null, message: '', failure_kind: null },
      { id: '3', kind: 'packet', provider: 'claude', target_id: 'p3', feature_id: 'f3', dispatch_id: 'd3', started_at: '', completed_at: '', attempt: 1, exit_code: 0, result: 'success', output_path: null, message: '', failure_kind: null },
      { id: '4', kind: 'planner', provider: 'claude', target_id: 'i1', feature_id: null, dispatch_id: null, started_at: '', completed_at: '', attempt: 1, exit_code: 0, result: 'success', output_path: null, message: '', failure_kind: null },
    ], 3);
    expect(state.version).toBe(1);
    expect(state.cache.recent_attempts).toEqual([]);
    expect(runs.map((run) => run.id)).toEqual(['2', '3', '4']);
  });

  it('OR-U8: retry ladder prepends assigned model and dedupes configured steps', () => {
    const steps = buildRetrySteps('reviewer', 'sonnet', makeConfig().orchestrator!);
    expect(steps).toEqual([
      { provider: 'claude', model: 'sonnet' },
      { provider: 'claude', model: 'opus' },
      { provider: 'codex', model: 'opus' },
    ]);
  });

  it('OR-U9: attempt history is bounded independently from run history', () => {
    const attempts = boundedAttempts([
      { kind: 'packet', target_id: 'p1', feature_id: 'f1', dispatch_id: 'd1', persona: 'developer', provider: 'codex', model: 'sonnet', attempt: 1, outcome: 'failed', failure_kind: 'task_failed', observed_at: '' },
      { kind: 'packet', target_id: 'p1', feature_id: 'f1', dispatch_id: 'd1', persona: 'developer', provider: 'codex', model: 'opus', attempt: 2, outcome: 'success', failure_kind: null, observed_at: '' },
      { kind: 'planner', target_id: 'i1', feature_id: null, dispatch_id: null, persona: 'planner', provider: 'claude', model: 'opus', attempt: 1, outcome: 'success', failure_kind: null, observed_at: '' },
      { kind: 'packet', target_id: 'p2', feature_id: 'f2', dispatch_id: 'd2', persona: 'reviewer', provider: 'claude', model: 'sonnet', attempt: 1, outcome: 'failed', failure_kind: 'task_failed', observed_at: '' },
      { kind: 'packet', target_id: 'p2', feature_id: 'f2', dispatch_id: 'd2', persona: 'reviewer', provider: 'claude', model: 'opus', attempt: 2, outcome: 'success', failure_kind: null, observed_at: '' },
    ], 4);
    expect(attempts).toHaveLength(4);
    expect(attempts[0].provider).toBe('codex');
    expect(attempts[3].attempt).toBe(2);
  });
});
