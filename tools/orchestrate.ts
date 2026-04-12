#!/usr/bin/env tsx
/**
 * Factory — Deterministic Orchestrator Harness
 *
 * Drives planner and supervisor actions by invoking approved LLM CLIs
 * through deterministic shell command contracts. The orchestrator never
 * decides work on its own; it only consumes factory resolver outputs.
 *
 * Supported providers:
 *   - codex
 *   - claude
 *
 * Usage:
 *   npx tsx tools/orchestrate.ts health [--probe] [--json]
 *   npx tsx tools/orchestrate.ts plan <intent-id> [--dry-run] [--json]
 *   npx tsx tools/orchestrate.ts supervise [--feature <id>] [--dry-run] [--json]
 *   npx tsx tools/orchestrate.ts run [--intent <intent-id>] [--feature <id>] [--dry-run] [--json]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildToolCommand,
  findProjectRoot,
  loadConfig,
  resolveArtifactRoot,
  resolveToolScriptPath,
} from './config.js';
import type {
  FactoryConfig,
  ModelTier,
  OrchestratorConfig,
  OrchestratorPersona,
  OrchestratorProvider,
  OrchestratorProviderConfig,
  OrchestratorRetryStep,
} from './config.js';
import type { PlanAction } from './plan.js';
import type { DispatchRecord, SupervisorAction } from './supervise.js';

type OrchestratorCommand = 'health' | 'plan' | 'supervise' | 'run';
type OrchestratorRunKind = 'healthcheck' | 'planner' | 'packet';
export type OrchestratorFailureKind =
  | 'provider_unavailable'
  | 'provider_error'
  | 'task_failed'
  | null;

export interface ProviderHealth {
  readonly provider: OrchestratorProvider;
  readonly available: boolean;
  readonly checked_at: string;
  readonly message: string;
}

export interface OrchestratorRunRecord {
  readonly id: string;
  readonly kind: OrchestratorRunKind;
  readonly provider: OrchestratorProvider;
  readonly target_id: string;
  readonly feature_id: string | null;
  readonly dispatch_id: string | null;
  readonly started_at: string;
  readonly completed_at: string;
  readonly attempt: number;
  readonly exit_code: number;
  readonly result: 'success' | 'failed' | 'skipped';
  readonly output_path: string | null;
  readonly message: string;
  readonly failure_kind: OrchestratorFailureKind;
}

export interface AttemptSummary {
  readonly kind: 'planner' | 'packet';
  readonly target_id: string;
  readonly feature_id: string | null;
  readonly dispatch_id: string | null;
  readonly persona: 'planner' | 'developer' | 'code_reviewer' | 'qa';
  readonly provider: OrchestratorProvider;
  readonly model: ModelTier;
  readonly attempt: number;
  readonly outcome: 'success' | 'failed' | 'skipped';
  readonly failure_kind: OrchestratorFailureKind;
  readonly observed_at: string;
}

export interface OrchestratorState {
  readonly version: number;
  readonly updated_at: string;
  readonly updated_by: { readonly kind: string; readonly id: string };
  readonly provider_health: Readonly<Record<string, ProviderHealth>>;
  readonly cache: {
    readonly last_supervisor_action: {
      readonly kind: string;
      readonly feature_ids: ReadonlyArray<string>;
      readonly dispatch_ids: ReadonlyArray<string>;
      readonly observed_at: string;
    } | null;
    readonly plan_actions: Readonly<Record<string, {
      readonly kind: string;
      readonly feature_id: string | null;
      readonly observed_at: string;
    }>>;
    readonly active_run: {
      readonly mode: 'plan' | 'supervise' | 'run';
      readonly intent_id: string | null;
      readonly feature_id: string | null;
      readonly started_at: string;
      readonly tick_count: number;
    } | null;
    readonly recent_attempts: ReadonlyArray<AttemptSummary>;
  };
  readonly recent_runs: ReadonlyArray<OrchestratorRunRecord>;
}

export interface ProviderInvocation {
  readonly provider: OrchestratorProvider;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: string | null;
  readonly output_path: string;
}

interface RunShellResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface HealthResult {
  readonly checks: ReadonlyArray<ProviderHealth>;
  readonly recent_runs: ReadonlyArray<OrchestratorRunRecord>;
}

interface PlanResult {
  readonly action: PlanAction;
  readonly runs: ReadonlyArray<OrchestratorRunRecord>;
}

interface SuperviseResult {
  readonly action: SupervisorAction;
  readonly runs: ReadonlyArray<OrchestratorRunRecord>;
}

interface RunLoopResult {
  readonly plan_action: PlanAction | null;
  readonly last_supervisor_action: SupervisorAction | null;
  readonly runs: ReadonlyArray<OrchestratorRunRecord>;
  readonly ticks: number;
  readonly status: 'idle' | 'awaiting_approval' | 'blocked' | 'failed';
  readonly message: string;
}

export function emptyState(identity: { kind: string; id: string }, nowIso: string): OrchestratorState {
  return {
    version: 1,
    updated_at: nowIso,
    updated_by: identity,
    provider_health: {},
    cache: {
      last_supervisor_action: null,
      plan_actions: {},
      active_run: null,
      recent_attempts: [],
    },
    recent_runs: [],
  };
}

function readState(path: string, identity: { kind: string; id: string }, nowIso: string): OrchestratorState {
  if (!existsSync(path)) {
    return emptyState(identity, nowIso);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as OrchestratorState;
  } catch {
    return emptyState(identity, nowIso);
  }
}

function writeState(path: string, state: OrchestratorState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function boundedRuns(runs: ReadonlyArray<OrchestratorRunRecord>, limit: number): OrchestratorRunRecord[] {
  return runs.slice(Math.max(0, runs.length - limit));
}

export function boundedAttempts(attempts: ReadonlyArray<AttemptSummary>, limit: number): AttemptSummary[] {
  return attempts.slice(Math.max(0, attempts.length - limit));
}

function runId(kind: OrchestratorRunKind, targetId: string, nowIso: string, attempt: number): string {
  return `${kind}-${targetId}-attempt-${String(attempt)}-${nowIso.replace(/[:.]/g, '-')}`;
}

export function resolveProviderForPersona(
  persona: OrchestratorPersona,
  orchestrator: OrchestratorConfig,
): OrchestratorProvider {
  return orchestrator.personas[persona];
}

export function resolveProviderModel(provider: OrchestratorProviderConfig, tier: ModelTier): string {
  return provider.models[tier];
}

export function buildRetrySteps(
  persona: OrchestratorPersona,
  assignedModel: ModelTier,
  orchestrator: OrchestratorConfig,
): ReadonlyArray<OrchestratorRetryStep> {
  const preferred: OrchestratorRetryStep = {
    provider: resolveProviderForPersona(persona, orchestrator),
    model: assignedModel,
  };
  const configured = orchestrator.retries[persona];
  const deduped: OrchestratorRetryStep[] = [];
  for (const step of [preferred, ...configured]) {
    if (!deduped.some((candidate) => candidate.provider === step.provider && candidate.model === step.model)) {
      deduped.push(step);
    }
  }
  return deduped;
}

function ensureOutputDir(artifactRoot: string, orchestrator: OrchestratorConfig): string {
  const dir = join(artifactRoot, orchestrator.output_dir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function shellRun(command: string, args: ReadonlyArray<string>, cwd: string, stdin: string | null): RunShellResult {
  const result = spawnSync(command, [...args], {
    cwd,
    input: stdin ?? undefined,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    exit_code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function classifyFailure(combinedOutput: string, exitCode: number): OrchestratorFailureKind {
  if (exitCode === 0) {
    return null;
  }
  if (/disabled|command not found|enoent|permission denied|not available/i.test(combinedOutput)) {
    return 'provider_unavailable';
  }
  if (/timeout|rate limit|429|5\d\d|connection|network|transport/i.test(combinedOutput)) {
    return 'provider_error';
  }
  return 'task_failed';
}

function healthcheckProvider(
  providerName: OrchestratorProvider,
  provider: OrchestratorProviderConfig,
  cwd: string,
  probe: boolean,
  outputDir: string,
  nowIso: string,
): { health: ProviderHealth; run: OrchestratorRunRecord | null } {
  const helpResult = shellRun(provider.command, ['--help'], cwd, null);
  if (helpResult.exit_code !== 0) {
    return {
      health: {
        provider: providerName,
        available: false,
        checked_at: nowIso,
        message: `${provider.command} --help failed with exit code ${String(helpResult.exit_code)}`,
      },
      run: null,
    };
  }

  if (!probe) {
    return {
      health: {
        provider: providerName,
        available: true,
        checked_at: nowIso,
        message: `${provider.command} --help succeeded`,
      },
      run: null,
    };
  }

  const outputPath = join(outputDir, `${providerName}-healthcheck-${Date.now()}.txt`);
  const invocation = buildHealthInvocation(providerName, provider, cwd, outputPath);
  const startedAt = nowIso;
  const result = shellRun(invocation.command, invocation.args, cwd, invocation.stdin);
  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
  const completedAt = new Date().toISOString();
  const message = result.exit_code === 0 ? `${providerName} probe succeeded` : `${providerName} probe failed`;
  const run: OrchestratorRunRecord = {
    id: runId('healthcheck', providerName, startedAt, 1),
    kind: 'healthcheck',
    provider: providerName,
    target_id: providerName,
    feature_id: null,
    dispatch_id: null,
    started_at: startedAt,
    completed_at: completedAt,
    attempt: 1,
    exit_code: result.exit_code,
    result: result.exit_code === 0 ? 'success' : 'failed',
    output_path: outputPath,
    message,
    failure_kind: classifyFailure(combinedOutput, result.exit_code),
  };
  return {
    health: {
      provider: providerName,
      available: result.exit_code === 0,
      checked_at: completedAt,
      message,
    },
    run,
  };
}

function buildHealthInvocation(
  providerName: OrchestratorProvider,
  provider: OrchestratorProviderConfig,
  cwd: string,
  outputPath: string,
): ProviderInvocation {
  if (providerName === 'codex') {
    return {
      provider: providerName,
      command: provider.command,
      args: [
        'exec',
        '-C',
        cwd,
        '-s',
        provider.sandbox ?? 'read-only',
        '-o',
        outputPath,
        'Reply with exactly: PROVIDER_OK',
      ],
      stdin: null,
      output_path: outputPath,
    };
  }

  return {
    provider: providerName,
    command: provider.command,
    args: [
      '-p',
      '--output-format',
      'text',
      '--permission-mode',
      provider.permission_mode ?? 'plan',
      '--tools',
      '',
    ],
    stdin: 'Reply with exactly: PROVIDER_OK\n',
    output_path: outputPath,
  };
}

export function buildPlannerPrompt(action: PlanAction, config: FactoryConfig): string {
  if (action.planner_assignment === null) {
    throw new Error('Planner assignment required');
  }

  const instructions = action.planner_assignment.instructions.map((instruction) => `- ${instruction}`).join('\n');
  const constraints = action.planner_assignment.constraints.map((constraint) => `- ${constraint}`).join('\n');
  const constraintBlock = constraints.length > 0 ? `Constraints:\n${constraints}\n` : '';

  return [
    `You are the factory planner agent for intent '${action.intent_id}'.`,
    '',
    'Write artifacts only under the factory artifact tree for this project.',
    `Feature path: ${action.planner_assignment.feature_path}`,
    `Packets directory: ${action.planner_assignment.packets_dir}`,
    '',
    'Planning instructions:',
    instructions,
    '',
    `Spec:\n${action.planner_assignment.spec}`,
    constraintBlock,
    'Required end state:',
    '- Create exactly one planned feature artifact.',
    '- Create dev/qa packet pairs with dependencies and acceptance criteria.',
    '- Link feature.intent_id to the intent and set intent.feature_id to the feature.',
    '- Do not approve the feature.',
    '- Do not execute any packet.',
    '',
    `After writing the artifacts, stop. Validate your own output against ${buildToolCommand('validate.ts', [], undefined, config)} if useful, but do not modify supervisor state.`,
  ].filter((line) => line.length > 0).join('\n');
}

export function buildPacketPrompt(
  dispatch: DispatchRecord,
  config: FactoryConfig,
  orchestrator: OrchestratorConfig,
): string {
  const completionIdentity = dispatch.persona === 'qa'
    ? orchestrator.completion_identities.qa
    : dispatch.persona === 'code_reviewer'
      ? orchestrator.completion_identities.code_reviewer
      : orchestrator.completion_identities.developer;
  const completeArgs = [dispatch.packet_id, '--identity', completionIdentity];
  const completeCommand = buildToolCommand('complete.ts', completeArgs, undefined, config);

  const instructions = dispatch.instructions.map((instruction) => `- ${instruction}`).join('\n');
  return [
    `You are the factory ${dispatch.persona} agent for packet '${dispatch.packet_id}' in feature '${dispatch.feature_id}'.`,
    '',
    'Operate only within this packet assignment.',
    `Start command: ${dispatch.start_command}`,
    `Complete command: ${completeCommand}`,
    '',
    'Assignment instructions:',
    instructions.length > 0 ? instructions : '- No additional instructions',
    '',
    'Required steps:',
    `1. Run \`${dispatch.start_command}\` before changing implementation files.`,
    '2. Complete only the assigned packet scope.',
    `3. Run \`${completeCommand}\` when finished.`,
    '4. Stop after completion succeeds or report the blocking failure truthfully.',
    '',
    'Do not approve packets. Do not modify unrelated factory artifacts.',
  ].join('\n');
}

export function buildProviderInvocation(
  providerName: OrchestratorProvider,
  provider: OrchestratorProviderConfig,
  cwd: string,
  outputPath: string,
  prompt: string,
  modelTier: ModelTier,
): ProviderInvocation {
  const providerModel = resolveProviderModel(provider, modelTier);
  if (providerName === 'codex') {
    return {
      provider: providerName,
      command: provider.command,
      args: [
        'exec',
        '-C',
        cwd,
        '-s',
        provider.sandbox ?? 'workspace-write',
        '-m',
        providerModel,
        '-o',
        outputPath,
        prompt,
      ],
      stdin: null,
      output_path: outputPath,
    };
  }

  return {
    provider: providerName,
    command: provider.command,
    args: [
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      provider.permission_mode ?? 'bypassPermissions',
      '--model',
      providerModel,
    ],
    stdin: prompt,
    output_path: outputPath,
  };
}

function invokeProvider(
  kind: OrchestratorRunKind,
  providerName: OrchestratorProvider,
  provider: OrchestratorProviderConfig,
  cwd: string,
  outputDir: string,
  targetId: string,
  prompt: string,
  modelTier: ModelTier,
  featureId: string | null,
  dispatchId: string | null,
  attempt: number,
): OrchestratorRunRecord {
  const startedAt = new Date().toISOString();
  const outputPath = join(outputDir, `${kind}-${targetId}-${Date.now()}-${providerName}-attempt-${String(attempt)}.log`);
  const invocation = buildProviderInvocation(providerName, provider, cwd, outputPath, prompt, modelTier);
  const result = shellRun(invocation.command, invocation.args, cwd, invocation.stdin);

  let captured = result.stdout;
  if (providerName === 'codex' && existsSync(outputPath)) {
    captured = readFileSync(outputPath, 'utf-8');
  } else if (providerName === 'claude') {
    writeFileSync(outputPath, result.stdout, 'utf-8');
  }

  const combinedOutput = `${captured}\n${result.stderr}`.trim();
  const completedAt = new Date().toISOString();
  return {
    id: runId(kind, targetId, startedAt, attempt),
    kind,
    provider: providerName,
    target_id: targetId,
    feature_id: featureId,
    dispatch_id: dispatchId,
    started_at: startedAt,
    completed_at: completedAt,
    attempt,
    exit_code: result.exit_code,
    result: result.exit_code === 0 ? 'success' : 'failed',
    output_path: outputPath,
    message: result.exit_code === 0
      ? `${providerName} completed ${kind} run for '${targetId}'`
      : `${providerName} failed ${kind} run for '${targetId}': ${combinedOutput || 'no output'}`,
    failure_kind: classifyFailure(combinedOutput, result.exit_code),
  };
}

function makeSkippedRun(
  kind: OrchestratorRunKind,
  provider: OrchestratorProvider,
  targetId: string,
  featureId: string | null,
  dispatchId: string | null,
  attempt: number,
  message: string,
): OrchestratorRunRecord {
  const nowIso = new Date().toISOString();
  return {
    id: runId(kind, targetId, nowIso, attempt),
    kind,
    provider,
    target_id: targetId,
    feature_id: featureId,
    dispatch_id: dispatchId,
    started_at: nowIso,
    completed_at: nowIso,
    attempt,
    exit_code: 0,
    result: 'skipped',
    output_path: null,
    message,
    failure_kind: null,
  };
}

function makeFailedRun(
  kind: OrchestratorRunKind,
  provider: OrchestratorProvider,
  targetId: string,
  featureId: string | null,
  dispatchId: string | null,
  attempt: number,
  message: string,
  failureKind: Exclude<OrchestratorFailureKind, null>,
): OrchestratorRunRecord {
  const nowIso = new Date().toISOString();
  return {
    id: runId(kind, targetId, nowIso, attempt),
    kind,
    provider,
    target_id: targetId,
    feature_id: featureId,
    dispatch_id: dispatchId,
    started_at: nowIso,
    completed_at: nowIso,
    attempt,
    exit_code: 1,
    result: 'failed',
    output_path: null,
    message,
    failure_kind: failureKind,
  };
}

function parseToolJson<T>(toolScript: string, args: ReadonlyArray<string>, cwd: string, config?: FactoryConfig): T {
  const raw = execFileSync('npx', ['tsx', resolveToolScriptPath(toolScript, cwd, config), ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return JSON.parse(raw) as T;
}

/**
 * Auto-approves a planned feature by setting status to "approved".
 * Used by the orchestrator's run loop to avoid stopping for manual approval.
 */
