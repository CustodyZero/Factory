/**
 * Tests for the prompt builders extracted from tools/run.ts.
 *
 * These are intentionally exhaustive: each builder gets a test
 * that pins the FULL prompt body. The original builders inline
 * the assembly with `Array.filter(Boolean).join('\n')`, so the
 * exact string is the contract — agents condition on its shape.
 *
 * Any future change to a prompt MUST update the corresponding
 * pinned string here. That is the load-bearing snapshot for
 * "no behavior change."
 */

import { describe, it, expect } from 'vitest';
import {
  buildDevPrompt,
  buildReviewPrompt,
  buildReworkPrompt,
  buildQaPrompt,
  buildPlannerPrompt,
} from '../pipeline/prompts.js';
import type { FactoryConfig } from '../config.js';
import type { RawPacket } from '../execute.js';
import type { IntentArtifact } from '../plan.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<FactoryConfig> = {}): FactoryConfig {
  return {
    project_name: 'test',
    factory_dir: '.',
    artifact_dir: 'factory',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: 'planner', instructions: [] },
      developer: { description: 'dev', instructions: [] },
      code_reviewer: { description: 'cr', instructions: [] },
      qa: { description: 'qa', instructions: [] },
    },
    ...overrides,
  } as FactoryConfig;
}

function makePacket(overrides: Partial<RawPacket> = {}): RawPacket {
  return {
    id: overrides.id ?? 'pkt-1',
    kind: overrides.kind ?? 'dev',
    title: overrides.title ?? 'Test packet',
    ...overrides,
  } as RawPacket;
}

