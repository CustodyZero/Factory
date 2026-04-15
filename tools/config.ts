/**
 * Factory configuration loader.
 *
 * Reads factory.config.json from the project root and provides
 * typed access to all configurable factory settings.
 *
 * This is the single point where project-specific settings enter
 * the factory tooling. All tools read from this config rather than
 * hardcoding commands or paths.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelTier = 'high' | 'medium' | 'low';
export type PipelineProvider = 'codex' | 'claude' | 'copilot';
export type PipelinePersona = 'planner' | 'developer' | 'code_reviewer' | 'qa';

export interface PersonaConfig {
  readonly description: string;
  readonly instructions: ReadonlyArray<string>;
  readonly model?: ModelTier;
}

export interface PersonasConfig {
  readonly planner: PersonaConfig;
  readonly developer: PersonaConfig;
  readonly code_reviewer: PersonaConfig;
  readonly qa: PersonaConfig;
}

export type ModelMap = { readonly [K in ModelTier]?: string };

export interface PipelineProviderConfig {
  readonly enabled: boolean;
  readonly command: string;
  readonly sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly permission_mode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
  readonly model_map?: ModelMap;
}

export interface PipelineConfig {
  readonly providers: {
    readonly [key: string]: PipelineProviderConfig;
  };
  readonly persona_providers: {
    readonly planner: PipelineProvider;
    readonly developer: PipelineProvider;
    readonly code_reviewer: PipelineProvider;
    readonly qa: PipelineProvider;
  };
  readonly completion_identities: {
    readonly developer: string;
    readonly code_reviewer: string;
    readonly qa: string;
  };
  readonly max_review_iterations: number;
}

export interface FactoryConfig {
  readonly project_name: string;
  readonly factory_dir: string;
  readonly artifact_dir: string;
  readonly verification: {
    readonly build: string;
    readonly lint: string;
    readonly test: string;
  };
  readonly validation: {
    readonly command: string;
  };
  readonly infrastructure_patterns: ReadonlyArray<string>;
  readonly completed_by_default: {
    readonly kind: string;
    readonly id: string;
  };
  readonly personas: PersonasConfig;
  readonly pipeline?: PipelineConfig;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Finds the project root by walking up from CWD looking for factory.config.json.
 * Returns CWD if not found (tools are likely run from project root).
 */
export function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, 'factory.config.json'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Loads factory.config.json from the project root.
 * Exits with an error if the config file is missing or invalid.
 */