export function autoApproveFeature(artifactRoot: string, featureId: string): void {
  const featurePath = join(artifactRoot, 'features', `${featureId}.json`);
  const raw = readFileSync(featurePath, 'utf-8');
  const feature = JSON.parse(raw) as Record<string, unknown>;
  feature['status'] = 'approved';
  feature['approved_at'] = new Date().toISOString();
  writeFileSync(featurePath, JSON.stringify(feature, null, 2) + '\n', 'utf-8');
}

function updateState(
  statePath: string,
  config: FactoryConfig,
  mutate: (state: OrchestratorState) => OrchestratorState,
): OrchestratorState {
  const nowIso = new Date().toISOString();
  const state = readState(statePath, config.orchestrator!.identity, nowIso);
  const next = mutate(state);
  writeState(statePath, next);
  return next;
}

function summarizeAttempt(
  run: OrchestratorRunRecord,
  persona: OrchestratorPersona,
  model: ModelTier,
): AttemptSummary {
  return {
    kind: run.kind === 'planner' ? 'planner' : 'packet',
    target_id: run.target_id,
    feature_id: run.feature_id,
    dispatch_id: run.dispatch_id,
    persona,
    provider: run.provider,
    model,
    attempt: run.attempt,
    outcome: run.result,
    failure_kind: run.failure_kind,
    observed_at: run.completed_at,
  };
}

