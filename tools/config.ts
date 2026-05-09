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
  /**
   * Phase 7 of single-entry-pipeline — optional within-CLI model
   * failover order for ABSTRACTION providers (those that route to
   * multiple underlying models, e.g. copilot). Each element is a
   * model id; the first is tried first, then the next on failure.
   *
   * Direct providers (codex, claude — one CLI maps to one upstream
   * provider) do NOT set this field. Absence means "on failure, fall
   * through to the next CLI in `persona_providers` without trying
   * alternate models".
   *
   * See `tools/pipeline/cascade.ts` for how the cascade is computed.
   */
  readonly model_failover?: ReadonlyArray<string>;
}

/**
 * The raw on-disk shape of a `persona_providers.<persona>` value.
 * Operators may write either a single string (legacy single-string
 * form, kept for backward compatibility) or an ordered list of
 * provider names (cross-CLI failover order).
 *
 * The loader normalizes the single-string form to a one-element
 * array; the internal `PipelineConfig` shape always sees arrays. See
 * `normalizePersonaProvider`.
 */
export type PersonaProviderRawValue = PipelineProvider | ReadonlyArray<PipelineProvider>;

/**
 * Per-scope dollar budgets (Phase 5.7).
 *
 * All three are optional; an absent field means "no cap configured"
 * — `checkCap` returns false for undefined caps so the absence of a
 * cap_caps block preserves the pre-Phase-5.7 behavior (no
 * enforcement). See docs/decisions/cost_visibility.md.
 *
 * Caps are checked with `>=` semantics: a running total at-or-above
 * the cap is "crossed" and triggers the configured escalation
 * (per-run / per-packet / per-day). Per-day uses the operator's
 * LOCAL date — see tools/cost.ts for the rationale.
 */
export interface CostCaps {
  readonly per_run?: number;
  readonly per_packet?: number;
  readonly per_day?: number;
}

/**
 * Rate-card overrides — partial map merged on top of the defaults in
 * tools/pipeline/cost.ts. Outer key is provider, inner key is model
 * id; entries replace the matching default. See `mergeRateCard`.
 */
export interface CostRateCardOverrides {
  readonly [provider: string]: {
    readonly [model: string]: {
      readonly input_per_mtok: number;
      readonly output_per_mtok: number;
    };
  };
}

