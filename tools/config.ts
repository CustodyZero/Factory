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

export type ModelTier = 'opus' | 'sonnet' | 'haiku';
export type OrchestratorProvider = 'codex' | 'claude' | 'copilot';
export type OrchestratorPersona = 'planner' | 'developer' | 'code_reviewer' | 'qa';

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

export interface PipelineProviderConfig {
  readonly enabled: boolean;
  readonly command: string;
  readonly sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly permission_mode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
}

export interface OrchestratorRetryStep {
  readonly provider: OrchestratorProvider;
  readonly model: ModelTier;
}

export interface OrchestratorRetryConfig {
  readonly max_supervisor_ticks: number;
  readonly max_transient_retries: number;
  readonly planner: ReadonlyArray<OrchestratorRetryStep>;
  readonly developer: ReadonlyArray<OrchestratorRetryStep>;
  readonly code_reviewer: ReadonlyArray<OrchestratorRetryStep>;
  readonly qa: ReadonlyArray<OrchestratorRetryStep>;
}

export interface OrchestratorConfig {
  readonly enabled: boolean;
  readonly identity: { readonly kind: string; readonly id: string };
  readonly output_dir: string;
  readonly recent_run_limit: number;
  readonly recent_attempt_limit: number;
  readonly completion_identities: {
    readonly developer: string;
    readonly code_reviewer: string;
    readonly qa: string;
  };
  readonly personas: {
    readonly planner: OrchestratorProvider;
    readonly developer: OrchestratorProvider;
    readonly code_reviewer: OrchestratorProvider;
    readonly qa: OrchestratorProvider;
  };
  readonly providers: {
    readonly codex: OrchestratorProviderConfig;
    readonly claude: OrchestratorProviderConfig;
    readonly copilot: OrchestratorProviderConfig;
  };
  readonly retries: OrchestratorRetryConfig;
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

    const defaultPipeline: PipelineConfig = {
      providers: {
        codex: { enabled: true, command: 'codex', sandbox: 'workspace-write' },
        claude: { enabled: true, command: 'claude', permission_mode: 'bypassPermissions' },
      },
      persona_providers: {
        planner: 'claude',
        developer: 'codex',
        code_reviewer: 'claude',
        qa: 'claude',
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
        copilot: {
          enabled: false,
          command: 'gh',
          models: {
            opus: 'gpt-5',
            sonnet: 'gpt-5-mini',
            haiku: 'gpt-5-mini',
          },
        },
      },
      retries: {
        max_supervisor_ticks: 50,
        max_transient_retries: 2,
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
        code_reviewer: [
          { provider: 'claude', model: 'sonnet' },
          { provider: 'claude', model: 'opus' },
          { provider: 'codex', model: 'opus' },
        ],
        qa: [
          { provider: 'claude', model: 'sonnet' },
          { provider: 'claude', model: 'opus' },
          { provider: 'codex', model: 'opus' },
        ],
      },
    };
    const rawOrchestrator = (parsed as Record<string, unknown>)['orchestrator'] as Partial<OrchestratorConfig> | undefined;
    const rawOrchestratorProviders = rawOrchestrator?.providers as Partial<OrchestratorConfig['providers']> | undefined;
    const rawOrchestratorPersonas = rawOrchestrator?.personas as Partial<OrchestratorConfig['personas']> | undefined;
    const rawOrchestratorRetries = rawOrchestrator?.retries as Partial<OrchestratorRetryConfig> | undefined;
    const orchestrator: OrchestratorConfig = {
      ...defaultOrchestrator,
      ...rawOrchestrator,
      personas: {
        ...defaultOrchestrator.personas,
        ...rawOrchestratorPersonas,
      },
      providers: {
        codex: {
          ...defaultOrchestrator.providers.codex,
          ...rawOrchestratorProviders?.codex,
          models: {
            ...defaultOrchestrator.providers.codex.models,
            ...rawOrchestratorProviders?.codex?.models,
          },
        },
        claude: {
          ...defaultOrchestrator.providers.claude,
          ...rawOrchestratorProviders?.claude,
          models: {
            ...defaultOrchestrator.providers.claude.models,
            ...rawOrchestratorProviders?.claude?.models,
          },
        },
        copilot: {
          ...defaultOrchestrator.providers.copilot,
          ...(rawOrchestratorProviders as Record<string, unknown> | undefined)?.['copilot'] as Partial<OrchestratorProviderConfig> | undefined,
          models: {
            ...defaultOrchestrator.providers.copilot.models,
            ...((rawOrchestratorProviders as Record<string, unknown> | undefined)?.['copilot'] as Partial<OrchestratorProviderConfig> | undefined)?.models,
          },
        },
      },
      retries: {
        ...defaultOrchestrator.retries,
        ...rawOrchestratorRetries,
        planner: rawOrchestratorRetries?.planner ?? defaultOrchestrator.retries.planner,
        developer: rawOrchestratorRetries?.developer ?? defaultOrchestrator.retries.developer,
        code_reviewer: rawOrchestratorRetries?.code_reviewer ?? defaultOrchestrator.retries.code_reviewer,
        qa: rawOrchestratorRetries?.qa ?? defaultOrchestrator.retries.qa,
      },
    };
    return { factory_dir: '.', artifact_dir: '.', ...parsed, personas, orchestrator } as FactoryConfig;
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