function runWithRetries(options: {
  readonly kind: 'planner' | 'packet';
  readonly persona: OrchestratorPersona;
  readonly targetId: string;
  readonly featureId: string | null;
  readonly dispatchId: string | null;
  readonly assignedModel: ModelTier;
  readonly prompt: string;
  readonly dryRun: boolean;
  readonly projectRoot: string;
  readonly outputDir: string;
  readonly orchestrator: OrchestratorConfig;
}): { readonly runs: ReadonlyArray<OrchestratorRunRecord>; readonly success: boolean } {
  const runs: OrchestratorRunRecord[] = [];
  const steps = buildRetrySteps(options.persona, options.assignedModel, options.orchestrator);

  for (const [index, step] of steps.entries()) {
    const attempt = index + 1;
    if (options.dryRun) {
      runs.push(makeSkippedRun(
        options.kind,
        step.provider,
        options.targetId,
        options.featureId,
        options.dispatchId,
        attempt,
        `Dry run: would invoke ${step.provider} (${step.model}) for ${options.kind} '${options.targetId}'`,
      ));
      return { runs, success: true };
    }

    const provider = options.orchestrator.providers[step.provider];
    if (!provider.enabled) {
      runs.push(makeFailedRun(
        options.kind,
        step.provider,
        options.targetId,
        options.featureId,
        options.dispatchId,
        attempt,
        `Provider '${step.provider}' is disabled for persona '${options.persona}'`,
        'provider_unavailable',
      ));
      continue;
    }

    const run = invokeProvider(
      options.kind,
      step.provider,
      provider,
      options.projectRoot,
      options.outputDir,
      options.targetId,
      options.prompt,
      step.model,
      options.featureId,
      options.dispatchId,
      attempt,
    );
    runs.push(run);
    if (run.exit_code === 0) {
      return { runs, success: true };
    }
  }

  return { runs, success: false };
}

