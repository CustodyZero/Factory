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
import { hydrateIntent, resolvePlanAction } from './plan.js';
import type { RawIntentArtifact, IntentArtifact, PlannerAssignment } from './plan.js';
import { resolveExecuteAction } from './execute.js';
import type { Feature, RawPacket, PacketAssignment } from './execute.js';
import * as fmt from './output.js';

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

// ---------------------------------------------------------------------------
// Agent invocation
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
): InvokeResult {
  const pipelineConfig = config.pipeline;
  if (pipelineConfig === undefined) {
    return { exit_code: 1, stdout: '', stderr: 'Pipeline config not found' };
  }

  const providerConfig = pipelineConfig.providers[provider];
  if (!providerConfig.enabled) {
    return { exit_code: 1, stdout: '', stderr: `Provider '${provider}' is disabled` };
  }

  const command = providerConfig.command;
  const args: string[] = [];

  if (provider === 'claude') {
    args.push('--print', '--dangerously-skip-permissions');
    args.push(prompt);
  } else if (provider === 'codex') {
    args.push('--quiet', '--full-auto');
    args.push(prompt);
  }

  const result = spawnSync(command, args, {
    cwd: findProjectRoot(),
    encoding: 'utf-8',
    timeout: 600_000, // 10 min per agent
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  return {
    exit_code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
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

  // Build planner prompt
  const plannerPersona = config.personas.planner;
  const constraints = (intent.constraints ?? []).map((c) => `- ${c}`).join('\n');
  const prompt = [
    `You are a planner. Decompose this intent into a feature with dev/qa packet pairs.`,
    ``,
    `## Intent: ${intent.id}`,
    `Title: ${intent.title}`,
    ``,
    `## Spec`,
    intent.spec,
    ``,
    constraints.length > 0 ? `## Constraints\n${constraints}\n` : '',
    `## Instructions`,
    ...plannerPersona.instructions,
    ``,
    `## Output`,
    `Create the following files under the factory artifact directory (${config.artifact_dir}):`,
    `1. features/${intent.id}.json — feature artifact with status "planned"`,
    `   - Set intent_id to "${intent.id}"`,
    `   - Set packets array with all dev and qa packet IDs`,
    `2. packets/<packet-id>.json — one dev packet per logical work unit`,
    `3. packets/<packet-id>-qa.json — one qa packet per dev packet (kind: "qa", verifies: "<dev-packet-id>")`,
    ``,
    `Every dev packet must have a QA counterpart. Set dependencies between packets where needed.`,
    `Set feature_id on each packet. Use kebab-case IDs.`,
  ].filter(Boolean).join('\n');

  if (dryRun) {
    fmt.log('plan', `[dry-run] Would invoke planner with ${prompt.length} char prompt`);
    return null;
  }

  const provider = config.pipeline?.persona_providers.planner ?? 'claude';
  fmt.log('plan', `Invoking ${provider} planner...`);

  const result = invokeAgent(provider, prompt, config);
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

  // Update intent status
  const intentPath = join(artifactRoot, 'intents', `${intent.id}.json`);
  try {
    const intentData = JSON.parse(readFileSync(intentPath, 'utf-8')) as Record<string, unknown>;
    intentData['status'] = 'planned';
    intentData['feature_id'] = created.id;
    intentData['planned_at'] = timestamp();
    writeFileSync(intentPath, JSON.stringify(intentData, null, 2) + '\n', 'utf-8');
  } catch { /* best-effort */ }

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
  const completed: string[] = [];
  const failed: string[] = [];

  fmt.log('develop', `${devPackets.length} dev packet(s) to process`);

  const maxReviewIterations = config.pipeline?.max_review_iterations ?? 3;

  for (const packet of devPackets) {
    if (completionIds.has(packet.id)) {
      fmt.log('develop', `${fmt.sym.ok} ${packet.id} — already complete`);
      completed.push(packet.id);
      continue;
    }

    fmt.log('develop', `${fmt.sym.arrow} ${fmt.bold(packet.id)} — "${packet.title}"`);

    if (dryRun) {
      fmt.log('develop', `  [dry-run] Would implement, review, and complete`);
      continue;
    }

    // Start packet
    try {
      execSync(buildToolCommand('start.ts', [packet.id], undefined, config), {
        cwd: findProjectRoot(), encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* idempotent */ }

    // Invoke developer
    const devProvider = config.pipeline?.persona_providers.developer ?? 'codex';
    const devIdentity = config.pipeline?.completion_identities.developer ?? 'codex-dev';
    const devPrompt = buildDevPrompt(packet, config);

    fmt.log('develop', `  Implementing via ${devProvider}...`);
    const devResult = invokeAgent(devProvider, devPrompt, config);
    if (devResult.exit_code !== 0) {
      fmt.log('develop', `  ${fmt.sym.fail} ${fmt.error('Developer agent failed')}`);
      failed.push(packet.id);
      continue;
    }
    fmt.log('develop', `  ${fmt.sym.ok} Implementation done`);

    // Request review
    try {
      execSync(buildToolCommand('request-review.ts', [packet.id], undefined, config), {
        cwd: findProjectRoot(), encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      fmt.log('develop', `  ${fmt.sym.warn} Could not request review: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Code review loop
    const reviewProvider = config.pipeline?.persona_providers.code_reviewer ?? 'claude';
    let reviewIteration = 0;
    let approved = false;

    while (reviewIteration < maxReviewIterations && !approved) {
      fmt.log('review', `  Review iteration ${reviewIteration + 1} via ${reviewProvider}...`);
      const reviewPrompt = buildReviewPrompt(packet, config);
      const reviewResult = invokeAgent(reviewProvider, reviewPrompt, config);

      if (reviewResult.exit_code !== 0) {
        fmt.log('review', `  ${fmt.sym.fail} Reviewer agent failed`);
        break;
      }

      // Check packet status after review
      const updatedPacket = readJson<RawPacket>(join(artifactRoot, 'packets', `${packet.id}.json`));
      const status = updatedPacket?.status ?? null;

      if (status === 'review_approved') {
        approved = true;
        fmt.log('review', `  ${fmt.sym.ok} Review approved`);
      } else if (status === 'changes_requested') {
        fmt.log('review', `  ${fmt.sym.warn} Changes requested — reworking...`);
        reviewIteration++;

        // Rework
        const reworkResult = invokeAgent(devProvider, buildReworkPrompt(packet, config), config);
        if (reworkResult.exit_code !== 0) {
          fmt.log('develop', `  ${fmt.sym.fail} Rework failed`);
          break;
        }

        // Re-request review
        try {
          execSync(buildToolCommand('request-review.ts', [packet.id], undefined, config), {
            cwd: findProjectRoot(), encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch { /* best-effort */ }
      } else {
        // Review didn't transition the status — assume approved
        try {
          execSync(buildToolCommand('review.ts', [packet.id, '--approve'], undefined, config), {
            cwd: findProjectRoot(), encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch { /* best-effort */ }
        approved = true;
        fmt.log('review', `  ${fmt.sym.ok} Review complete`);
      }
    }

    if (!approved) {
      fmt.log('develop', `  ${fmt.sym.fail} Review not approved after ${maxReviewIterations} iterations`);
      failed.push(packet.id);
      continue;
    }

    // Complete
    fmt.log('develop', `  Running verification...`);
    try {
      execSync(
        buildToolCommand('complete.ts', [packet.id, '--identity', devIdentity], undefined, config),
        { cwd: findProjectRoot(), encoding: 'utf-8', timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      fmt.log('develop', `  ${fmt.sym.ok} ${fmt.success('Completed')}`);
      completed.push(packet.id);
    } catch {
      fmt.log('develop', `  ${fmt.sym.fail} Completion failed`);
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
): { completed: string[]; failed: string[] } {
  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const completions = readJsonDir<{ packet_id: string }>(join(artifactRoot, 'completions'));
  const completionIds = new Set(completions.map((c) => c.packet_id));

  const qaPackets = packets.filter((p) => p.kind === 'qa' && feature.packets.includes(p.id));
  const completed: string[] = [];
  const failed: string[] = [];

  fmt.log('verify', `${qaPackets.length} QA packet(s) to process`);

  for (const packet of qaPackets) {
    if (completionIds.has(packet.id)) {
      fmt.log('verify', `${fmt.sym.ok} ${packet.id} — already complete`);
      completed.push(packet.id);
      continue;
    }

    fmt.log('verify', `${fmt.sym.arrow} ${fmt.bold(packet.id)} — "${packet.title}"`);

    if (dryRun) {
      fmt.log('verify', `  [dry-run] Would verify and complete`);
      continue;
    }

    // Start
    try {
      execSync(buildToolCommand('start.ts', [packet.id], undefined, config), {
        cwd: findProjectRoot(), encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* idempotent */ }

    // Invoke QA
    const qaProvider = config.pipeline?.persona_providers.qa ?? 'claude';
    const qaIdentity = config.pipeline?.completion_identities.qa ?? 'claude-qa';
    const qaPrompt = buildQaPrompt(packet, config);

    fmt.log('verify', `  Verifying via ${qaProvider}...`);
    const qaResult = invokeAgent(qaProvider, qaPrompt, config);
    if (qaResult.exit_code !== 0) {
      fmt.log('verify', `  ${fmt.sym.fail} QA agent failed`);
      failed.push(packet.id);
      continue;
    }

    // Complete
    fmt.log('verify', `  Running verification...`);
    try {
      execSync(
        buildToolCommand('complete.ts', [packet.id, '--identity', qaIdentity], undefined, config),
        { cwd: findProjectRoot(), encoding: 'utf-8', timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      fmt.log('verify', `  ${fmt.sym.ok} ${fmt.success('Completed')}`);
      completed.push(packet.id);
    } catch {
      fmt.log('verify', `  ${fmt.sym.fail} Completion failed`);
      failed.push(packet.id);
    }
  }

  return { completed, failed };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildDevPrompt(packet: RawPacket, config: FactoryConfig): string {
  const personaInstructions = config.personas.developer.instructions;
  const packetInstructions = packet.instructions ?? [];
  const criteria = packet.acceptance_criteria ?? [];
  return [
    `You are a developer implementing a work packet.`,
    ``,
    `## Packet: ${packet.id}`,
    `Title: ${packet.title}`,
    `Intent: ${(packet as Record<string, unknown>)['intent'] ?? 'See packet for details'}`,
    ``,
    criteria.length > 0 ? `## Acceptance Criteria\n${criteria.map((c) => `- ${c}`).join('\n')}\n` : '',
    personaInstructions.length > 0 ? `## Instructions\n${personaInstructions.join('\n')}\n` : '',
    packetInstructions.length > 0 ? `## Packet Instructions\n${packetInstructions.join('\n')}\n` : '',
    `After implementing, the pipeline will request a code review automatically.`,
    `Do not call request-review.ts or complete.ts yourself.`,
  ].filter(Boolean).join('\n');
}

function buildReviewPrompt(packet: RawPacket, config: FactoryConfig): string {
  const personaInstructions = config.personas.code_reviewer.instructions;
  const criteria = packet.acceptance_criteria ?? [];
  return [
    `You are a code reviewer. Review the implementation for packet "${packet.id}".`,
    ``,
    `Title: ${packet.title}`,
    criteria.length > 0 ? `## Acceptance Criteria\n${criteria.map((c) => `- ${c}`).join('\n')}\n` : '',
    personaInstructions.length > 0 ? `## Instructions\n${personaInstructions.join('\n')}\n` : '',
    `Review the code changes. If acceptable, run: npx tsx ${config.factory_dir}/tools/review.ts ${packet.id} --approve`,
    `If changes needed, run: npx tsx ${config.factory_dir}/tools/review.ts ${packet.id} --request-changes`,
  ].filter(Boolean).join('\n');
}

function buildReworkPrompt(packet: RawPacket, config: FactoryConfig): string {
  return [
    `You are a developer. Your code review for packet "${packet.id}" requested changes.`,
    `Address the review feedback and fix the issues.`,
    `Do not call request-review.ts or complete.ts yourself.`,
  ].join('\n');
}

function buildQaPrompt(packet: RawPacket, config: FactoryConfig): string {
  const personaInstructions = config.personas.qa.instructions;
  const criteria = packet.acceptance_criteria ?? [];
  return [
    `You are a QA engineer verifying packet "${packet.id}".`,
    ``,
    `Title: ${packet.title}`,
    `Verifies: ${packet.verifies ?? 'unknown'}`,
    criteria.length > 0 ? `## Acceptance Criteria\n${criteria.map((c) => `- ${c}`).join('\n')}\n` : '',
    personaInstructions.length > 0 ? `## Instructions\n${personaInstructions.join('\n')}\n` : '',
    `Verify the acceptance criteria are met. Run tests. Check the implementation.`,
    `Do not call complete.ts yourself — the pipeline handles that.`,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

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
    return { intent_id: intentId, feature_id: null, packets_completed: [], packets_failed: [], success: false, message: msg };
  }

  const rawIntent = readJson<RawIntentArtifact>(intentPath);
  if (rawIntent === null) {
    const msg = `Failed to parse intent: ${intentId}`;
    fmt.log('error', fmt.error(msg));
    return { intent_id: intentId, feature_id: null, packets_completed: [], packets_failed: [], success: false, message: msg };
  }

  const hydrated = hydrateIntent(rawIntent, projectRoot, (p) => readFileSync(p, 'utf-8'));
  if (!hydrated.ok) {
    fmt.log('error', fmt.error(hydrated.error));
    return { intent_id: intentId, feature_id: null, packets_completed: [], packets_failed: [], success: false, message: hydrated.error };
  }

  // Phase 1: Plan
  process.stderr.write('\n');
  fmt.log('phase', fmt.bold('PLANNING'));
  const planResult = planPhase(hydrated.intent, config, artifactRoot, dryRun);
  if (planResult === null) {
    const msg = dryRun ? 'Dry run — planning would be invoked' : 'Planning failed';
    return { intent_id: intentId, feature_id: null, packets_completed: [], packets_failed: [], success: dryRun, message: msg };
  }

  // Load feature
  const featurePath = join(artifactRoot, 'features', `${planResult.feature_id}.json`);
  const feature = readJson<Feature>(featurePath);
  if (feature === null) {
    const msg = `Failed to load feature: ${planResult.feature_id}`;
    fmt.log('error', fmt.error(msg));
    return { intent_id: intentId, feature_id: planResult.feature_id, packets_completed: [], packets_failed: [], success: false, message: msg };
  }

  // Update feature status to executing
  try {
    const featureData = JSON.parse(readFileSync(featurePath, 'utf-8')) as Record<string, unknown>;
    if (featureData['status'] === 'planned') {
      featureData['status'] = 'executing';
      writeFileSync(featurePath, JSON.stringify(featureData, null, 2) + '\n', 'utf-8');
    }
  } catch { /* best-effort */ }

  const packets = readJsonDir<RawPacket>(join(artifactRoot, 'packets'));
  const featurePackets = packets.filter((p) => feature.packets.includes(p.id));
  const devCount = featurePackets.filter((p) => p.kind === 'dev').length;
  const qaCount = featurePackets.filter((p) => p.kind === 'qa').length;
  fmt.log('plan', `Feature ${fmt.bold(feature.id)}: ${devCount} dev + ${qaCount} qa packets`);

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
  if (allFailed.length === 0 && !dryRun && allCompleted.length === feature.packets.length) {
    try {
      const featureData = JSON.parse(readFileSync(featurePath, 'utf-8')) as Record<string, unknown>;
      featureData['status'] = 'completed';
      writeFileSync(featurePath, JSON.stringify(featureData, null, 2) + '\n', 'utf-8');
    } catch { /* best-effort */ }
  }

  // Summary
  process.stderr.write('\n');
  process.stderr.write(fmt.divider() + '\n');
  const success = allFailed.length === 0;
  if (success) {
    fmt.log('done', fmt.success(`All ${allCompleted.length} packet(s) completed successfully`));
  } else {
    fmt.log('done', fmt.error(`${allFailed.length} packet(s) failed: ${allFailed.join(', ')}`));
    fmt.log('done', fmt.success(`${allCompleted.length} packet(s) completed`));
  }
  process.stderr.write(fmt.divider() + '\n');

  return {
    intent_id: intentId,
    feature_id: feature.id,
    packets_completed: allCompleted,
    packets_failed: allFailed,
    success,
    message: success ? `Feature '${feature.id}' completed` : `${allFailed.length} packet(s) failed`,
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