export function loadConfig(projectRoot?: string): FactoryConfig {
  const root = projectRoot ?? findProjectRoot();
  const configPath = join(root, 'factory.config.json');

  if (!existsSync(configPath)) {
    console.error('ERROR: factory.config.json not found.');
    console.error('The factory has not been initialized in this project.');
    console.error('');
    console.error('To initialize, create factory.config.json at the project root.');
    console.error('See docs/integration.md for details.');
    process.exit(1);
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FactoryConfig>;
    const defaultPersonas: PersonasConfig = {
      planner: { description: 'Decomposes intent into feature and packet artifacts', instructions: [] },
      developer: { description: 'Implements the change', instructions: [] },
      code_reviewer: { description: 'Reviews code changes for correctness, design, and contract adherence', instructions: [] },
      qa: { description: 'Verifies acceptance criteria are met', instructions: [] },
    };
    const rawPersonas = (parsed as Record<string, unknown>)['personas'] as Partial<PersonasConfig> | undefined;
    const personas: PersonasConfig = {
      planner: { ...defaultPersonas.planner, ...rawPersonas?.planner },
      developer: { ...defaultPersonas.developer, ...rawPersonas?.developer },
      code_reviewer: { ...defaultPersonas.code_reviewer, ...rawPersonas?.code_reviewer },
      qa: { ...defaultPersonas.qa, ...rawPersonas?.qa },
    };

    const defaultProviders: Record<string, PipelineProviderConfig> = {
      codex: { enabled: true, command: 'codex', sandbox: 'workspace-write' },
      claude: { enabled: true, command: 'claude', permission_mode: 'bypassPermissions' },
      copilot: {
        enabled: false,
        command: 'gh copilot --',
        model_map: { high: 'claude-opus-4-6', medium: 'GPT-5.4', low: 'claude-haiku-4-5' },
      },
    };
    const defaultPipeline: PipelineConfig = {
      providers: defaultProviders,
      persona_providers: {
        planner: 'claude',
        developer: 'codex',
        code_reviewer: 'claude',
        qa: 'claude',
      },
      completion_identities: {
        developer: 'codex-dev',
        code_reviewer: 'claude-cr',
        qa: 'claude-qa',
      },
      max_review_iterations: 3,
    };
    const rawPipeline = (parsed as Record<string, unknown>)['pipeline'] as Partial<PipelineConfig> | undefined;
    const rawProviders = rawPipeline?.providers as Record<string, Partial<PipelineProviderConfig>> | undefined;
    const mergedProviders: Record<string, PipelineProviderConfig> = {};
    for (const key of new Set([...Object.keys(defaultProviders), ...Object.keys(rawProviders ?? {})])) {
      mergedProviders[key] = { ...defaultProviders[key], ...rawProviders?.[key] } as PipelineProviderConfig;
    }
    const pipeline: PipelineConfig = {
      ...defaultPipeline,
      ...rawPipeline,
      providers: mergedProviders,
      persona_providers: {
        ...defaultPipeline.persona_providers,
        ...rawPipeline?.persona_providers,
      },
      completion_identities: {
        ...defaultPipeline.completion_identities,
        ...rawPipeline?.completion_identities,
      },
    };

    return { factory_dir: '.', artifact_dir: '.', ...parsed, personas, pipeline } as FactoryConfig;
  } catch (e) {
    console.error(`ERROR: Failed to parse factory.config.json: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export function resolveToolScriptPath(script: string, projectRoot?: string, config?: FactoryConfig): string {
  const root = projectRoot ?? findProjectRoot();
  const factoryRoot = resolveFactoryRoot(root, config);
  return join(factoryRoot, 'tools', script);
}

export function buildToolCommand(
  script: string,
  args: ReadonlyArray<string> = [],
  projectRoot?: string,
  config?: FactoryConfig,
): string {
  const root = projectRoot ?? findProjectRoot();
  const resolvedConfig = config ?? loadConfig(root);
  const relativePath = resolvedConfig.factory_dir === '.'
    ? join('tools', script)
    : join(resolvedConfig.factory_dir, 'tools', script);
  return ['npx', 'tsx', relativePath, ...args].join(' ');
}

/**
 * Resolves the factory tooling root (where tools, schemas, hooks live).
 */
export function resolveFactoryRoot(projectRoot?: string, config?: FactoryConfig): string {
  const root = projectRoot ?? findProjectRoot();
  const factoryDir = config?.factory_dir ?? '.';
  return factoryDir === '.' ? root : join(root, factoryDir);
}

/**
 * Resolves the artifact root (where packets, completions, features, etc. live).
 */
export function resolveArtifactRoot(projectRoot?: string, config?: FactoryConfig): string {
  const root = projectRoot ?? findProjectRoot();
  const cfg = config ?? loadConfig(root);
  const artifactDir = cfg.artifact_dir ?? '.';
  return artifactDir === '.' ? root : join(root, artifactDir);
}

/**
 * Determines whether a file path is "infrastructure" (not implementation work).
 * Uses patterns from factory.config.json.
 */
export function isInfrastructureFile(filepath: string, config: FactoryConfig): boolean {
  for (const pattern of config.infrastructure_patterns) {
    if (pattern.endsWith('/') && filepath.startsWith(pattern)) {
      return true;
    }
    if (filepath === pattern) {
      return true;
    }
  }
  return false;
}