function persistRunArtifacts(
  statePath: string,
  config: FactoryConfig,
  planAction: PlanAction | null,
  supervisorAction: SupervisorAction | null,
  runs: ReadonlyArray<OrchestratorRunRecord>,
  activeRun: OrchestratorState['cache']['active_run'],
): void {
  const orchestrator = config.orchestrator!;
  const attempts: AttemptSummary[] = [];
  if (planAction?.planner_assignment !== null) {
    for (const run of runs.filter((candidate) => candidate.kind === 'planner')) {
      attempts.push(summarizeAttempt(run, 'planner', planAction.planner_assignment.model));
    }
  }
  if (supervisorAction?.kind === 'execute_feature') {
    const dispatchMap = new Map(supervisorAction.dispatches.map((dispatch) => [dispatch.dispatch_id, dispatch]));
    for (const run of runs.filter((candidate) => candidate.kind === 'packet' && candidate.dispatch_id !== null)) {
      const dispatch = dispatchMap.get(run.dispatch_id!);
      if (dispatch === undefined) {
        continue;
      }
      attempts.push(summarizeAttempt(
        run,
        dispatch.persona,
        dispatch.model as ModelTier,
      ));
    }
  }

  updateState(statePath, config, (state) => ({
    ...state,
    updated_at: new Date().toISOString(),
    updated_by: orchestrator.identity,
    cache: {
      ...state.cache,
      last_supervisor_action: supervisorAction === null
        ? state.cache.last_supervisor_action
        : {
          kind: supervisorAction.kind,
          feature_ids: supervisorAction.feature_ids,
          dispatch_ids: supervisorAction.dispatches.map((dispatch) => dispatch.dispatch_id),
          observed_at: new Date().toISOString(),
        },
      plan_actions: planAction === null
        ? state.cache.plan_actions
        : {
          ...state.cache.plan_actions,
          [planAction.intent_id]: {
            kind: planAction.kind,
            feature_id: planAction.feature_id,
            observed_at: new Date().toISOString(),
          },
        },
      active_run: activeRun,
      recent_attempts: boundedAttempts(
        [...state.cache.recent_attempts, ...attempts],
        orchestrator.recent_attempt_limit,
      ),
    },
    recent_runs: boundedRuns([...state.recent_runs, ...runs], orchestrator.recent_run_limit),
  }));
}

