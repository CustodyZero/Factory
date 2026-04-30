/**
 * Factory — Pipeline / Prompt Builders
 *
 * Pure functions that assemble the prompts handed to each persona's
 * provider CLI. Extracted from `tools/run.ts` (Phase 1) so the prompt
 * surface can be exercised by unit tests independent of provider
 * invocation.
 *
 * Contract: each builder returns a deterministic string for a given
 * input. The string format is load-bearing — agents condition on its
 * structure — so any future change must be intentional and covered
 * by an updated snapshot in `tools/test/prompts.test.ts`.
 *
 * Inputs are kept narrow on purpose. We do not pass the full
 * FactoryConfig where only one or two fields are used; this keeps
 * each builder testable without constructing a large config fixture.
 */

import type { FactoryConfig } from '../config.js';
import type { RawPacket } from '../execute.js';
import type { IntentArtifact } from '../plan.js';

// ---------------------------------------------------------------------------
// Developer / reviewer / rework / QA prompts
//
// These four mirror the original builders in run.ts byte-for-byte.
// They take (packet, config) because each pulls persona instructions
// from config.personas and (for the reviewer) factory_dir for the CLI
// hint embedded in the prompt body.
// ---------------------------------------------------------------------------

/**
 * Developer prompt — sent when a packet is in `implement` resume point.
 *
 * Requires: packet.id, packet.title, packet.acceptance_criteria,
 *           packet.instructions, config.personas.developer.instructions.
 *
 * The packet.intent field is read defensively (it is not on the
 * RawPacket type) and falls back to a placeholder string. This
 * matches the original behavior in run.ts.
 */
export function buildDevPrompt(packet: RawPacket, config: FactoryConfig): string {
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

/**
 * Code-reviewer prompt — sent when a packet is in `review` resume point.
 *
 * Requires: packet.id, packet.title, packet.acceptance_criteria,
 *           config.personas.code_reviewer.instructions, config.factory_dir.
 *
 * The factory_dir is interpolated into the CLI hint at the bottom so
 * the reviewer knows the right path to invoke for either decision.
 */
export function buildReviewPrompt(packet: RawPacket, config: FactoryConfig): string {
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

/**
 * Rework prompt — sent when a packet is in `rework` resume point
 * after a `changes_requested` review decision.
 *
 * Note: the original builder accepted a `config` argument but did
 * not use it. We preserve that signature so swapping the call site
 * in run.ts is a true no-op refactor.
 */
export function buildReworkPrompt(packet: RawPacket, _config: FactoryConfig): string {
  return [
    `You are a developer. Your code review for packet "${packet.id}" requested changes.`,
    `Address the review feedback and fix the issues.`,
    `Do not call request-review.ts or complete.ts yourself.`,
  ].join('\n');
}

/**
 * QA prompt — sent for each QA packet during the verification phase.
 *
 * Requires: packet.id, packet.title, packet.verifies,
 *           packet.acceptance_criteria, config.personas.qa.instructions.
 */
export function buildQaPrompt(packet: RawPacket, config: FactoryConfig): string {
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
// Planner prompt
//
// The planner prompt was inlined inside `planPhase` in run.ts. Extract
// it here so the same byte-for-byte assembly is testable. The shape
// of the input deliberately mirrors what planPhase already had on hand
// (the hydrated intent, the planner persona's instructions, the
// artifact_dir for the output instruction, and the optional spec_path
// from the raw intent).
// ---------------------------------------------------------------------------

export interface PlannerPromptInput {
  /** Hydrated intent (id, title, spec, optional constraints). */
  readonly intent: IntentArtifact;
  /** The planner persona's `instructions` array, copied through. */
  readonly plannerInstructions: ReadonlyArray<string>;
  /** Where the planner should write feature/packet artifacts (config.artifact_dir). */
  readonly artifactDir: string;
  /**
   * If the raw intent recorded a spec_path, the planner is asked to
   * read the spec from that path rather than receiving the spec body
   * inline. This avoids OS command-line length limits on large specs
   * — a behavior preserved from the original builder.
   */
  readonly specPath: string | null;
}

/**
 * Planner prompt — assembles the decomposition request the planner
 * persona receives. Preserves the original builder's behavior:
 *
 *   - When specPath is provided, the prompt references the file and
 *     does NOT inline `intent.spec`.
 *   - When specPath is null/undefined, the prompt embeds the spec
 *     body under a `## Spec` heading.
 *   - Empty constraints arrays produce no constraints section.
 *   - Output instructions reference the artifact directory verbatim.
 */
export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const { intent, plannerInstructions, artifactDir, specPath } = input;
  const constraints = (intent.constraints ?? []).map((c) => `- ${c}`).join('\n');
  const specRef = specPath
    ? `Read the full spec from: ${specPath}`
    : `## Spec\n${intent.spec}`;
  return [
    `You are a planner. Decompose this intent into a feature with dev/qa packet pairs.`,
    ``,
    `## Intent: ${intent.id}`,
    `Title: ${intent.title}`,
    ``,
    specRef,
    ``,
    constraints.length > 0 ? `## Constraints\n${constraints}\n` : '',
    `## Instructions`,
    ...plannerInstructions,
    ``,
    `## Output`,
    `Create the following files under the factory artifact directory (${artifactDir}):`,
    `1. features/${intent.id}.json — feature artifact with status "planned"`,
    `   - Set intent_id to "${intent.id}"`,
    `   - Set packets array with all dev and qa packet IDs`,
    `2. packets/<packet-id>.json — one dev packet per logical work unit`,
    `3. packets/<packet-id>-qa.json — one qa packet per dev packet (kind: "qa", verifies: "<dev-packet-id>")`,
    ``,
    `Every dev packet must have a QA counterpart. Set dependencies between packets where needed.`,
    `Set feature_id on each packet. Use kebab-case IDs.`,
  ].filter(Boolean).join('\n');
}
