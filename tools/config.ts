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
  /**
   * The provider executable. After loader normalization (see
   * `normalizeProviderCommand`), this is always a single argv token —
   * either a bare executable name resolved against `PATH` (`"gh"`,
   * `"codex"`, `"claude"`) or an absolute path that may contain
   * whitespace (e.g. `"/Applications/Tool With Space/bin/codex"`).
   * Internal whitespace is preserved as part of the path; it is NOT
   * tokenized.
   *
   * Legacy shape (DEP0190 migration): the on-disk `command` may be a
   * bare name encoding leading argv as a single whitespace-separated
   * string (e.g. `"gh copilot --"`). The loader detects this case —
   * keyed on the absence of a path separator (`/`) plus presence of
   * internal whitespace — whitespace-splits it once, normalizes to
   * the split shape, and emits a deprecation warning. A `command`
   * containing `/` is always a path and is preserved as one argv
   * token regardless of internal whitespace. Downstream code only
   * ever sees the split shape.
   */
  readonly command: string;
  /**
   * DEP0190 shell removal — optional fixed leading argv elements
   * prepended to every invocation (before the per-provider suffix
   * flags). Used when a provider CLI requires sub-command-style
   * invocation (e.g. `"gh copilot --"` splits into command=`"gh"` +
   * prefix_args=`["copilot", "--"]`). When absent, the per-provider
   * argv is built from the suffix flags alone.
   *
   * Each element is a literal argv token — no shell tokenization,
   * no whitespace splitting. The legacy single-string `command`
   * shape is still accepted at the loader boundary (with a
   * deprecation warning) but is normalized into this field before
   * any consumer sees it.
   */
  readonly prefix_args?: ReadonlyArray<string>;
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
  /**
   * Optional heartbeat cadence in milliseconds for long-running agent
   * invocations (planner / developer / reviewer / qa). The first
   * heartbeat fires after this many milliseconds of the child still
   * running, then every interval after.
   *
   * Absent (or undefined) => 30000 ms (preserves the
   * pre-configurable behavior; HEARTBEAT_INTERVAL_DEFAULT_MS in
   * tools/pipeline/agent_invoke.ts is the load-bearing default).
   *
   * Minimum: 1000 (1 s). The schema enforces the floor; the loader
   * does not silently coerce — operators who write a smaller value
   * see a validation error from validate.ts.
   */
  readonly heartbeat_interval_ms?: number;
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
 * DEP0190 shell removal — emit a single console.warn naming every
 * provider that used the legacy whitespace-in-`command` shape during
 * the current `loadConfig` call.
 *
 * The contract is "once per load, not once per provider per call":
 * a config with multiple legacy-shape providers triggers ONE
 * console.warn line listing them all. Repeated `loadConfig` calls
 * each emit their own warning (the operator may have changed the
 * file between calls); this is per-call, not per-process.
 *
 * Exported for unit tests that want to assert the exact message
 * shape — not for direct use by other tools (which should rely on
 * `loadConfig` doing this automatically).
 */
export function emitLegacyShapeWarning(
  legacyShapeProviders: ReadonlyArray<{ name: string; rawCommand: string }>,
): void {
  // The message is shaped for an operator scanning their terminal.
  // It must name the provider and the legacy value so the operator
  // can find it in their config, and it must point at the migration
  // target (specs/dep0190-shell-removal.md) so they know where to
  // read more.
  const entries = legacyShapeProviders
    .map((p) => `'${p.name}' uses legacy shell-tokenized command ${JSON.stringify(p.rawCommand)}`)
    .join('; ');
  const example = legacyShapeProviders[0]!;
  const exampleTokens = example.rawCommand.split(/[ \t]+/).filter((t) => t.length > 0);
  const migrationHint = exampleTokens.length > 1
    ? `Migrate to command: ${JSON.stringify(exampleTokens[0])}, prefix_args: ${JSON.stringify(exampleTokens.slice(1))}.`
    : `Migrate to command: ${JSON.stringify(exampleTokens[0] ?? example.rawCommand)}, prefix_args: [<tokens>].`;
  console.warn(
    `[factory] DEP0190: ${entries}. ${migrationHint} ` +
    `See specs/dep0190-shell-removal.md.`,
  );
}