function runHealth(
  projectRoot: string,
  config: FactoryConfig,
  orchestrator: OrchestratorConfig,
  statePath: string,
  outputDir: string,
  probe: boolean,
  jsonMode: boolean,
): void {
  const checks: ProviderHealth[] = [];
  const runs: OrchestratorRunRecord[] = [];
  for (const providerName of ['codex', 'claude'] as const) {
    const provider = orchestrator.providers[providerName];
    const result = healthcheckProvider(providerName, provider, projectRoot, probe, outputDir, new Date().toISOString());
    checks.push(result.health);
    if (result.run !== null) {
      runs.push(result.run);
    }
  }

  updateState(statePath, config, (state) => ({
    ...state,
    updated_at: new Date().toISOString(),
    updated_by: orchestrator.identity,
    provider_health: {
      ...state.provider_health,
      ...Object.fromEntries(checks.map((check) => [check.provider, check])),
    },
    cache: {
      ...state.cache,
      active_run: null,
    },
    recent_runs: boundedRuns([...state.recent_runs, ...runs], orchestrator.recent_run_limit),
  }));

  const output: HealthResult = { checks, recent_runs: runs };
  process.stdout.write(
    jsonMode
      ? JSON.stringify(output, null, 2) + '\n'
      : `${checks.map((check) => `${check.provider}: ${check.available ? 'ok' : 'failed'} — ${check.message}`).join('\n')}\n`,
  );
  process.exit(checks.every((check) => check.available) ? 0 : 1);
}

