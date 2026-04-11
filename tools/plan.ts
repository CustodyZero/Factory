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
import { isAbsolute, join, normalize, sep } from 'node:path';
import { buildToolCommand, findProjectRoot, loadConfig, resolveArtifactRoot } from './config.js';
import type { ModelTier } from './config.js';

/**
 * On-disk shape of an intent artifact. Either `spec` (inline body) or
 * `spec_path` (reference to a Markdown file relative to the project root)
 * must be present. Enforced by intent.schema.json and validated by
 * validate.ts / hydrateIntent.
 */
export interface RawIntentArtifact {
  readonly id: string;
  readonly title: string;
  readonly spec?: string;
  readonly spec_path?: string;
  readonly constraints?: ReadonlyArray<string>;
  readonly status: 'proposed' | 'planned' | 'superseded' | 'delivered';
  readonly feature_id?: string | null;
}

/**
 * Hydrated intent passed to the pure planner resolver. `spec` is always
 * populated with the authoritative spec body (inline or from spec_path).
 */
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
  readonly superviseCommand?: ((featureId: string) => string) | undefined;
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

// ---------------------------------------------------------------------------
// spec_path resolution + intent hydration (pure, testable)
// ---------------------------------------------------------------------------

export type ResolveSpecPathResult =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly error: string };

/**
 * Resolves an intent's `spec_path` to an absolute path under the project
 * root. Rejects empty, absolute, and traversing paths. Does not touch the
 * filesystem — callers are responsible for checking file existence.
 */
export function resolveSpecPath(projectRoot: string, specPath: string): ResolveSpecPathResult {
  if (specPath.length === 0) {
    return { ok: false, error: "'spec_path' must not be empty" };
  }
  if (isAbsolute(specPath)) {
    return { ok: false, error: `'spec_path' must be relative to the project root: '${specPath}'` };
  }
  const normalized = normalize(specPath);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    normalized.split(sep).includes('..')
  ) {
    return { ok: false, error: `'spec_path' must not escape the project root: '${specPath}'` };
  }
  return { ok: true, absolutePath: join(projectRoot, normalized) };
}

export type HydrateIntentResult =
  | { readonly ok: true; readonly intent: IntentArtifact }
  | { readonly ok: false; readonly error: string };

/**
 * Produces a hydrated IntentArtifact from a raw on-disk intent. If the raw
 * intent uses `spec_path`, the file is read through the injected reader and
 * its contents become the intent's `spec`. Enforces the mutual exclusion
 * between `spec` and `spec_path`.
 *
 * `readFile` receives the absolute resolved path and must either return the
 * file contents or throw. Injecting it keeps this function pure and testable.
 */
export function hydrateIntent(
  raw: RawIntentArtifact,
  projectRoot: string,
  readFile: (absolutePath: string) => string,
): HydrateIntentResult {
  const hasInline = typeof raw.spec === 'string' && raw.spec.length > 0;
  const hasPath = typeof raw.spec_path === 'string' && raw.spec_path.length > 0;

  if (hasInline && hasPath) {
    return { ok: false, error: `Intent '${raw.id}' declares both 'spec' and 'spec_path'. Use exactly one.` };
  }
  if (!hasInline && !hasPath) {
    return { ok: false, error: `Intent '${raw.id}' must declare either 'spec' or 'spec_path'.` };
  }

  if (hasInline) {
    return {
      ok: true,
      intent: {
        id: raw.id,
        title: raw.title,
        spec: raw.spec!,
        constraints: raw.constraints,
        status: raw.status,
        feature_id: raw.feature_id ?? null,
      },
    };
  }

  const resolved = resolveSpecPath(projectRoot, raw.spec_path!);
  if (!resolved.ok) {
    return { ok: false, error: `Intent '${raw.id}': ${resolved.error}` };
  }

  let contents: string;
  try {
    contents = readFile(resolved.absolutePath);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Intent '${raw.id}': failed to read spec_path '${raw.spec_path!}': ${message}`,
    };
  }

  if (contents.length === 0) {
    return {
      ok: false,
      error: `Intent '${raw.id}': spec_path '${raw.spec_path!}' is empty.`,
    };
  }

  return {
    ok: true,
    intent: {
      id: raw.id,
      title: raw.title,
      spec: contents,
      constraints: raw.constraints,
      status: raw.status,
      feature_id: raw.feature_id ?? null,
    },
  };
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
      command: input.superviseCommand?.(linkedFeature.id) ?? `npx tsx tools/supervise.ts --json --feature ${linkedFeature.id}`,
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
  const projectRoot = findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);
  const intentPath = join(artifactRoot, 'intents', `${intentId}.json`);
  if (!existsSync(intentPath)) {
    console.error(`Intent not found: ${intentPath}`);
    process.exit(1);
  }

  const rawIntent = readJson<RawIntentArtifact>(intentPath);
  if (rawIntent === null) {
    console.error(`Failed to parse intent: ${intentPath}`);
    process.exit(1);
  }

  const hydrated = hydrateIntent(rawIntent, projectRoot, (absolutePath) => readFileSync(absolutePath, 'utf-8'));
  if (!hydrated.ok) {
    console.error(`ERROR: ${hydrated.error}`);
    process.exit(1);
  }

  const features = readJsonDir<FeatureArtifact>(join(artifactRoot, 'features'));
  const action = resolvePlanAction({
    intent: hydrated.intent,
    features,
    plannerPersona: config.personas.planner,
    superviseCommand: (featureId) => buildToolCommand('supervise.ts', ['--json', '--feature', featureId], undefined, config),
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
