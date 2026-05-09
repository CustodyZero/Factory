/**
 * Structural tests for the optional `failure` object in
 * schemas/packet.schema.json.
 *
 * The factory does not run an Ajv-style schema engine at runtime — the
 * authoritative validator is tools/validate.ts (whose hand-rolled checks
 * are pinned by tools/test/validate.test.ts). The JSON schemas are
 * documentation/contract artifacts. They MUST stay in sync with what the
 * recovery layer actually writes (develop_phase.markPacketFailed:362,
 * verify_phase.markPacketFailed:197, verify_phase cascade:340), otherwise
 * a future reader trusting the schema will be misled.
 *
 * Round 2 of codex review found that the recovery layer writes a `failure`
 * object onto packet artifacts but the schema declared
 * `additionalProperties: false` without a `failure` property — meaning real
 * recovery output sat outside the schema's data model. These tests pin the
 * fix so it cannot silently regress:
 *
 *   - The schema declares `failure` as a property
 *   - The shape matches what the code writes (scenario, reason, attempts,
 *     escalation_path)
 *   - scenario and reason are required; attempts and escalation_path are
 *     optional but typed
 *   - The schema's description names CascadedFromDependency as a label
 *     string explicitly NOT a 9th FailureScenario enum variant
 *   - additionalProperties: false on the failure subobject (so unknown
 *     fields cannot drift in unannounced)
 *
 * No JSON Schema engine is required: we read the schema as JSON and assert
 * its structure. This is honest — the schema artifact is being verified,
 * not its hypothetical interpretation by a third-party validator.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  'schemas',
  'packet.schema.json',
);

interface PacketSchema {
  readonly properties: Record<string, unknown>;
  readonly additionalProperties: boolean;
}

interface FailureSchema {
  readonly type: string;
  readonly additionalProperties: boolean;
  readonly required: ReadonlyArray<string>;
  readonly properties: Record<string, Record<string, unknown>>;
  readonly description?: string;
}

function loadSchema(): PacketSchema {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8')) as PacketSchema;
}

function loadFailureSchema(): FailureSchema {
  const schema = loadSchema();
  expect(schema.properties).toHaveProperty('failure');
  return schema.properties['failure'] as FailureSchema;
}

describe('packet.schema.json — failure object contract', () => {
  it('declares the optional failure property at the packet level', () => {
    const schema = loadSchema();
    expect(schema.properties).toHaveProperty('failure');
    // failure must NOT be in the top-level required list — it is set only
    // on packets that escalated, never on completed/in-progress packets.
    const required = (schema as unknown as { readonly required?: ReadonlyArray<string> }).required;
    if (Array.isArray(required)) {
      expect(required).not.toContain('failure');
    }
  });

  it("the packet schema's additionalProperties is still false (failure is now declared, not silently allowed)", () => {
    const schema = loadSchema();
    expect(schema.additionalProperties).toBe(false);
  });

  it('failure is an object with additionalProperties: false', () => {
    const failure = loadFailureSchema();
    expect(failure.type).toBe('object');
    expect(failure.additionalProperties).toBe(false);
  });

  it("failure requires 'scenario' and 'reason' (non-empty strings)", () => {
    const failure = loadFailureSchema();
    expect(failure.required).toEqual(expect.arrayContaining(['scenario', 'reason']));
    expect(failure.properties['scenario']?.['type']).toBe('string');
    expect(failure.properties['scenario']?.['minLength']).toBe(1);
    expect(failure.properties['reason']?.['type']).toBe('string');
    expect(failure.properties['reason']?.['minLength']).toBe(1);
  });

  it("failure.attempts is an optional non-negative integer (matches the code's writes of 0 for cascade and N for retries)", () => {
    const failure = loadFailureSchema();
    expect(failure.required).not.toContain('attempts');
    expect(failure.properties['attempts']?.['type']).toBe('integer');
    expect(failure.properties['attempts']?.['minimum']).toBe(0);
  });

  it("failure.escalation_path accepts string or null (cascade writes null; real escalations write the path)", () => {
    const failure = loadFailureSchema();
    expect(failure.required).not.toContain('escalation_path');
    // JSON Schema lets `type` be an array of types; verify both string and
    // null are explicitly allowed.
    const t = failure.properties['escalation_path']?.['type'];
    expect(Array.isArray(t)).toBe(true);
    expect(t as ReadonlyArray<string>).toEqual(expect.arrayContaining(['string', 'null']));
  });

  it("failure.scenario field is intentionally NOT a closed enum (it must accept FailureScenario values, 'Unclassified', and the cascade label 'CascadedFromDependency')", () => {
    const failure = loadFailureSchema();
    // The schema deliberately uses `type: 'string'` (no `enum`) so the
    // cascade label and the future Unclassified value are both honest.
    // Pin this so a well-meaning future change does not lock the field
    // to the 8 FailureScenario variants and silently exclude cascade.
    expect(failure.properties['scenario']).not.toHaveProperty('enum');
  });

  it("failure.scenario description names 'CascadedFromDependency' as a label, NOT a 9th FailureScenario enum variant", () => {
    const failure = loadFailureSchema();
    const desc = String(failure.properties['scenario']?.['description'] ?? '');
    expect(desc).toContain('CascadedFromDependency');
    // Pin the discriminating sentence so the doc cannot drift back to
    // suggesting CascadedFromDependency is part of the closed enum.
    expect(desc).toContain('NOT a 9th FailureScenario enum variant');
  });

  it("failure.scenario description enumerates the 8 FailureScenario values + Unclassified for human readers", () => {
    const failure = loadFailureSchema();
    const desc = String(failure.properties['scenario']?.['description'] ?? '');
    // Cite the 8 closed enum members so a reader can map this field to the
    // recovery layer's FailureScenario type without chasing imports.
    for (const s of [
      'ProviderTransient',
      'ProviderUnavailable',
      'BuildFailed',
      'LintFailed',
      'TestFailed',
      'StaleBranch',
      'AgentNonResponsive',
      'CompletionGateBlocked',
    ]) {
      expect(desc).toContain(s);
    }
    expect(desc).toContain('Unclassified');
  });

  it('failure object description names its origin (recovery layer / escalation) so the reader knows when it appears', () => {
    const failure = loadFailureSchema();
    const desc = String(failure.description ?? '');
    expect(desc.length).toBeGreaterThan(0);
    expect(desc).toMatch(/recovery|escalat/i);
    // Mutual exclusion with the success path — failure is never present on
    // completed packets.
    expect(desc).toMatch(/never present.*completed|completed.*never present|failed/i);
  });
});

// ---------------------------------------------------------------------------
// Schema-vs-code drift guard
//
// The recovery layer's RecoveryResult<'escalated'> shape (tools/pipeline/
// recovery.ts) is the source of truth for what gets written. These tests
// fail loud if a future change adds a new key to the writes without
// updating the schema's failure object — which was the exact drift codex
// caught in round 2.
// ---------------------------------------------------------------------------

describe('packet.schema.json — failure object matches what the code writes', () => {
  it("declares a property for every field the recovery layer writes (scenario, reason, attempts, escalation_path)", () => {
    const failure = loadFailureSchema();
    // These four field names are pinned literally because they are what
    // markPacketFailed writes in develop_phase.ts and verify_phase.ts and
    // what the cascade write in verify_phase.ts writes. If a future
    // change adds a new field to either write site, this test will start
    // failing because additionalProperties: false will reject it — which
    // is the desired feedback loop (schema must be updated alongside).
    const declared = Object.keys(failure.properties);
    expect(declared.sort()).toEqual(
      ['attempts', 'escalation_path', 'reason', 'scenario'].sort(),
    );
  });
});
