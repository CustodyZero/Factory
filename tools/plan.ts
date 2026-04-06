#!/usr/bin/env tsx
/**
 * Factory — Planner Handoff Resolver
 *
 * Reads an intent/spec artifact and determines whether planning work is needed,
 * whether a generated feature is awaiting human approval, or whether execution
 * can hand off to the supervisor.
 *
 * Usage:
 *   npx tsx tools/plan.ts <intent-id>
 *   npx tsx tools/plan.ts <intent-id> --json
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveArtifactRoot } from './config.js';
import type { ModelTier } from './config.js';

export interface IntentArtifact {
  readonly id: string;
  readonly title: string;
  readonly spec: string;
  readonly constraints?: ReadonlyArray<string>;
  readonly status: 'proposed' | 'planned' | 'superseded' | 'delivered';
  readonly feature_id?: string | null;
}

export interface FeatureArtifact {
  readonly id: string;
  readonly status: 'draft' | 'planned' | 'approved' | 'executing' | 'completed' | 'delivered';
  readonly intent_id?: string | null;
}

export type PlanActionKind =
  | 'plan_feature'
  | 'awaiting_approval'
  | 'ready_for_execution'
  | 'all_complete'
  | 'blocked';

export interface PlannerAssignment {
  readonly intent_id: string;
  readonly persona: 'planner';
  readonly model: ModelTier;
  readonly instructions: ReadonlyArray<string>;
  readonly feature_path: string;
  readonly packets_dir: string;
  readonly spec: string;
  readonly constraints: ReadonlyArray<string>;
}

export interface PlanAction {
  readonly kind: PlanActionKind;
  readonly intent_id: string;
  readonly feature_id: string | null;
  readonly planner_assignment: PlannerAssignment | null;
  readonly command: string | null;
  readonly message: string;
}

export interface PlanInput {
  readonly intent: IntentArtifact;
  readonly features: ReadonlyArray<FeatureArtifact>;
  readonly plannerPersona?: {
    readonly instructions: ReadonlyArray<string>;
    readonly model?: ModelTier;
  };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<T>(join(dir, f)))
    .filter((x): x is T => x !== null);
}

export function resolvePlanAction(input: PlanInput): PlanAction {
  const linkedFeatures = input.features.filter((feature) => feature.intent_id === input.intent.id);

  if (linkedFeatures.length > 1) {
    return {
      kind: 'blocked',
      intent_id: input.intent.id,
      feature_id: null,
      planner_assignment: null,
      command: null,
      message: `Intent '${input.intent.id}' is linked to multiple features. Resolve the ambiguity before planning or execution.`,
    };
  }

  const linkedFeature = linkedFeatures[0] ?? null;
  const plannerInstructions = [
    ...(input.plannerPersona?.instructions ?? []),
    'Create exactly one feature artifact with status "planned".',
    'Create dev/qa packet pairs for the feature. Every dev packet must have one QA counterpart.',
    'Set packet.feature_id to the generated feature id and feature.intent_id to this intent id.',
    'Define dependencies, change classes, and acceptance criteria explicitly.',
    'Do not approve the feature and do not start execution.',
  ];

  if (linkedFeature === null) {
    return {
      kind: 'plan_feature',
      intent_id: input.intent.id,
      feature_id: input.intent.feature_id ?? null,
      planner_assignment: {
        intent_id: input.intent.id,
        persona: 'planner',
        model: input.plannerPersona?.model ?? 'opus',
        instructions: plannerInstructions,
        feature_path: `features/${input.intent.id}.json`,
        packets_dir: 'packets/',
        spec: input.intent.spec,
        constraints: input.intent.constraints ?? [],
      },
      command: null,
      message: `Intent '${input.intent.id}' is ready for planning. Create a planned feature and dev/qa packet pairs.`,
    };
  }

  if (linkedFeature.status === 'planned' || linkedFeature.status === 'draft') {
    return {
      kind: 'awaiting_approval',
      intent_id: input.intent.id,
      feature_id: linkedFeature.id,
      planner_assignment: null,
      command: null,
      message: `Intent '${input.intent.id}' has a planned feature '${linkedFeature.id}' awaiting human approval.`,
    };
  }

  if (linkedFeature.status === 'approved' || linkedFeature.status === 'executing') {
    return {
      kind: 'ready_for_execution',
      intent_id: input.intent.id,
      feature_id: linkedFeature.id,
      planner_assignment: null,
      command: `npx tsx tools/supervise.ts --json --feature ${linkedFeature.id}`,
      message: `Intent '${input.intent.id}' has approved feature '${linkedFeature.id}'. Hand off to supervisor for execution.`,
    };
  }

  return {
    kind: 'all_complete',
    intent_id: input.intent.id,
    feature_id: linkedFeature.id,
    planner_assignment: null,
    command: null,
    message: `Intent '${input.intent.id}' is linked to feature '${linkedFeature.id}' in status '${linkedFeature.status}'. No planning action required.`,
  };
}

function renderAction(action: PlanAction): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('\u2550'.repeat(59));
  lines.push('  FACTORY PLAN');
  lines.push('\u2550'.repeat(59));
  lines.push('');
  lines.push(`  Intent: ${action.intent_id}`);
  if (action.feature_id !== null) {
    lines.push(`  Feature: ${action.feature_id}`);
  }
  lines.push(`  Action: ${action.kind}`);
  lines.push('');

  if (action.planner_assignment !== null) {
    lines.push('  Planner assignment:');
    lines.push(`    - persona: ${action.planner_assignment.persona}`);
    lines.push(`    - model: ${action.planner_assignment.model}`);
    lines.push(`    - feature path: ${action.planner_assignment.feature_path}`);
    lines.push(`    - packets dir: ${action.planner_assignment.packets_dir}`);
    for (const instruction of action.planner_assignment.instructions) {
      lines.push(`    - ${instruction}`);
    }
    lines.push('');
  }

  if (action.command !== null) {
    lines.push(`  Command: ${action.command}`);
    lines.push('');
  }

  lines.push(`  ${action.message}`);
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const jsonMode = args.includes('--json');
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const intentId = positional[0];

  if (intentId === undefined) {
    console.error('Usage: npx tsx tools/plan.ts <intent-id> [--json]');
    process.exit(1);
  }

  const config = loadConfig();
  const artifactRoot = resolveArtifactRoot(undefined, config);
  const intentPath = join(artifactRoot, 'intents', `${intentId}.json`);
  if (!existsSync(intentPath)) {
    console.error(`Intent not found: ${intentPath}`);
    process.exit(1);
  }

  const intent = readJson<IntentArtifact>(intentPath);
  if (intent === null) {
    console.error(`Failed to parse intent: ${intentPath}`);
    process.exit(1);
  }

  const features = readJsonDir<FeatureArtifact>(join(artifactRoot, 'features'));
  const action = resolvePlanAction({
    intent,
    features,
    plannerPersona: config.personas.planner,
  });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(action, null, 2) + '\n');
  } else {
    process.stdout.write(renderAction(action));
  }
}

const isDirectExecution = process.argv[1]?.endsWith('plan.ts') ||
  process.argv[1]?.endsWith('plan.js');
if (isDirectExecution) {
  main();
}