/**
 * DEP0190 shell removal — normalize a raw provider config to the new
 * shape (single-token `command` + optional `prefix_args` array).
 *
 * Accepts BOTH on-disk shapes. The two are disambiguated by whether
 * `command` contains a path separator (`/`):
 *
 *   1. New shape (preferred). `command` is a single argv token,
 *      treated as one filesystem path or executable name. Any of:
 *        - bare name:                "gh", "codex"
 *        - absolute POSIX path:       "/usr/bin/gh"
 *        - absolute path w/ spaces:   "/Applications/Tool With Space/bin/codex"
 *        - relative path:             "./local/tool"
 *        - relative path w/ spaces:   "./local/tool with space"
 *      `prefix_args` (if present) carries leading argv. Both passthrough
 *      unchanged. No deprecation warning.
 *
 *   2. Legacy shape (DEP0190 migration). `command` is a bare name
 *      containing internal whitespace, encoding leading argv as a
 *      single string ("gh copilot --"). Detected ONLY when `command`
 *      has NO `/` AND has internal whitespace. The loader
 *      whitespace-splits it once: the first token becomes `command`,
 *      the rest become `prefix_args`. Emits a one-shot deprecation
 *      warning per `loadConfig` call via the `onLegacyShape` callback.
 *
 * The two shapes are ambiguous when both encodings collide — a
 * bare-name command containing whitespace AND a separately-specified
 * `prefix_args` array. That combination is rejected with a descriptive
 * error. A path-with-spaces + `prefix_args` is NOT ambiguous: paths
 * always passthrough, and `prefix_args` carries argv as documented.
 *
 * Returns the normalized `{ command, prefix_args }` pair (with
 * `prefix_args` omitted when it is absent or empty). Pure — does no
 * I/O of its own; the caller decides what to do with the warning
 * signal.
 *
 * Windows paths (`C:\...`, backslash separators) are explicitly out of
 * scope per the DEP0190 spec; Windows operators are expected to use
 * WSL, where paths are POSIX.
 */
