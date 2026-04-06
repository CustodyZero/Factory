/**
 * Tests for factory plan — the planner handoff resolver.
 */

import { describe, it, expect } from 'vitest';
import { resolvePlanAction } from '../plan.js';
import type { PlanInput } from '../plan.js';

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
      plannerPersona: { instructions: ['Use domain language from the spec'], model: 'opus' },
    });
    expect(action.kind).toBe('plan_feature');
    expect(action.planner_assignment?.persona).toBe('planner');
    expect(action.planner_assignment?.instructions).toContain('Use domain language from the spec');
  });

  it('PL-U2: planned feature awaits human approval', () => {
    const action = resolvePlanAction({
      intent: makeIntent({ status: 'planned', feature_id: 'customer-dashboard' }),
      features: [makeFeature()],
      plannerPersona: { instructions: [], model: 'opus' },
    });
    expect(action.kind).toBe('awaiting_approval');
  });

  it('PL-U3: approved feature hands off to supervisor', () => {
    const action = resolvePlanAction({
      intent: makeIntent({ status: 'planned', feature_id: 'customer-dashboard' }),
      features: [makeFeature({ status: 'approved' })],
      plannerPersona: { instructions: [], model: 'opus' },
    });
    expect(action.kind).toBe('ready_for_execution');
    expect(action.command).toContain('supervise.ts --json --feature customer-dashboard');
  });

  it('PL-U4: multiple linked features block planning handoff', () => {
    const action = resolvePlanAction({
      intent: makeIntent(),
      features: [makeFeature({ id: 'f1' }), makeFeature({ id: 'f2' })],
      plannerPersona: { instructions: [], model: 'opus' },
    });
    expect(action.kind).toBe('blocked');
  });
});