function makeIntent(overrides: Partial<IntentArtifact> = {}): IntentArtifact {
  return {
    id: overrides.id ?? 'int-1',
    title: overrides.title ?? 'Test intent',
    spec: overrides.spec ?? 'Build the thing.',
    status: overrides.status ?? 'approved',
    constraints: overrides.constraints,
    feature_id: overrides.feature_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// buildDevPrompt
// ---------------------------------------------------------------------------

describe('buildDevPrompt', () => {
  it('produces the expected body with no acceptance criteria, no instructions', () => {
    // The original builder uses Array.filter(Boolean) which removes the
    // '' separators after assembly. The pinned body below is the exact
    // resulting compact structure.
    const out = buildDevPrompt(makePacket(), makeConfig());
    expect(out).toBe(
      [
        'You are a developer implementing a work packet.',
        '## Packet: pkt-1',
        'Title: Test packet',
        'Intent: See packet for details',
        'After implementing, the pipeline will request a code review automatically.',
        'Do not call request-review.ts or complete.ts yourself.',
      ].join('\n'),
    );
  });

  it('includes acceptance criteria and persona instructions when present', () => {
    const out = buildDevPrompt(
      makePacket({ acceptance_criteria: ['ac1', 'ac2'] }),
      makeConfig({
        personas: {
          planner: { description: 'p', instructions: [] },
          developer: { description: 'd', instructions: ['Lint clean', 'No new deps'] },
          code_reviewer: { description: 'cr', instructions: [] },
          qa: { description: 'q', instructions: [] },
        },
      }),
    );
    expect(out).toContain('## Acceptance Criteria\n- ac1\n- ac2\n');
    expect(out).toContain('## Instructions\nLint clean\nNo new deps\n');
  });

  it('includes packet-level instructions when present', () => {
    const out = buildDevPrompt(
      makePacket({ instructions: ['Use the existing helper'] }),
      makeConfig(),
    );
    expect(out).toContain('## Packet Instructions\nUse the existing helper\n');
  });

  it('reads packet.intent defensively when present (untyped escape hatch)', () => {
    // The original builder reads (packet as Record<string, unknown>)['intent'].
    // We preserve that escape hatch — verify it actually gets used.
    const packet = { ...makePacket(), intent: 'Solve world hunger' } as unknown as RawPacket;
    const out = buildDevPrompt(packet, makeConfig());
    expect(out).toContain('Intent: Solve world hunger');
  });
});

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

describe('buildReviewPrompt', () => {
  it('emits CLI hints with factory_dir interpolated', () => {
    const out = buildReviewPrompt(
      makePacket({ id: 'dev-1' }),
      makeConfig({ factory_dir: 'factory' }),
    );
    expect(out).toContain(
      'Review the code changes. If acceptable, run: npx tsx factory/tools/review.ts dev-1 --approve',
    );
    expect(out).toContain(
      'If changes needed, run: npx tsx factory/tools/review.ts dev-1 --request-changes',
    );
  });

  it('produces the expected body with no acceptance criteria, no instructions', () => {
    const out = buildReviewPrompt(
      makePacket({ id: 'pkt-1', title: 'Test packet' }),
      makeConfig({ factory_dir: '.' }),
    );
    // Same filter(Boolean) compaction — empty separators stripped.
    expect(out).toBe(
      [
        'You are a code reviewer. Review the implementation for packet "pkt-1".',
        'Title: Test packet',
        'Review the code changes. If acceptable, run: npx tsx ./tools/review.ts pkt-1 --approve',
        'If changes needed, run: npx tsx ./tools/review.ts pkt-1 --request-changes',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// buildReworkPrompt
// ---------------------------------------------------------------------------

describe('buildReworkPrompt', () => {
  it('produces the expected three-line body referencing packet id', () => {
    const out = buildReworkPrompt(makePacket({ id: 'dev-1' }), makeConfig());
    expect(out).toBe(
      [
        'You are a developer. Your code review for packet "dev-1" requested changes.',
        'Address the review feedback and fix the issues.',
        'Do not call request-review.ts or complete.ts yourself.',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// buildQaPrompt
// ---------------------------------------------------------------------------

describe('buildQaPrompt', () => {
  it('produces the expected body with no acceptance criteria and unknown verifies', () => {
    const out = buildQaPrompt(
      makePacket({ id: 'qa-1', kind: 'qa', title: 'Verify packet' }),
      makeConfig(),
    );
    // Same filter(Boolean) compaction — empty separators stripped.
    expect(out).toBe(
      [
        'You are a QA engineer verifying packet "qa-1".',
        'Title: Verify packet',
        'Verifies: unknown',
        'Verify the acceptance criteria are met. Run tests. Check the implementation.',
        'Do not call complete.ts yourself — the pipeline handles that.',
      ].join('\n'),
    );
  });

  it('includes verifies target, acceptance criteria, and qa persona instructions', () => {
    const out = buildQaPrompt(
      makePacket({
        id: 'qa-1',
        kind: 'qa',
        title: 'Verify dev-1',
        verifies: 'dev-1',
        acceptance_criteria: ['Tests pass', 'No regressions'],
      }),
      makeConfig({
        personas: {
          planner: { description: 'p', instructions: [] },
          developer: { description: 'd', instructions: [] },
          code_reviewer: { description: 'cr', instructions: [] },
          qa: { description: 'q', instructions: ['Run npm test', 'Check coverage'] },
        },
      }),
    );
    expect(out).toContain('Verifies: dev-1');
    expect(out).toContain('## Acceptance Criteria\n- Tests pass\n- No regressions\n');
    expect(out).toContain('## Instructions\nRun npm test\nCheck coverage\n');
  });
});

// ---------------------------------------------------------------------------
// buildPlannerPrompt
// ---------------------------------------------------------------------------

describe('buildPlannerPrompt', () => {
  it('inlines spec body when specPath is null', () => {
    const out = buildPlannerPrompt({
      intent: makeIntent({ id: 'i1', title: 'Build it', spec: 'Spec body here' }),
      plannerInstructions: ['Decompose carefully'],
      artifactDir: 'factory',
      specPath: null,
    });
    expect(out).toContain('## Spec\nSpec body here');
    expect(out).not.toContain('Read the full spec from:');
  });

  it('references spec_path when provided — does NOT inline spec body', () => {
    const out = buildPlannerPrompt({
      intent: makeIntent({ id: 'i1', title: 'Build it', spec: 'Spec body here' }),
      plannerInstructions: [],
      artifactDir: 'factory',
      specPath: 'specs/i1.md',
    });
    expect(out).toContain('Read the full spec from: specs/i1.md');
    expect(out).not.toContain('## Spec\nSpec body here');
    expect(out).not.toContain('Spec body here');
  });

  it('produces the expected body for a minimal intent (no constraints, no instructions, with spec inlined)', () => {
    // The original planner prompt assembly uses Array.filter(Boolean) which
    // strips '' (empty-string) separators after assembly. The pinned body
    // below reflects the resulting compact structure: no blank lines between
    // headed sections that were originally separated only by `` markers.
    const out = buildPlannerPrompt({
      intent: makeIntent({ id: 'i1', title: 'Build it', spec: 'Do the work' }),
      plannerInstructions: [],
      artifactDir: 'factory',
      specPath: null,
    });
    expect(out).toBe(
      [
        'You are a planner. Decompose this intent into a feature with dev/qa packet pairs.',
        '## Intent: i1',
        'Title: Build it',
        '## Spec',
        'Do the work',
        '## Instructions',
        '## Output',
        'Create the following files under the factory artifact directory (factory):',
        '1. features/i1.json — feature artifact with status "planned"',
        '   - Set intent_id to "i1"',
        '   - Set packets array with all dev and qa packet IDs',
        '2. packets/<packet-id>.json — one dev packet per logical work unit',
        '3. packets/<packet-id>-qa.json — one qa packet per dev packet (kind: "qa", verifies: "<dev-packet-id>")',
        'Every dev packet must have a QA counterpart. Set dependencies between packets where needed.',
        'Set feature_id on each packet. Use kebab-case IDs.',
      ].join('\n'),
    );
  });

  it('emits constraints section when constraints are non-empty', () => {
    const out = buildPlannerPrompt({
      intent: makeIntent({ id: 'i1', constraints: ['No new deps', 'Backwards compat'] }),
      plannerInstructions: [],
      artifactDir: 'factory',
      specPath: 'specs/i1.md',
    });
    expect(out).toContain('## Constraints\n- No new deps\n- Backwards compat\n');
  });

  it('omits constraints section entirely when constraints are empty/undefined', () => {
    const out = buildPlannerPrompt({
      intent: makeIntent({ id: 'i1' }),
      plannerInstructions: [],
      artifactDir: 'factory',
      specPath: 'specs/i1.md',
    });
    expect(out).not.toContain('## Constraints');
  });

  it('embeds artifact_dir verbatim into the output instructions', () => {
    const out = buildPlannerPrompt({
      intent: makeIntent({ id: 'i1' }),
      plannerInstructions: [],
      artifactDir: 'my-custom-dir',
      specPath: 'specs/i1.md',
    });
    expect(out).toContain(
      'Create the following files under the factory artifact directory (my-custom-dir):',
    );
  });
});
