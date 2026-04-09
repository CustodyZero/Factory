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
export type OrchestratorProvider = 'codex' | 'claude';

export interface PersonaConfig {
  readonly description: string;
  readonly instructions: ReadonlyArray<string>;
  readonly model?: ModelTier;
}

export interface PersonasConfig {
  readonly planner: PersonaConfig;
  readonly developer: PersonaConfig;
  readonly reviewer: PersonaConfig;
}

export interface SupervisorConfig {
  readonly enabled: boolean;
  readonly identity: { readonly kind: string; readonly id: string };
}

export interface OrchestratorProviderConfig {
  readonly enabled: boolean;
  readonly command: string;
  readonly sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly permission_mode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
  readonly models: Readonly<Record<ModelTier, string>>;
}

export interface OrchestratorConfig {
  readonly enabled: boolean;
  readonly identity: { readonly kind: string; readonly id: string };
  readonly output_dir: string;
  readonly recent_run_limit: number;
  readonly completion_identities: {
    readonly developer: string;
    readonly reviewer: string;
  };
  readonly personas: {
    readonly planner: OrchestratorProvider;
    readonly developer: OrchestratorProvider;
    readonly reviewer: OrchestratorProvider;
  };
  readonly providers: {
    readonly codex: OrchestratorProviderConfig;
    readonly claude: OrchestratorProviderConfig;
  };
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
  readonly supervisor?: SupervisorConfig;
  readonly orchestrator?: OrchestratorConfig;
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
      reviewer: { description: 'Verifies acceptance criteria are met', instructions: [] },
    };
    const rawPersonas = (parsed as Record<string, unknown>)['personas'] as Partial<PersonasConfig> | undefined;
    const personas: PersonasConfig = {
      planner: { ...defaultPersonas.planner, ...rawPersonas?.planner },
      developer: { ...defaultPersonas.developer, ...rawPersonas?.developer },
      reviewer: { ...defaultPersonas.reviewer, ...rawPersonas?.reviewer },
    };
    const defaultOrchestrator: OrchestratorConfig = {
      enabled: true,
      identity: { kind: 'agent', id: 'orchestrator' },
      output_dir: 'reports/orchestrator',
      recent_run_limit: 25,
      completion_identities: {
        developer: 'codex-dev',
        reviewer: 'claude-qa',
      },
      personas: {
        planner: 'claude',
        developer: 'codex',
        reviewer: 'claude',
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
    };
    const rawOrchestrator = (parsed as Record<string, unknown>)['orchestrator'] as Partial<OrchestratorConfig> | undefined;
    const rawOrchestratorProviders = rawOrchestrator?.providers as Partial<OrchestratorConfig['providers']> | undefined;
    const rawOrchestratorPersonas = rawOrchestrator?.personas as Partial<OrchestratorConfig['personas']> | undefined;
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
 *
 * When factory_dir is "." (default / factory-is-the-project), returns PROJECT_ROOT.
 * When factory_dir is "factory" (submodule mode), returns PROJECT_ROOT/factory/.
 *
 * This is NOT where artifacts (packets, completions, etc.) live — use
 * resolveArtifactRoot() for that.
 */
export function resolveFactoryRoot(projectRoot?: string, config?: FactoryConfig): string {
  const root = projectRoot ?? findProjectRoot();
  const factoryDir = config?.factory_dir ?? '.';
  return factoryDir === '.' ? root : join(root, factoryDir);
}

/**
 * Resolves the artifact root (where packets, completions, features, etc. live).
 *
 * When artifact_dir is "." (default), returns PROJECT_ROOT.
 * When artifact_dir is "factory" (submodule mode), returns PROJECT_ROOT/factory/.
 *
 * Artifacts belong to the host project, not the factory tooling directory.
 * In submodule installs, artifacts consolidate under a single visible directory
 * (e.g., factory/) while tooling hides in .factory/.
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
    // Pattern ending in / matches directory prefix
    if (pattern.endsWith('/') && filepath.startsWith(pattern)) {
      return true;
    }
    // Exact filename match (for root config files)
    if (filepath === pattern) {
      return true;
    }
  }
  return false;
}