export function normalizeProviderCommand(
  providerName: string,
  rawCommand: string,
  rawPrefixArgs: ReadonlyArray<string> | undefined,
  onLegacyShape: (providerName: string, rawCommand: string) => void,
): { command: string; prefix_args?: ReadonlyArray<string> } {
  // Disambiguation rule (DEP0190 round-2 fix):
  //
  //   A `command` value is treated as a PATH (preserved as-is, one argv
  //   token) when it contains any path separator character (`/`).
  //   Otherwise — bare names like "gh", "codex", or legacy single-string
  //   forms like "gh copilot --" — whitespace is interpreted as the
  //   legacy tokenizer.
  //
  // Why path-separator presence and not just `startsWith('/')`:
  //   - Absolute POSIX paths can contain internal whitespace
  //     ("/Applications/Tool With Space/bin/codex"). Whitespace alone
  //     must NOT trigger the legacy split, or operators on macOS lose
  //     legitimate paths.
  //   - Relative paths ("./local/tool", "./local/tool with space") are
  //     equally legitimate under shell:false spawn. They contain `/`
  //     but do not start with `/`.
  //
  // Windows-style paths (`C:\...`, backslashes) are explicitly OUT OF
  // SCOPE per the spec — Windows operators use WSL, where paths are
  // POSIX. We do not detect backslash as a path separator.
  //
  // The legacy whitespace tokenizer uses [ \t] (space + tab) — not \s —
  // so newlines and exotic unicode whitespace surface as literal
  // characters in `command` and fail visibly at spawn rather than being
  // silently consumed.
  const looksLikePath = rawCommand.includes('/');
  const hasInternalWhitespace = /[ \t]/.test(rawCommand);
  const isLegacyShape = !looksLikePath && hasInternalWhitespace;

  if (isLegacyShape && rawPrefixArgs !== undefined) {
    // Ambiguous shape: the operator wrote BOTH the legacy
    // whitespace-string form AND the new array form. We refuse to
    // guess which they meant; loading must fail with a clear message.
    //
    // NOTE: a path with spaces + prefix_args is NOT ambiguous — it is
    // the documented new shape (an absolute/relative path executable
    // with its own leading argv), and falls through to the passthrough
    // branch below.
    throw new Error(
      `Provider '${providerName}' has both a whitespace-containing command ` +
      `(${JSON.stringify(rawCommand)}) and a 'prefix_args' array. These are ` +
      `mutually exclusive: pick one shape. Recommended: set command to the ` +
      `executable token only (the first word) and put the remaining tokens ` +
      `in prefix_args. See specs/dep0190-shell-removal.md.`,
    );
  }

  if (isLegacyShape) {
    // Legacy single-string shape — whitespace-split once. No quoting
    // support: the factory has only ever shipped flat space-separated
    // strings in this position ("codex", "claude", "gh copilot --"),
    // and shell-feature emulation is explicitly out of scope (per the
    // spec's "Out of scope" section). If an operator's command relied
    // on shell quoting, the migration target is the explicit array.
    const tokens = rawCommand.split(/[ \t]+/).filter((t) => t.length > 0);
    onLegacyShape(providerName, rawCommand);
    return tokens.length > 1
      ? { command: tokens[0]!, prefix_args: tokens.slice(1) }
      : { command: tokens[0] ?? rawCommand };
  }

  // New shape (path, bare name, or path-with-spaces) — passthrough.
  // We keep prefix_args undefined when the operator omitted it; passing
  // it through verbatim preserves the distinction between "absent" and
  // "empty array" for any future schema-level checks (the JSON Schema
  // already enforces minItems: 1 when present).
  return rawPrefixArgs !== undefined && rawPrefixArgs.length > 0
    ? { command: rawCommand, prefix_args: rawPrefixArgs }
    : { command: rawCommand };
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
        // DEP0190 — defaults use the new split shape (command =
        // executable, prefix_args = leading argv). An operator whose
        // on-disk config still carries the legacy whitespace string
        // will see their value override the default at merge time,
        // and the loader's `normalizeProviderCommand` step will
        // surface the deprecation warning for them.
        command: 'gh',
        prefix_args: ['copilot', '--'],
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
    // DEP0190 — track which providers used the legacy whitespace-in-
    // command shape so the warning aggregates into a single
    // console.warn per loadConfig call. The warning fires once per
    // load (not once per provider per call), matching the contract
    // pinned by the deprecation-warning-frequency tests.
    const legacyShapeProviders: Array<{ name: string; rawCommand: string }> = [];
    const recordLegacyShape = (name: string, rawCommand: string): void => {
      legacyShapeProviders.push({ name, rawCommand });
    };
    for (const key of new Set([...Object.keys(defaultProviders), ...Object.keys(rawProviders ?? {})])) {
      // Normalize (command, prefix_args) at the RAW boundary, before
      // merging with defaults. If we merged first, an operator's
      // legacy-shape command would collide with the default's
      // already-split prefix_args (copilot) and trigger the
      // ambiguous-shape rejection — which is not what the operator
      // intended. The operator's command overrides the default;
      // their prefix_args (or absence thereof) overrides the
      // default's. Normalization runs on the operator's raw entry
      // only when they supplied a command of their own.
      const rawEntry = rawProviders?.[key];
      const defaultEntry = defaultProviders[key];
      let normalized: { command: string; prefix_args?: ReadonlyArray<string> } | undefined;
      if (rawEntry?.command !== undefined) {
        normalized = normalizeProviderCommand(
          key,
          rawEntry.command,
          rawEntry.prefix_args,
          recordLegacyShape,
        );
      }
      // Compose the final entry: defaults first, then raw overrides,
      // then the normalized (command, prefix_args) on top. When the
      // operator did not provide their own command, the default
      // (already in the new shape) wins.
      const composed: PipelineProviderConfig = {
        ...defaultEntry,
        ...rawEntry,
        ...(normalized !== undefined
          ? normalized.prefix_args !== undefined
            ? { command: normalized.command, prefix_args: normalized.prefix_args }
            : { command: normalized.command, prefix_args: undefined }
          : {}),
      } as PipelineProviderConfig;
      // The conditional `prefix_args: undefined` above intentionally
      // clears the field when the operator's command had no
      // whitespace and they supplied no prefix_args — preventing a
      // stale default `prefix_args` from leaking through when the
      // operator wrote the new shape with a single-token command.
      mergedProviders[key] = composed.prefix_args === undefined
        ? (({ prefix_args, ...rest }) => rest as PipelineProviderConfig)(composed)
        : composed;
    }
    if (legacyShapeProviders.length > 0) {
      emitLegacyShapeWarning(legacyShapeProviders);
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