function runPlanOnce(
  projectRoot: string,
  config: FactoryConfig,
  orchestrator: OrchestratorConfig,
  outputDir: string,
  intentId: string,
  dryRun: boolean,
): PlanResult {
  let action = parseToolJson<PlanAction>('plan.ts', [intentId, '--json'], projectRoot, config);
  const runs: OrchestratorRunRecord[] = [];

  if (action.kind === 'plan_feature' && action.planner_assignment !== null) {
    const prompt = buildPlannerPrompt(action, config);
    const steps = buildRetrySteps('planner', action.planner_assignment.model, orchestrator);
    for (const [index, step] of steps.entries()) {
      const attempt = index + 1;
      if (dryRun) {
        runs.push(makeSkippedRun(
          'planner',
          step.provider,
          action.intent_id,
          action.feature_id,
          null,
          attempt,
          `Dry run: would invoke ${step.provider} (${step.model}) for planner '${action.intent_id}'`,
        ));
        break;
      }

      const provider = orchestrator.providers[step.provider];
      if (!provider.enabled) {
        runs.push(makeFailedRun(
          'planner',
          step.provider,
          action.intent_id,
          action.feature_id,
          null,
          attempt,
          `Provider '${step.provider}' is disabled for persona 'planner'`,
          'provider_unavailable',
        ));
        continue;
      }

      const run = invokeProvider(
        'planner',
        step.provider,
        provider,
        projectRoot,
        outputDir,
        action.intent_id,
        prompt,
        step.model,
        action.feature_id,
        null,
        attempt,
      );
      if (run.exit_code !== 0) {
        runs.push(run);
        continue;
      }

      const refreshed = parseToolJson<PlanAction>('plan.ts', [intentId, '--json'], projectRoot, config);
      if (refreshed.kind === 'plan_feature') {
        runs.push({
          ...run,
          result: 'failed',
          exit_code: 1,
          message: `${run.provider} planner run for '${action.intent_id}' did not produce an actionable factory state`,
          failure_kind: 'task_failed',
        });
        continue;
      }

      runs.push(run);
      action = refreshed;
      break;
    }
  }

  return { action, runs };
}

function runSuperviseOnce(
  projectRoot: string,
  config: FactoryConfig,
  orchestrator: OrchestratorConfig,
  outputDir: string,
  featureId: string | undefined,
  dryRun: boolean,
): SuperviseResult {
  const toolArgs = featureId === undefined ? ['--json'] : ['--json', '--feature', featureId];
  const action = parseToolJson<SupervisorAction>('supervise.ts', toolArgs, projectRoot, config);
  const runs: OrchestratorRunRecord[] = [];

  if (action.kind === 'execute_feature') {
    const orderedDispatches = [...action.dispatches].sort((a, b) =>
      `${a.feature_id}:${a.packet_id}`.localeCompare(`${b.feature_id}:${b.packet_id}`),
    );
    for (const dispatch of orderedDispatches) {
      const prompt = buildPacketPrompt(dispatch, config, orchestrator);
      const outcome = runWithRetries({
        kind: 'packet',
        persona: dispatch.persona,
        targetId: dispatch.packet_id,
        featureId: dispatch.feature_id,
        dispatchId: dispatch.dispatch_id,
        assignedModel: dispatch.model as ModelTier,
        prompt,
        dryRun,
        projectRoot,
        outputDir,
        orchestrator,
      });
      runs.push(...outcome.runs);
      if (!outcome.success) {
        break;
      }
    }
  }

  return { action, runs };
}

