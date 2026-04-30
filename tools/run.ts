#!/usr/bin/env tsx
/**
 * Factory — Pipeline Runner
 *
 * Single entry point: takes an intent ID, runs to completion.
 *
 *   npx tsx tools/run.ts <intent-id> [--dry-run] [--json]
 *
 * Pipeline:
 *   1. Plan — decompose intent/spec into feature + dev/qa packet pairs
 *   2. Develop — for each dev packet: implement, code review, complete
 *   3. Verify — for each qa packet: verify, complete
 *   4. Done — summary of what happened
 *
 * No human gates after intent approval. Progress streams to terminal.
 * If something fails, the pipeline stops and reports what failed.
 *
 * Phase 1 of specs/single-entry-pipeline.md extracted the pure logic
 * out of this file into tools/pipeline/. What remains here is the
 * imperative orchestration (filesystem, spawnSync, lifecycle execSync)
 * that stitches those pure decisions together.
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildToolCommand,
  findProjectRoot,
  loadConfig,
  resolveArtifactRoot,
} from './config.js';
import type { FactoryConfig, ModelTier, PipelineProvider } from './config.js';
import { hydrateIntent } from './plan.js';
import type { RawIntentArtifact, IntentArtifact } from './plan.js';
import type { Feature, RawPacket } from './execute.js';
import * as fmt from './output.js';
import { topoSort } from './pipeline/topo.js';
import {
  buildDevPrompt,
  buildReviewPrompt,
  buildReworkPrompt,
  buildQaPrompt,
  buildPlannerPrompt,
} from './pipeline/prompts.js';
import {
  deriveDevResumePoint,
  nextPointAfterImplement,
  nextPointAfterReview,
  nextPointAfterRework,
  nextPointAfterFinalize,
} from './pipeline/develop_phase.js';
import type { DevResumePoint } from './pipeline/develop_phase.js';
import { resolveModelId, buildProviderArgs } from './pipeline/agent_invoke.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunResult {
  readonly intent_id: string;
  readonly feature_id: string | null;
  readonly packets_completed: string[];
  readonly packets_failed: string[];
  readonly success: boolean;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; }
  catch { return null; }
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<T>(join(dir, f)))
    .filter((x): x is T => x !== null);
}

function timestamp(): string {
  return new Date().toISOString();
}

/** Best-effort JSON patch: mutates the file in place; swallows errors. */
function patchJson(path: string, mutator: (data: Record<string, unknown>) => void): void {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    mutator(data);
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Agent invocation (I/O leaf — pure helpers live in pipeline/agent_invoke.ts)
// ---------------------------------------------------------------------------

interface InvokeResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function invokeAgent(
  provider: PipelineProvider,
  prompt: string,
  config: FactoryConfig,
  modelTier?: ModelTier,
): InvokeResult {
  const pipelineConfig = config.pipeline;
  if (pipelineConfig === undefined) {
    return { exit_code: 1, stdout: '', stderr: 'Pipeline config not found' };
  }
  const providerConfig = pipelineConfig.providers[provider];
  if (providerConfig === undefined) {
    return { exit_code: 1, stdout: '', stderr: `Provider '${provider}' not configured` };
  }
  if (!providerConfig.enabled) {
    return { exit_code: 1, stdout: '', stderr: `Provider '${provider}' is disabled` };
  }

  const modelId = modelTier ? resolveModelId(providerConfig, modelTier) : undefined;
  const { command, args } = buildProviderArgs(provider, prompt, providerConfig, modelId);
  // Copilot: prompt via stdin to avoid OS command-line length limits.
  const useStdin = provider === 'copilot';
  const result = spawnSync(command, args, {
    cwd: findProjectRoot(),
    encoding: 'utf-8',
    timeout: 600_000, // 10 min per agent
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    ...(useStdin ? { input: prompt } : {}),
  });
  return {
    exit_code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Run a factory lifecycle CLI; returns whether it exited 0. */
function runLifecycle(script: string, args: ReadonlyArray<string>, config: FactoryConfig, timeoutMs = 30_000): boolean {
  try {
    execSync(buildToolCommand(script, [...args], undefined, config), {
      cwd: findProjectRoot(), encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Pipeline phases
// ---------------------------------------------------------------------------

function planPhase(
  intent: IntentArtifact,
  config: FactoryConfig,
  artifactRoot: string,
  dryRun: boolean,
): { feature_id: string } | null {
  fmt.log('plan', `Intent: ${fmt.bold(intent.id)} — "${intent.title}"`);

  // Check if already planned
  const features = readJsonDir<{ id: string; intent_id?: string; status: string }>(join(artifactRoot, 'features'));
  const existing = features.find((f) => f.intent_id === intent.id);
  if (existing !== undefined) {
    fmt.log('plan', `Feature already exists: ${fmt.bold(existing.id)} (${existing.status})`);
    return { feature_id: existing.id };
  }

  // Build planner prompt — reference spec_path so the agent reads the file itself.
  // Do NOT inline spec contents here: it bloats the CLI invocation beyond OS limits
  // and defeats the purpose of spec_path (the agent should read the authoritative
  // source directly, not a snapshot embedded in the prompt).
  const rawIntent = readJson<RawIntentArtifact>(join(artifactRoot, 'intents', `${intent.id}.json`));
  const prompt = buildPlannerPrompt({
    intent,
    plannerInstructions: config.personas.planner.instructions,
    artifactDir: config.artifact_dir,
    specPath: rawIntent?.spec_path ?? null,
  });

  if (dryRun) {
    fmt.log('plan', `[dry-run] Would invoke planner with ${prompt.length} char prompt`);
    return null;
  }

  const provider = config.pipeline?.persona_providers.planner ?? 'claude';
  const plannerTier = config.personas.planner.model ?? 'high';
  fmt.log('plan', `Invoking ${provider} planner (${plannerTier})...`);

  const result = invokeAgent(provider, prompt, config, plannerTier);
  if (result.exit_code !== 0) {
    fmt.log('plan', fmt.error(`Planner failed (exit ${result.exit_code})`));
    if (result.stderr) fmt.log('plan', fmt.muted(result.stderr.slice(0, 500)));
    return null;
  }

  fmt.log('plan', fmt.success('Planner completed'));

  // Re-read features to find what was created
  const newFeatures = readJsonDir<{ id: string; intent_id?: string; status: string }>(join(artifactRoot, 'features'));
  const created = newFeatures.find((f) => f.intent_id === intent.id);
  if (created === undefined) {
    fmt.log('plan', fmt.error('Planner did not create a feature artifact'));
    return null;
  }

  // Update intent status (best-effort)
  patchJson(join(artifactRoot, 'intents', `${intent.id}.json`), (d) => {
    d['status'] = 'planned';
    d['feature_id'] = created.id;
    d['planned_at'] = timestamp();
  });

  fmt.log('plan', `Feature created: ${fmt.bold(created.id)}`);
  return { feature_id: created.id };
}

function devPhase(
  feature: Feature,
  config: FactoryConfig,
  artifactRoot: string,
  dryRun: boolean,
): { completed: string[]; failed: string[] } {
  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const completions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const completionIds = new Set(completions.map((c) => c.packet_id));

  const devPackets = packets.filter((p) => p.kind === 'dev' && feature.packets.includes(p.id));
  const sorted = topoSort<RawPacket>(devPackets, (p) => p.id, (p) => p.dependencies ?? []);
  const completed: string[] = [];
  const failed: string[] = [];

  fmt.log('develop', `${sorted.length} dev packet(s) to process`);

  const maxReviewIterations = config.pipeline?.max_review_iterations ?? 3;
  const devProvider = config.pipeline?.persona_providers.developer ?? 'codex';
  const devTier: ModelTier = config.personas.developer.model ?? 'high';
  const devIdentity = config.pipeline?.completion_identities.developer ?? 'codex-dev';
  const reviewProvider = config.pipeline?.persona_providers.code_reviewer ?? 'claude';
  const reviewTier: ModelTier = config.personas.code_reviewer.model ?? 'medium';

  for (const packet of sorted) {
    // Re-read packet from disk each iteration (previous agent may have changed it)
    const freshPacket = readJson<RawPacket>(join(artifactRoot, 'packets', `${packet.id}.json`)) ?? packet;
    // Re-read completions (previous packet may have just completed)
    if (!completionIds.has(packet.id) && existsSync(join(artifactRoot, 'completions', `${packet.id}.json`))) {
      completionIds.add(packet.id);
    }

    const resumePoint = deriveDevResumePoint(freshPacket, completionIds.has(packet.id));

    if (resumePoint === 'completed') {
      fmt.log('develop', `${fmt.sym.ok} ${packet.id} — already complete`);
      completed.push(packet.id);
      continue;
    }

    // Check dependencies are met before proceeding
    const deps = freshPacket.dependencies ?? [];
    const unmetDeps = deps.filter((d) => !completionIds.has(d));
    if (unmetDeps.length > 0) {
      fmt.log('develop', `${fmt.sym.blocked} ${packet.id} — blocked by: ${unmetDeps.join(', ')}`);
      failed.push(packet.id);
      continue;
    }

    fmt.log('develop', `${fmt.sym.arrow} ${fmt.bold(packet.id)} — "${freshPacket.title}" (resume: ${resumePoint})`);

    if (dryRun) {
      fmt.log('develop', `  [dry-run] Would resume from '${resumePoint}'`);
      continue;
    }

    // State machine: I/O per step, then a pure transition function from
    // pipeline/develop_phase.ts decides where to go next. `null` = failed.
    let currentPoint: DevResumePoint | null = resumePoint;

    while (currentPoint !== null && currentPoint !== 'completed') {
      switch (currentPoint) {
        case 'implement': {
          runLifecycle('start.ts', [packet.id], config); // idempotent
          fmt.log('develop', `  Implementing via ${devProvider} (${devTier})...`);
          const devResult = invokeAgent(devProvider, buildDevPrompt(freshPacket, config), config, devTier);
          const devOk = devResult.exit_code === 0;
          fmt.log('develop', devOk
            ? `  ${fmt.sym.ok} Implementation done`
            : `  ${fmt.sym.fail} ${fmt.error('Developer agent failed')}`);
          currentPoint = nextPointAfterImplement(devOk);
          break;
        }

        case 'request_review': {
          if (!runLifecycle('request-review.ts', [packet.id], config)) {
            fmt.log('develop', `  ${fmt.sym.warn} Could not request review`);
          }
          currentPoint = 'review'; // unconditional: best-effort execSync above
          break;
        }

        case 'review': {
          const iterationPacket = readJson<RawPacket>(join(artifactRoot, 'packets', `${packet.id}.json`)) ?? freshPacket;
          const reviewIteration = iterationPacket.review_iteration ?? 0;
          if (reviewIteration >= maxReviewIterations) {
            fmt.log('develop', `  ${fmt.sym.fail} Review not approved after ${maxReviewIterations} iterations`);
            currentPoint = null;
            break;
          }
          fmt.log('review', `  Review iteration ${reviewIteration + 1} via ${reviewProvider} (${reviewTier})...`);
          const reviewResult = invokeAgent(reviewProvider, buildReviewPrompt(freshPacket, config), config, reviewTier);
          if (reviewResult.exit_code !== 0) {
            fmt.log('review', `  ${fmt.sym.fail} Reviewer agent failed`);
            currentPoint = nextPointAfterReview(false, null);
            break;
          }
          const afterReview = readJson<RawPacket>(join(artifactRoot, 'packets', `${packet.id}.json`));
          const afterStatus = afterReview?.status ?? null;
          if (afterStatus === 'review_approved') {
            fmt.log('review', `  ${fmt.sym.ok} Review approved`);
          } else if (afterStatus === 'changes_requested') {
            fmt.log('review', `  ${fmt.sym.warn} Changes requested`);
          } else {
            // Reviewer didn't transition status — force approve.
            runLifecycle('review.ts', [packet.id, '--approve'], config);
            fmt.log('review', `  ${fmt.sym.ok} Review complete`);
          }
          currentPoint = nextPointAfterReview(true, afterStatus);
          break;
        }

        case 'rework': {
          fmt.log('develop', `  Reworking via ${devProvider} (${devTier})...`);
          const reworkResult = invokeAgent(devProvider, buildReworkPrompt(freshPacket, config), config, devTier);
          if (reworkResult.exit_code !== 0) fmt.log('develop', `  ${fmt.sym.fail} Rework failed`);
          currentPoint = nextPointAfterRework(reworkResult.exit_code === 0);
          break;
        }

        case 'finalize': {
          fmt.log('develop', `  Running verification...`);
          const completionOk = runLifecycle(
            'complete.ts', [packet.id, '--identity', devIdentity], config, 300_000,
          );
          if (completionOk) {
            fmt.log('develop', `  ${fmt.sym.ok} ${fmt.success('Completed')}`);
            completionIds.add(packet.id);
          } else {
            fmt.log('develop', `  ${fmt.sym.fail} Completion failed`);
          }
          currentPoint = nextPointAfterFinalize(completionOk);
          break;
        }
      }
    }

    if (currentPoint === 'completed') {
      completed.push(packet.id);
    } else {
      failed.push(packet.id);
    }
  }

  return { completed, failed };
}

function qaPhase(
  feature: Feature,
  config: FactoryConfig,
  artifactRoot: string,
  dryRun: boolean,
): { completed: string[]; failed: string[]; skipped: string[] } {
  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const completions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const completionIds = new Set(completions.map((c) => c.packet_id));

  const qaPackets = packets.filter((p) => p.kind === 'qa' && feature.packets.includes(p.id));
  const completed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  fmt.log('verify', `${qaPackets.length} QA packet(s) to process`);

  const qaProvider = config.pipeline?.persona_providers.qa ?? 'claude';
  const qaTier: ModelTier = config.personas.qa.model ?? 'medium';
  const qaIdentity = config.pipeline?.completion_identities.qa ?? 'claude-qa';

  for (const packet of qaPackets) {
    // Re-check completion on disk (previous QA may have just completed)
    if (!completionIds.has(packet.id) && existsSync(join(artifactRoot, 'completions', `${packet.id}.json`))) {
      completionIds.add(packet.id);
    }

    if (completionIds.has(packet.id)) {
      fmt.log('verify', `${fmt.sym.ok} ${packet.id} — already complete`);
      completed.push(packet.id);
      continue;
    }

    // Check that the dev packet it verifies is completed
    const deps = packet.dependencies ?? [];
    const verifies = packet.verifies;
    const allDeps = verifies && !deps.includes(verifies) ? [...deps, verifies] : [...deps];
    const unmetDeps = allDeps.filter((d) => !completionIds.has(d));
    if (unmetDeps.length > 0) {
      fmt.log('verify', `${fmt.sym.blocked} ${packet.id} — skipped (dev not complete: ${unmetDeps.join(', ')})`);
      skipped.push(packet.id);
      continue;
    }

    fmt.log('verify', `${fmt.sym.arrow} ${fmt.bold(packet.id)} — "${packet.title}"`);

    if (dryRun) {
      fmt.log('verify', `  [dry-run] Would verify and complete`);
      continue;
    }

    runLifecycle('start.ts', [packet.id], config); // idempotent

    fmt.log('verify', `  Verifying via ${qaProvider} (${qaTier})...`);
    const qaResult = invokeAgent(qaProvider, buildQaPrompt(packet, config), config, qaTier);
    if (qaResult.exit_code !== 0) {
      fmt.log('verify', `  ${fmt.sym.fail} QA agent failed`);
      failed.push(packet.id);
      continue;
    }

    fmt.log('verify', `  Running verification...`);
    if (runLifecycle('complete.ts', [packet.id, '--identity', qaIdentity], config, 300_000)) {
      fmt.log('verify', `  ${fmt.sym.ok} ${fmt.success('Completed')}`);
      completionIds.add(packet.id);
      completed.push(packet.id);
    } else {
      fmt.log('verify', `  ${fmt.sym.fail} Completion failed`);
      failed.push(packet.id);
    }
  }

  return { completed, failed, skipped };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

function failResult(intentId: string, featureId: string | null, message: string, success = false): RunResult {
  return { intent_id: intentId, feature_id: featureId, packets_completed: [], packets_failed: [], success, message };
}

function run(intentId: string, dryRun: boolean, jsonMode: boolean): RunResult {
  const config = loadConfig();
  const projectRoot = findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);

  fmt.resetTimer();
  process.stderr.write(fmt.header('RUN', `[${config.project_name}]`) + '\n\n');

  // Load intent
  const intentPath = join(artifactRoot, 'intents', `${intentId}.json`);
  if (!existsSync(intentPath)) {
    const msg = `Intent not found: ${intentId}`;
    fmt.log('error', fmt.error(msg));
    return failResult(intentId, null, msg);
  }
  const rawIntent = readJson<RawIntentArtifact>(intentPath);
  if (rawIntent === null) {
    const msg = `Failed to parse intent: ${intentId}`;
    fmt.log('error', fmt.error(msg));
    return failResult(intentId, null, msg);
  }
  const hydrated = hydrateIntent(rawIntent, projectRoot, (p) => readFileSync(p, 'utf-8'));
  if (!hydrated.ok) {
    fmt.log('error', fmt.error(hydrated.error));
    return failResult(intentId, null, hydrated.error);
  }

  // Phase 1: Plan
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('PLANNING'));
  const planResult = planPhase(hydrated.intent, config, artifactRoot, dryRun);
  if (planResult === null) {
    const msg = dryRun ? 'Dry run — planning would be invoked' : 'Planning failed';
    return failResult(intentId, null, msg, dryRun);
  }

  // Load feature
  const featurePath = join(artifactRoot, 'features', `${planResult.feature_id}.json`);
  const feature = readJson<Feature>(featurePath);
  if (feature === null) {
    const msg = `Failed to load feature: ${planResult.feature_id}`;
    fmt.log('error', fmt.error(msg));
    return failResult(intentId, planResult.feature_id, msg);
  }

  // Early exit: feature already fully done
  if (feature.status === 'completed' || feature.status === 'delivered') {
    const msg = `Feature '${feature.id}' is already ${feature.status}. Nothing to do.`;
    fmt.log('done', fmt.success(msg));
    return { intent_id: intentId, feature_id: feature.id, packets_completed: [...feature.packets], packets_failed: [], success: true, message: msg };
  }

  // Update feature status to executing (best-effort)
  patchJson(featurePath, (d) => {
    if (d['status'] === 'planned') d['status'] = 'executing';
  });

  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const featurePackets = packets.filter((p) => feature.packets.includes(p.id));
  const devCount = featurePackets.filter((p) => p.kind === 'dev').length;
  const qaCount = featurePackets.filter((p) => p.kind === 'qa').length;

  // Count what's already done
  const existingCompletions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const existingCompletionIds = new Set(existingCompletions.map((c) => c.packet_id));
  const alreadyDone = featurePackets.filter((p) => existingCompletionIds.has(p.id)).length;
  fmt.log('plan', `Feature ${fmt.bold(feature.id)}: ${devCount} dev + ${qaCount} qa packets (${alreadyDone} already complete)`);

  // Phase 2: Development
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('DEVELOPMENT'));
  const devResult = devPhase(feature, config, artifactRoot, dryRun);

  // Phase 3: QA
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('VERIFICATION'));
  const qaResult = qaPhase(feature, config, artifactRoot, dryRun);

  // Update feature status
  const allCompleted = [...devResult.completed, ...qaResult.completed];
  const allFailed = [...devResult.failed, ...qaResult.failed];
  const allSkipped = qaResult.skipped;
  if (allFailed.length === 0 && allSkipped.length === 0 && !dryRun && allCompleted.length === feature.packets.length) {
    patchJson(featurePath, (d) => {
      d['status'] = 'completed';
      d['completed_at'] = timestamp();
    });
  }

  // Summary
  process.stderr.write('\n');
  process.stderr.write(fmt.divider() + '\n');
  const success = allFailed.length === 0 && allSkipped.length === 0;
  if (success) {
    fmt.log('done', fmt.success(`All ${allCompleted.length} packet(s) completed successfully`));
  } else {
    if (allFailed.length > 0) {
      fmt.log('done', fmt.error(`${allFailed.length} packet(s) failed: ${allFailed.join(', ')}`));
    }
    if (allSkipped.length > 0) {
      fmt.log('done', fmt.warn(`${allSkipped.length} QA packet(s) skipped (dev not complete): ${allSkipped.join(', ')}`));
    }
    fmt.log('done', `${allCompleted.length} packet(s) completed`);
    fmt.log('done', fmt.info('Fix the failures and re-run to continue.'));
  }
  process.stderr.write(fmt.divider() + '\n');

  return {
    intent_id: intentId,
    feature_id: feature.id,
    packets_completed: allCompleted,
    packets_failed: allFailed,
    success,
    message: success ? `Feature '${feature.id}' completed` : `${allFailed.length} failed, ${allSkipped.length} skipped — re-run to continue`,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const positional = args.filter((a) => !a.startsWith('-'));
  const intentId = positional[0];
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  if (intentId === undefined) {
    console.error('Usage: npx tsx tools/run.ts <intent-id> [--dry-run] [--json]');
    console.error('');
    console.error('Runs the full factory pipeline for an intent:');
    console.error('  plan -> develop -> review -> verify -> done');
    process.exit(1);
  }

  const result = run(intentId, dryRun, jsonMode);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  process.exit(result.success ? 0 : 1);
}

const isDirectExecution = process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js');
if (isDirectExecution) {
  main();
}
