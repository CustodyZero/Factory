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

export interface PersonaConfig {
  readonly description: string;
  readonly instructions: ReadonlyArray<string>;
  readonly model?: ModelTier;
}

export interface PersonasConfig {
  readonly developer: PersonaConfig;
  readonly reviewer: PersonaConfig;
}

export interface SupervisorConfig {
  readonly enabled: boolean;
  readonly identity: { readonly kind: string; readonly id: string };
}

export interface FactoryConfig {
  readonly project_name: string;
  readonly factory_dir: string;
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
      developer: { description: 'Implements the change', instructions: [] },
      reviewer: { description: 'Verifies acceptance criteria are met', instructions: [] },
    };
    const rawPersonas = (parsed as Record<string, unknown>)['personas'] as Partial<PersonasConfig> | undefined;
    const personas: PersonasConfig = {
      developer: { ...defaultPersonas.developer, ...rawPersonas?.developer },
      reviewer: { ...defaultPersonas.reviewer, ...rawPersonas?.reviewer },
    };
    return { factory_dir: '.', ...parsed, personas } as FactoryConfig;
  } catch (e) {
    console.error(`ERROR: Failed to parse factory.config.json: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
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
 * Always returns PROJECT_ROOT. Artifacts belong to the host project, not the
 * factory tooling directory. When Factory is a git submodule, the submodule
 * is read-only tooling; artifacts live alongside factory.config.json.
 */
export function resolveArtifactRoot(projectRoot?: string): string {
  return projectRoot ?? findProjectRoot();
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
