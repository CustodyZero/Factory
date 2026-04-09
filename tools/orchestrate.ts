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
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
  OrchestratorProvider,
  OrchestratorProviderConfig,
} from './config.js';
import type { PlanAction } from './plan.js';
import type { SupervisorAction, DispatchRecord } from './supervise.js';

type OrchestratorCommand = 'health' | 'plan' | 'supervise';

export interface ProviderHealth {
  readonly provider: OrchestratorProvider;
  readonly available: boolean;
  readonly checked_at: string;
  readonly message: string;
}

export interface OrchestratorRunRecord {
  readonly id: string;
  readonly kind: 'healthcheck' | 'planner' | 'packet';
  readonly provider: OrchestratorProvider;
  readonly target_id: string;
  readonly feature_id: string | null;
  readonly dispatch_id: string | null;
  readonly started_at: string;
  readonly completed_at: string;
  readonly exit_code: number;
  readonly result: 'success' | 'failed' | 'skipped';
  readonly output_path: string | null;
  readonly message: string;
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
  readonly run: OrchestratorRunRecord | null;
}

interface SuperviseResult {
  readonly action: SupervisorAction;
  readonly runs: ReadonlyArray<OrchestratorRunRecord>;
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
  const dir = join(path, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function boundedRuns(runs: ReadonlyArray<OrchestratorRunRecord>, limit: number): OrchestratorRunRecord[] {
  return runs.slice(Math.max(0, runs.length - limit));
}

function runId(kind: OrchestratorRunRecord['kind'], targetId: string, nowIso: string): string {
  return `${kind}-${targetId}-${nowIso.replace(/[:.]/g, '-')}`;
}

export function resolveProviderForPersona(
  persona: 'planner' | 'developer' | 'reviewer',
  orchestrator: OrchestratorConfig,
): OrchestratorProvider {
  return orchestrator.personas[persona];
}

export function resolveProviderModel(provider: OrchestratorProviderConfig, tier: ModelTier): string {
  return provider.models[tier];
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
  const completedAt = new Date().toISOString();
  const message = result.exit_code === 0 ? `${providerName} probe succeeded` : `${providerName} probe failed`;
  const run: OrchestratorRunRecord = {
    id: runId('healthcheck', providerName, startedAt),
    kind: 'healthcheck',
    provider: providerName,
    target_id: providerName,
    feature_id: null,
    dispatch_id: null,
    started_at: startedAt,
    completed_at: completedAt,
    exit_code: result.exit_code,
    result: result.exit_code === 0 ? 'success' : 'failed',
    output_path: outputPath,
    message,
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
    `Write artifacts only under the factory artifact tree for this project.`,
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
  const completeArgs = dispatch.persona === 'reviewer'
    ? [dispatch.packet_id, '--identity', orchestrator.completion_identities.reviewer]
    : [dispatch.packet_id, '--identity', orchestrator.completion_identities.developer];
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
  kind: OrchestratorRunRecord['kind'],
  providerName: OrchestratorProvider,
  provider: OrchestratorProviderConfig,
  cwd: string,
  outputDir: string,
  targetId: string,
  prompt: string,
  modelTier: ModelTier,
  featureId: string | null,
  dispatchId: string | null,
): OrchestratorRunRecord {
  const startedAt = new Date().toISOString();
  const outputPath = join(outputDir, `${kind}-${targetId}-${Date.now()}-${providerName}.log`);
  const invocation = buildProviderInvocation(providerName, provider, cwd, outputPath, prompt, modelTier);
  const result = shellRun(invocation.command, invocation.args, cwd, invocation.stdin);

  let captured = result.stdout;
  if (providerName === 'codex' && existsSync(outputPath)) {
    captured = readFileSync(outputPath, 'utf-8');
  } else if (providerName === 'claude') {
    writeFileSync(outputPath, result.stdout, 'utf-8');
  }

  const completedAt = new Date().toISOString();
  return {
    id: runId(kind, targetId, startedAt),
    kind,
    provider: providerName,
    target_id: targetId,
    feature_id: featureId,
    dispatch_id: dispatchId,
    started_at: startedAt,
    completed_at: completedAt,
    exit_code: result.exit_code,
    result: result.exit_code === 0 ? 'success' : 'failed',
    output_path: outputPath,
    message: result.exit_code === 0
      ? `${providerName} completed ${kind} run for '${targetId}'`
      : `${providerName} failed ${kind} run for '${targetId}': ${captured || result.stderr || 'no output'}`,
  };
}

function parseToolJson<T>(toolScript: string, args: ReadonlyArray<string>, cwd: string): T {
  const raw = execFileSync('npx', ['tsx', resolveToolScriptPath(toolScript, cwd), ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return JSON.parse(raw) as T;
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

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0] as OrchestratorCommand | undefined;
  const jsonMode = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const probe = args.includes('--probe');

  if (command === undefined || !['health', 'plan', 'supervise'].includes(command)) {
    console.error('Usage: npx tsx tools/orchestrate.ts <health|plan|supervise> [args] [--dry-run] [--probe] [--json]');
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
      recent_runs: boundedRuns([...state.recent_runs, ...runs], orchestrator.recent_run_limit),
    }));
    const output: HealthResult = { checks, recent_runs: runs };
    process.stdout.write(jsonMode ? JSON.stringify(output, null, 2) + '\n' : `${checks.map((check) => `${check.provider}: ${check.available ? 'ok' : 'failed'} — ${check.message}`).join('\n')}\n`);
    process.exit(checks.every((check) => check.available) ? 0 : 1);
  }

  if (command === 'plan') {
    const intentId = args.find((arg, index) => index > 0 && !arg.startsWith('-'));
    if (intentId === undefined) {
      console.error('Usage: npx tsx tools/orchestrate.ts plan <intent-id> [--dry-run] [--json]');
      process.exit(1);
    }

    const action = parseToolJson<PlanAction>('plan.ts', [intentId, '--json'], projectRoot);
    let run: OrchestratorRunRecord | null = null;
    if (action.kind === 'plan_feature' && action.planner_assignment !== null) {
      const providerName = resolveProviderForPersona('planner', orchestrator);
      const provider = orchestrator.providers[providerName];
      if (!provider.enabled) {
        console.error(`ERROR: planner provider '${providerName}' is disabled in orchestrator config`);
        process.exit(1);
      }
      const prompt = buildPlannerPrompt(action, config);
      if (!dryRun) {
        run = invokeProvider(
          'planner',
          providerName,
          provider,
          projectRoot,
          outputDir,
          action.intent_id,
          prompt,
          action.planner_assignment.model,
          action.feature_id,
          null,
        );
      }
    }

    updateState(statePath, config, (state) => ({
      ...state,
      updated_at: new Date().toISOString(),
      updated_by: orchestrator.identity,
      cache: {
        ...state.cache,
        plan_actions: {
          ...state.cache.plan_actions,
          [action.intent_id]: {
            kind: action.kind,
            feature_id: action.feature_id,
            observed_at: new Date().toISOString(),
          },
        },
      },
      recent_runs: run === null ? state.recent_runs : boundedRuns([...state.recent_runs, run], orchestrator.recent_run_limit),
    }));

    const output: PlanResult = { action, run };
    process.stdout.write(jsonMode ? JSON.stringify(output, null, 2) + '\n' : `${action.message}\n${run !== null ? `${run.message}\n` : ''}`);
    if (run !== null && run.exit_code !== 0) {
      process.exit(run.exit_code);
    }
    return;
  }

  const featureIdx = args.indexOf('--feature');
  const featureId = featureIdx !== -1 ? args[featureIdx + 1] : undefined;
  const toolArgs = featureId !== undefined ? ['--json', '--feature', featureId] : ['--json'];
  const action = parseToolJson<SupervisorAction>('supervise.ts', toolArgs, projectRoot);
  const runs: OrchestratorRunRecord[] = [];

  if (action.kind === 'execute_feature') {
    const orderedDispatches = [...action.dispatches].sort((a, b) =>
      `${a.feature_id}:${a.packet_id}`.localeCompare(`${b.feature_id}:${b.packet_id}`),
    );
    for (const dispatch of orderedDispatches) {
      const providerName = resolveProviderForPersona(
        dispatch.persona === 'reviewer' ? 'reviewer' : 'developer',
        orchestrator,
      );
      const provider = orchestrator.providers[providerName];
      if (!provider.enabled) {
        runs.push({
          id: runId('packet', dispatch.packet_id, new Date().toISOString()),
          kind: 'packet',
          provider: providerName,
          target_id: dispatch.packet_id,
          feature_id: dispatch.feature_id,
          dispatch_id: dispatch.dispatch_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          exit_code: 1,
          result: 'failed',
          output_path: null,
          message: `Provider '${providerName}' is disabled for persona '${dispatch.persona}'`,
        });
        continue;
      }
      const prompt = buildPacketPrompt(dispatch, config, orchestrator);
      if (dryRun) {
        runs.push({
          id: runId('packet', dispatch.packet_id, new Date().toISOString()),
          kind: 'packet',
          provider: providerName,
          target_id: dispatch.packet_id,
          feature_id: dispatch.feature_id,
          dispatch_id: dispatch.dispatch_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          exit_code: 0,
          result: 'skipped',
          output_path: null,
          message: `Dry run: would invoke ${providerName} for packet '${dispatch.packet_id}'`,
        });
        continue;
      }
      runs.push(invokeProvider(
        'packet',
        providerName,
        provider,
        projectRoot,
        outputDir,
        dispatch.packet_id,
        prompt,
        dispatch.model as ModelTier,
        dispatch.feature_id,
        dispatch.dispatch_id,
      ));
    }
  }

  updateState(statePath, config, (state) => ({
    ...state,
    updated_at: new Date().toISOString(),
    updated_by: orchestrator.identity,
    cache: {
      ...state.cache,
      last_supervisor_action: {
        kind: action.kind,
        feature_ids: action.feature_ids,
        dispatch_ids: action.dispatches.map((dispatch) => dispatch.dispatch_id),
        observed_at: new Date().toISOString(),
      },
    },
    recent_runs: boundedRuns([...state.recent_runs, ...runs], orchestrator.recent_run_limit),
  }));

  const output: SuperviseResult = { action, runs };
  process.stdout.write(jsonMode ? JSON.stringify(output, null, 2) + '\n' : `${action.message}\n${runs.map((run) => run.message).join('\n')}\n`);
  const failedRun = runs.find((run) => run.exit_code !== 0 && run.result !== 'skipped');
  if (failedRun !== undefined) {
    process.exit(failedRun.exit_code);
  }
}

const isDirectExecution = process.argv[1]?.endsWith('orchestrate.ts') ||
  process.argv[1]?.endsWith('orchestrate.js');
if (isDirectExecution) {
  main();
}