export interface PipelineConfig {
  readonly providers: {
    readonly [key: string]: PipelineProviderConfig;
  };
  /**
   * Per-persona provider list. After loader normalization (see
   * `normalizePersonaProvider`), each persona maps to a non-empty
   * `ReadonlyArray<PipelineProvider>`:
   *
   *   - Index 0 is the primary CLI for the persona.
   *   - Subsequent entries form the cross-CLI failover order.
   *
   * The on-disk shape may be a single string (legacy form); the
   * loader normalizes single strings to a one-element array so
   * internal callers always see arrays. The shape is enforced at
   * load time; downstream code does NOT branch on string vs array.
   */
  readonly persona_providers: {
    readonly planner: ReadonlyArray<PipelineProvider>;
    readonly developer: ReadonlyArray<PipelineProvider>;
    readonly code_reviewer: ReadonlyArray<PipelineProvider>;
    readonly qa: ReadonlyArray<PipelineProvider>;
  };
  readonly completion_identities: {
    readonly developer: string;
    readonly code_reviewer: string;
    readonly qa: string;
  };
  readonly max_review_iterations: number;
  /**
   * Phase 5.7 — optional dollar caps per scope. Absent = disabled
   * (no enforcement). Defaults are NOT supplied; the operator opts
   * in by writing this block.
   */
  readonly cost_caps?: CostCaps;
  /**
   * Phase 5.7 — optional rate-card overrides. Partial map; missing
   * entries fall through to DEFAULT_RATE_CARD in
   * tools/pipeline/cost.ts.
   */
  readonly rate_card?: CostRateCardOverrides;
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
 * Phase 7 — normalize a `persona_providers.<persona>` raw value
 * (string | string[] | undefined) to a non-empty
 * `ReadonlyArray<PipelineProvider>`.
 *
 *   - `undefined`           -> `defaults` (already a non-empty array)
 *   - `"<provider>"`        -> `["<provider>"]`
 *   - `["<a>", "<b>", ...]` -> the array as-is (frozen)
 *
 * The empty-array case (`[]`) is rejected: it would mean "this
 * persona has no provider," which the rest of the pipeline cannot
 * handle. We fall back to `defaults` rather than crash so a
 * misconfigured file still loads. (Honest behavior per CLAUDE.md
 * §3.5: a real validation pass — Phase 4.6 ajv check or the next
 * call to `validate.ts` — surfaces the misconfiguration; the loader
 * does not silently invent a value beyond falling back to the
 * documented default.)
 *
 * Exported for unit tests and for the cascade-computation module.
 */
export function normalizePersonaProvider(
  raw: PersonaProviderRawValue | undefined,
  defaults: ReadonlyArray<PipelineProvider>,
): ReadonlyArray<PipelineProvider> {
  if (raw === undefined) return defaults;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.length > 0) return raw;
  return defaults;
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
        planner: ['claude'],
        developer: ['codex'],
        code_reviewer: ['claude'],
        qa: ['claude'],
      },
      completion_identities: {
        developer: 'codex-dev',
        code_reviewer: 'claude-cr',
        qa: 'claude-qa',
      },
      max_review_iterations: 3,
    };
    // The on-disk shape of `pipeline` may use the legacy single-string
    // form for `persona_providers.<persona>`. We type the raw view
    // permissively here and normalize below; the resulting
    // `PipelineConfig` always carries arrays (see `normalizePersonaProvider`).
    const rawPipeline = (parsed as Record<string, unknown>)['pipeline'] as
      | (Omit<Partial<PipelineConfig>, 'persona_providers'> & {
          readonly persona_providers?: Partial<{
            readonly planner: PersonaProviderRawValue;
            readonly developer: PersonaProviderRawValue;
            readonly code_reviewer: PersonaProviderRawValue;
            readonly qa: PersonaProviderRawValue;
          }>;
        })
      | undefined;
    const rawProviders = rawPipeline?.providers as Record<string, Partial<PipelineProviderConfig>> | undefined;
    const mergedProviders: Record<string, PipelineProviderConfig> = {};
    for (const key of new Set([...Object.keys(defaultProviders), ...Object.keys(rawProviders ?? {})])) {
      mergedProviders[key] = { ...defaultProviders[key], ...rawProviders?.[key] } as PipelineProviderConfig;
    }
    // Phase 5.7: cost_caps and rate_card pass through unchanged from
    // the raw config. Both are optional and have no defaults — absent
    // means "no enforcement / fall through to DEFAULT_RATE_CARD". The
    // shape narrowing is handled by the TypeScript types; we only
    // forward whatever the user wrote (or nothing).
    const rawCostCaps = rawPipeline?.cost_caps;
    const rawRateCard = rawPipeline?.rate_card;

    // Phase 7 — normalize persona_providers entries from
    // (string | string[]) on disk to ReadonlyArray<PipelineProvider>
    // internally. Defaults already use the array form. Any persona
    // missing from the raw config falls through to the default.
    const rawPersonaProviders = rawPipeline?.persona_providers ?? {};
    const personaProviders = {
      planner: normalizePersonaProvider(
        rawPersonaProviders.planner,
        defaultPipeline.persona_providers.planner,
      ),
      developer: normalizePersonaProvider(
        rawPersonaProviders.developer,
        defaultPipeline.persona_providers.developer,
      ),
      code_reviewer: normalizePersonaProvider(
        rawPersonaProviders.code_reviewer,
        defaultPipeline.persona_providers.code_reviewer,
      ),
      qa: normalizePersonaProvider(
        rawPersonaProviders.qa,
        defaultPipeline.persona_providers.qa,
      ),
    };
    const pipeline: PipelineConfig = {
      ...defaultPipeline,
      ...rawPipeline,
      providers: mergedProviders,
      persona_providers: personaProviders,
      completion_identities: {
        ...defaultPipeline.completion_identities,
        ...rawPipeline?.completion_identities,
      },
      ...(rawCostCaps !== undefined ? { cost_caps: rawCostCaps } : {}),
      ...(rawRateCard !== undefined ? { rate_card: rawRateCard } : {}),
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
