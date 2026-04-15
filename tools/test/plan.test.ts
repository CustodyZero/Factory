/**
 * Tests for factory plan — the planner resolver.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { hydrateIntent, resolvePlanAction, resolveSpecPath } from '../plan.js';
import type { PlanInput, RawIntentArtifact } from '../plan.js';

function makeIntent(overrides: Partial<PlanInput['intent']> = {}): PlanInput['intent'] {
  return {
    id: overrides.id ?? 'customer-dashboard',
    title: overrides.title ?? 'Customer dashboard',
    spec: overrides.spec ?? 'Build a customer dashboard with audit history and billing status.',
    status: overrides.status ?? 'proposed',
    feature_id: overrides.feature_id ?? null,
    constraints: overrides.constraints ?? ['Keep the existing API stable'],
  };
}

function makeFeature(overrides: Partial<PlanInput['features'][number]> = {}): PlanInput['features'][number] {
  return {
    id: overrides.id ?? 'customer-dashboard',
    status: overrides.status ?? 'planned',
    intent_id: overrides.intent_id ?? 'customer-dashboard',
  };
}

describe('resolvePlanAction', () => {
  it('PL-U1: proposed intent with no feature yields planner assignment', () => {
    const action = resolvePlanAction({
      intent: makeIntent(),
      features: [],
      plannerPersona: { instructions: ['Use domain language from the spec'], model: 'high' },
    });
    expect(action.kind).toBe('plan_feature');
    expect(action.planner_assignment?.persona).toBe('planner');
    expect(action.planner_assignment?.instructions).toContain('Use domain language from the spec');
  });

  it('PL-U2: planned feature awaits human approval when intent is not approved', () => {
    const action = resolvePlanAction({
      intent: makeIntent({ status: 'planned', feature_id: 'customer-dashboard' }),
      features: [makeFeature()],
      plannerPersona: { instructions: [], model: 'high' },
    });
    expect(action.kind).toBe('already_planned');
  });

  it('PL-U3: approved intent lets planned linked feature hand off to supervisor', () => {
    const action = resolvePlanAction({
      intent: makeIntent({ status: 'approved', feature_id: 'customer-dashboard' }),
      features: [makeFeature({ status: 'planned' })],
      plannerPersona: { instructions: [], model: 'opus' },
    });
    expect(action.kind).toBe('ready_for_execution');
    expect(action.command).toContain('supervise.ts --json --feature customer-dashboard');
  });

  it('PL-U4: approved feature also hands off to supervisor', () => {
    const action = resolvePlanAction({
      intent: makeIntent({ status: 'planned', feature_id: 'customer-dashboard' }),
      features: [makeFeature({ status: 'completed' })],
      plannerPersona: { instructions: [], model: 'high' },
    });
    expect(action.kind).toBe('all_complete');
  });

  it('PL-U5: multiple linked features block planning handoff', () => {
    const action = resolvePlanAction({
      intent: makeIntent({ status: 'planned', feature_id: 'customer-dashboard' }),
      features: [makeFeature({ status: 'delivered' })],
      plannerPersona: { instructions: [], model: 'high' },
    });
    expect(action.kind).toBe('all_complete');
  });

  it('PL-U5: planner assignment includes spec and constraints', () => {
    const action = resolvePlanAction({
      intent: makeIntent({
        spec: 'Build the dashboard',
        constraints: ['Keep API stable', 'No new dependencies'],
      }),
      features: [],
      plannerPersona: { instructions: [], model: 'high' },
    });
    expect(action.kind).toBe('plan_feature');
    expect(action.planner_assignment?.spec).toBe('Build the dashboard');
    expect(action.planner_assignment?.constraints).toEqual(['Keep API stable', 'No new dependencies']);
  });

  it('PL-U6: executing feature returns already_planned', () => {
    const action = resolvePlanAction({
      intent: makeIntent({ status: 'planned', feature_id: 'customer-dashboard' }),
      features: [makeFeature({ status: 'executing' })],
      plannerPersona: { instructions: [], model: 'high' },
    });
    expect(action.kind).toBe('already_planned');
  });
});

function makeRaw(overrides: Partial<RawIntentArtifact> = {}): RawIntentArtifact {
  return {
    id: 'customer-dashboard',
    title: 'Customer dashboard',
    status: 'proposed',
    ...overrides,
  };
}

describe('resolveSpecPath', () => {
  it('SP-U1: rejects empty spec_path', () => {
    const result = resolveSpecPath('/project', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must not be empty/);
  });

  it('SP-U2: rejects absolute spec_path', () => {
    const result = resolveSpecPath('/project', '/etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must be relative/);
  });

  it('SP-U3: rejects path traversal', () => {
    const result = resolveSpecPath('/project', '../outside.md');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must not escape/);
  });

  it('SP-U4: rejects embedded .. segments', () => {
    const result = resolveSpecPath('/project', 'docs/../../../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must not escape/);
  });

  it('SP-U5: resolves safe relative path under project root', () => {
    const result = resolveSpecPath('/project', 'docs/specs/016.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolutePath).toBe(join('/project', 'docs', 'specs', '016.md'));
  });

  it('SP-U6: normalizes redundant segments that stay under root', () => {
    const result = resolveSpecPath('/project', 'docs/./specs/016.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolutePath).toBe(join('/project', 'docs', 'specs', '016.md'));
  });
});

describe('hydrateIntent', () => {
  const neverRead = (): string => {
    throw new Error('readFile should not be called for inline spec');
  };

  it('HI-U1: hydrates inline spec without touching the filesystem', () => {
    const raw = makeRaw({ spec: 'Inline body' });
    const result = hydrateIntent(raw, '/project', neverRead);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.intent.spec).toBe('Inline body');
  });

  it('HI-U2: rejects an intent with both spec and spec_path', () => {
    const raw = makeRaw({ spec: 'Inline', spec_path: 'docs/016.md' });
    const result = hydrateIntent(raw, '/project', neverRead);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/mutually exclusive|Use exactly one/);
  });

  it('HI-U3: rejects an intent with neither spec nor spec_path', () => {
    const raw = makeRaw({});
    const result = hydrateIntent(raw, '/project', neverRead);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must declare either/);
  });

  it('HI-U4: hydrates spec_path by reading through the injected reader', () => {
    const raw = makeRaw({ spec_path: 'docs/specs/016.md' });
    const readFile = (path: string): string => {
      expect(path).toBe(join('/project', 'docs', 'specs', '016.md'));
      return '# 016 — Platform Targets\n\nFull spec body here.';
    };
    const result = hydrateIntent(raw, '/project', readFile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.spec).toContain('016 — Platform Targets');
      expect(result.intent.spec).toContain('Full spec body');
    }
  });

  it('HI-U5: surfaces file read errors without silent fallback', () => {
    const raw = makeRaw({ spec_path: 'docs/missing.md' });
    const readFile = (): string => {
      throw new Error('ENOENT: no such file');
    };
    const result = hydrateIntent(raw, '/project', readFile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/failed to read spec_path.*ENOENT/);
  });

  it('HI-U6: rejects empty spec files to prevent silent no-op planner runs', () => {
    const raw = makeRaw({ spec_path: 'docs/empty.md' });
    const result = hydrateIntent(raw, '/project', () => '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/is empty/);
  });

  it('HI-U7: rejects spec_path that escapes the project root', () => {
    const raw = makeRaw({ spec_path: '../secret.md' });
    const result = hydrateIntent(raw, '/project', neverRead);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must not escape/);
  });
});