function runLoop(
  projectRoot: string,
  config: FactoryConfig,
  orchestrator: OrchestratorConfig,
  statePath: string,
  outputDir: string,
  intentId: string | undefined,
  featureId: string | undefined,
  dryRun: boolean,
): RunLoopResult {
  let planAction: PlanAction | null = null;
  let lastSupervisorAction: SupervisorAction | null = null;
  const runs: OrchestratorRunRecord[] = [];
  let ticks = 0;
  const supervisorStatePath = join(resolveArtifactRoot(projectRoot, config), 'supervisor', 'state.json');

  updateState(statePath, config, (state) => ({
    ...state,
    updated_at: new Date().toISOString(),
    updated_by: orchestrator.identity,
    cache: {
      ...state.cache,
      active_run: {
        mode: 'run',
        intent_id: intentId ?? null,
        feature_id: featureId ?? null,
        started_at: new Date().toISOString(),
        tick_count: 0,
      },
    },
  }));

  if (intentId !== undefined) {
    const planResult = runPlanOnce(projectRoot, config, orchestrator, outputDir, intentId, dryRun);
    planAction = planResult.action;
    runs.push(...planResult.runs);
    persistRunArtifacts(
      statePath,
      config,
      planAction,
      null,
      planResult.runs,
      {
        mode: 'run',
        intent_id: intentId,
        feature_id: planAction.feature_id,
        started_at: new Date().toISOString(),
        tick_count: ticks,
      },
    );

    const plannerFailed = planResult.runs.find((run) => run.kind === 'planner' && run.result === 'failed');
    if (plannerFailed !== undefined) {
      persistRunArtifacts(statePath, config, planAction, null, [], null);
      return {
        plan_action: planAction,
        last_supervisor_action: null,
        runs,
        ticks,
        status: 'failed',
        message: plannerFailed.message,
      };
    }

    if (planAction.kind === 'plan_feature') {
      // Planner didn't produce a feature — cannot auto-approve nothing
      persistRunArtifacts(statePath, config, planAction, null, [], null);
      return {
        plan_action: planAction,
        last_supervisor_action: null,
        runs,
        ticks,
        status: 'awaiting_approval',
        message: planAction.message,
      };
    }

    if (planAction.kind === 'awaiting_approval') {
      if (planAction.feature_id !== null) {
        // Auto-approve: the planner used inference to produce the plan;
        // the orchestrator is a deterministic process that moves artifacts through gates.
        autoApproveFeature(resolveArtifactRoot(projectRoot, config), planAction.feature_id);
        planAction = parseToolJson<PlanAction>('plan.ts', [intentId, '--json'], projectRoot, config);
        // Fall through — planAction should now be ready_for_execution
      } else {
        persistRunArtifacts(statePath, config, planAction, null, [], null);
        return {
          plan_action: planAction,
          last_supervisor_action: null,
          runs,
          ticks,
          status: 'awaiting_approval',
          message: planAction.message,
        };
      }
    }

    if (planAction.kind === 'blocked') {
      persistRunArtifacts(statePath, config, planAction, null, [], null);
      return {
        plan_action: planAction,
        last_supervisor_action: null,
        runs,
        ticks,
        status: 'blocked',
        message: planAction.message,
      };
    }

    if (planAction.kind === 'all_complete') {
      persistRunArtifacts(statePath, config, planAction, null, [], null);
      return {
        plan_action: planAction,
        last_supervisor_action: null,
        runs,
        ticks,
        status: 'idle',
        message: planAction.message,
      };
    }

    if (planAction.feature_id !== null && featureId === undefined) {
      featureId = planAction.feature_id;
    }

    if (dryRun) {
      persistRunArtifacts(statePath, config, planAction, null, [], null);
      return {
        plan_action: planAction,
        last_supervisor_action: null,
        runs,
        ticks,
        status: 'idle',
        message: planAction.message,
      };
    }
  }

  if (!existsSync(supervisorStatePath)) {
    if (dryRun) {
      persistRunArtifacts(statePath, config, planAction, null, [], null);
      return {
        plan_action: planAction,
        last_supervisor_action: null,
        runs,
        ticks,
        status: 'failed',
        message: 'Supervisor state is not initialized. Run without --dry-run to let orchestrator initialize it automatically.',
      };
    }
    execFileSync('npx', ['tsx', resolveToolScriptPath('supervise.ts', projectRoot, config), '--init'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
  }

  for (ticks = 1; ticks <= orchestrator.retries.max_supervisor_ticks; ticks += 1) {
    const superviseResult = runSuperviseOnce(projectRoot, config, orchestrator, outputDir, featureId, dryRun);
    lastSupervisorAction = superviseResult.action;
    runs.push(...superviseResult.runs);
    persistRunArtifacts(
      statePath,
      config,
      planAction,
      lastSupervisorAction,
      superviseResult.runs,
      {
        mode: 'run',
        intent_id: intentId ?? null,
        feature_id: featureId ?? lastSupervisorAction.feature_id,
        started_at: new Date().toISOString(),
        tick_count: ticks,
      },
    );

    const failedRun = superviseResult.runs.find((run) => run.result === 'failed');
    if (failedRun !== undefined) {
      persistRunArtifacts(statePath, config, planAction, lastSupervisorAction, [], null);
      return {
        plan_action: planAction,
        last_supervisor_action: lastSupervisorAction,
        runs,
        ticks,
        status: 'failed',
        message: failedRun.message,
      };
    }

    if (dryRun && superviseResult.runs.length > 0) {
      persistRunArtifacts(statePath, config, planAction, lastSupervisorAction, [], null);
      return {
        plan_action: planAction,
        last_supervisor_action: lastSupervisorAction,
        runs,
        ticks,
        status: 'idle',
        message: superviseResult.action.message,
      };
    }

    if (lastSupervisorAction.kind === 'update_state') {
      continue;
    }

    if (lastSupervisorAction.kind === 'execute_feature') {
      continue;
    }

    if (lastSupervisorAction.kind === 'idle') {
      persistRunArtifacts(statePath, config, planAction, lastSupervisorAction, [], null);
      return {
        plan_action: planAction,
        last_supervisor_action: lastSupervisorAction,
        runs,
        ticks,
        status: 'idle',
        message: lastSupervisorAction.message,
      };
    }

    persistRunArtifacts(statePath, config, planAction, lastSupervisorAction, [], null);
    return {
      plan_action: planAction,
      last_supervisor_action: lastSupervisorAction,
      runs,
      ticks,
      status: 'blocked',
      message: lastSupervisorAction.message,
    };
  }

  persistRunArtifacts(statePath, config, planAction, lastSupervisorAction, [], null);
  return {
    plan_action: planAction,
    last_supervisor_action: lastSupervisorAction,
    runs,
    ticks: orchestrator.retries.max_supervisor_ticks,
    status: 'failed',
    message: `Exceeded max supervisor ticks (${String(orchestrator.retries.max_supervisor_ticks)}) without reaching idle or a blocking gate.`,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0] as OrchestratorCommand | undefined;
  const jsonMode = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const probe = args.includes('--probe');

  if (command === undefined || !['health', 'plan', 'supervise', 'run'].includes(command)) {
    console.error('Usage: npx tsx tools/orchestrate.ts <health|plan|supervise|run> [args] [--dry-run] [--probe] [--json]');
    process.exit(1);
  }

  const projectRoot = findProjectRoot();
  const config = loadConfig(projectRoot);
  const orchestrator = config.orchestrator;
  if (orchestrator === undefined || !orchestrator.enabled) {
    console.error('ERROR: orchestrator is not enabled in factory.config.json');
    process.exit(1);
  }

  const artifactRoot = resolveArtifactRoot(projectRoot, config);
  const outputDir = ensureOutputDir(artifactRoot, orchestrator);
  const statePath = join(artifactRoot, 'supervisor', 'orchestrator-state.json');

  if (command === 'health') {
    runHealth(projectRoot, config, orchestrator, statePath, outputDir, probe, jsonMode);
    return;
  }

  if (command === 'plan') {
    const intentId = args.find((arg, index) => index > 0 && !arg.startsWith('-'));
    if (intentId === undefined) {
      console.error('Usage: npx tsx tools/orchestrate.ts plan <intent-id> [--dry-run] [--json]');
      process.exit(1);
    }
    const result = runPlanOnce(projectRoot, config, orchestrator, outputDir, intentId, dryRun);
    persistRunArtifacts(
      statePath,
      config,
      result.action,
      null,
      result.runs,
      null,
    );
    process.stdout.write(
      jsonMode
        ? JSON.stringify(result, null, 2) + '\n'
        : `${result.action.message}\n${result.runs.map((run) => run.message).join('\n')}\n`,
    );
    const failedRun = result.runs.find((run) => run.result === 'failed');
    if (failedRun !== undefined) {
      process.exit(failedRun.exit_code);
    }
    return;
  }

  if (command === 'supervise') {
    const featureIdx = args.indexOf('--feature');
    const featureId = featureIdx !== -1 ? args[featureIdx + 1] : undefined;
    const result = runSuperviseOnce(projectRoot, config, orchestrator, outputDir, featureId, dryRun);
    persistRunArtifacts(
      statePath,
      config,
      null,
      result.action,
      result.runs,
      null,
    );
    process.stdout.write(
      jsonMode
        ? JSON.stringify(result, null, 2) + '\n'
        : `${result.action.message}\n${result.runs.map((run) => run.message).join('\n')}\n`,
    );
    const failedRun = result.runs.find((run) => run.result === 'failed');
    if (failedRun !== undefined) {
      process.exit(failedRun.exit_code);
    }
    return;
  }

  const intentIdx = args.indexOf('--intent');
  const intentId = intentIdx !== -1 ? args[intentIdx + 1] : undefined;
  const featureIdx = args.indexOf('--feature');
  const featureId = featureIdx !== -1 ? args[featureIdx + 1] : undefined;
  const result = runLoop(projectRoot, config, orchestrator, statePath, outputDir, intentId, featureId, dryRun);
  process.stdout.write(
    jsonMode
      ? JSON.stringify(result, null, 2) + '\n'
      : `${result.message}\n${result.runs.map((run) => run.message).join('\n')}\n`,
  );
  process.exit(result.status === 'failed' ? 1 : 0);
}

const isDirectExecution = process.argv[1]?.endsWith('orchestrate.ts') ||
  process.argv[1]?.endsWith('orchestrate.js');
if (isDirectExecution) {
  main();
}
