/**
 * Tests for factory supervisor — the stateless tick function.
 */

import { describe, it, expect } from 'vitest';
import { resolveSupervisorAction } from '../supervise.js';
import type {
  SuperviseInput,
  SupervisorState,
  SupervisorAction,
  FeatureTracking,
  Escalation,
} from '../supervise.js';
import type { Feature } from '../execute.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-03-28T12:00:00Z');

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: overrides.id ?? 'test-feature',
    intent: overrides.intent ?? 'Test feature',
    status: overrides.status ?? 'approved',
    packets: overrides.packets ?? [],
    created_by: overrides.created_by ?? { kind: 'human', id: 'operator' },
    approved_at: overrides.approved_at ?? '2026-03-21T00:00:00Z',
  };
}

function makeDevPacket(id: string, deps: string[] = [], started_at: string | null = null) {
  return {
    id,
    kind: 'dev' as const,
    title: `Dev ${id}`,
    change_class: 'local' as const,
    dependencies: deps,
    started_at,
  };
}

function makeArchPacket(id: string, deps: string[] = [], started_at: string | null = null) {
  return {
    id,
    kind: 'dev' as const,
    title: `Arch ${id}`,
    change_class: 'architectural' as const,
    dependencies: deps,
    started_at,
  };
}

function makeQaPacket(id: string, verifies: string, deps: string[] = [], started_at: string | null = null) {
  return {
    id,
    kind: 'qa' as const,
    verifies,
    title: `QA ${id}`,
    change_class: 'local' as const,
    dependencies: deps,
    started_at,
  };
}

function emptyState(): SupervisorState {
  return {
    version: 1,
    updated_at: '2026-03-28T00:00:00Z',
    updated_by: { kind: 'agent', id: 'supervisor' },
    features: {},
    pending_escalations: [],
    audit_log: [],
  };
}

function trackingFor(featureId: string, phase: FeatureTracking['phase'] = 'executing', overrides: Partial<FeatureTracking> = {}): FeatureTracking {
  return {
    feature_id: featureId,
    phase,
    first_seen_at: '2026-03-28T00:00:00Z',
    last_tick_at: '2026-03-28T00:00:00Z',
    packets_spawned: [],
    active_dispatches: [],
    packets_completed: [],
    packets_accepted: [],
    blocked_reason: null,
    tick_count: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<SuperviseInput> = {}): SuperviseInput {
  return {
    supervisorState: overrides.supervisorState ?? emptyState(),
    features: overrides.features ?? [],
    packets: overrides.packets ?? [],
    completionIds: overrides.completionIds ?? new Set(),
    acceptanceIds: overrides.acceptanceIds ?? new Set(),
    personas: overrides.personas ?? {
      planner: { description: 'Planner', instructions: [] },
      developer: { description: 'Dev', instructions: [] },
      code_reviewer: { description: 'Code Reviewer', instructions: [] },
      qa: { description: 'QA', instructions: [] },
    },
    now: overrides.now ?? NOW,
    featureFilter: overrides.featureFilter,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveSupervisorAction', () => {
  // -----------------------------------------------------------------------
  // Idle cases
  // -----------------------------------------------------------------------

  it('SV-U1: returns idle when no features exist', () => {
    const action = resolveSupervisorAction(makeInput());
    expect(action.kind).toBe('idle');
  });

  it('SV-U2: returns idle when only draft features exist', () => {
    const action = resolveSupervisorAction(makeInput({
      features: [makeFeature({ status: 'draft' })],
    }));
    expect(action.kind).toBe('idle');
  });

  // -----------------------------------------------------------------------
  // Discovery (Priority 1: stale state detection)
  // -----------------------------------------------------------------------

  it('SV-U3: discovers new approved feature and returns update_state', () => {
    const action = resolveSupervisorAction(makeInput({
      features: [makeFeature({ id: 'new-feature', packets: ['p1'] })],
    }));
    expect(action.kind).toBe('update_state');
    expect(action.feature_id).toBe('new-feature');
    expect(action.state_patch).not.toBeNull();
    expect(action.state_patch?.features?.['new-feature']?.phase).toBe('discovered');
  });

  it('SV-U4: detects new completions and syncs state', () => {
    const state = emptyState();
    const tracking = trackingFor('f1', 'executing', {
      packets_spawned: ['p1'],
      packets_completed: [],
    });
    (state as { features: Record<string, FeatureTracking> }).features = { f1: tracking };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['p1', 'p2'] })],
      packets: [makeDevPacket('p1'), makeDevPacket('p2', ['p1'])],
      completionIds: new Set(['p1']),
    }));
    expect(action.kind).toBe('update_state');
    expect(action.state_patch?.features?.['f1']?.packets_completed).toContain('p1');
  });

  // -----------------------------------------------------------------------
  // Execution (Priority 3: spawn packets)
  // -----------------------------------------------------------------------

  it('SV-U5: returns execute_feature with ready packets', () => {
    const state = emptyState();
    const tracking = trackingFor('f1', 'executing');
    (state as { features: Record<string, FeatureTracking> }).features = { f1: tracking };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['p1'] })],
      packets: [makeDevPacket('p1')],
    }));
    expect(action.kind).toBe('execute_feature');
    expect(action.ready_packets.length).toBe(1);
    expect(action.ready_packets[0].packet_id).toBe('p1');
    expect(action.ready_packets[0].persona).toBe('developer');
    expect(action.ready_packets[0].start_command).toBe('npx tsx tools/start.ts p1');
    expect(action.dispatches[0].packet_id).toBe('p1');
    expect(action.dispatches[0].dispatch_id).toContain('dispatch-f1-p1-');
  });

  it('SV-U6: returns idle when packets are in-progress but none ready', () => {
    const state = emptyState();
    const tracking = trackingFor('f1', 'executing', { packets_spawned: ['p1'] });
    (state as { features: Record<string, FeatureTracking> }).features = { f1: tracking };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['p1'] })],
      packets: [makeDevPacket('p1', [], '2026-03-28T10:00:00Z')],
    }));
    expect(action.kind).toBe('idle');
  });

  it('SV-U7: QA packets assigned as qa persona', () => {
    const state = emptyState();
    const tracking = trackingFor('f1', 'executing', {
      packets_spawned: ['d1'],
      packets_completed: ['d1'],
    });
    (state as { features: Record<string, FeatureTracking> }).features = { f1: tracking };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['d1', 'q1'] })],
      packets: [makeDevPacket('d1'), makeQaPacket('q1', 'd1', ['d1'])],
      completionIds: new Set(['d1']),
    }));
    expect(action.kind).toBe('execute_feature');
    expect(action.ready_packets.length).toBe(1);
    expect(action.ready_packets[0].packet_id).toBe('q1');
    expect(action.ready_packets[0].persona).toBe('qa');
    expect(action.ready_packets[0].start_command).toBe('npx tsx tools/start.ts q1');
    expect(action.dispatches[0].packet_id).toBe('q1');
  });

  // -----------------------------------------------------------------------
  // Escalation
  // -----------------------------------------------------------------------

  it('SV-U8: escalates acceptance for architectural packets', () => {
    const state = emptyState();
    const tracking = trackingFor('f1', 'executing', {
      packets_spawned: ['d1', 'q1'],
      packets_completed: ['d1', 'q1'],
    });
    (state as { features: Record<string, FeatureTracking> }).features = { f1: tracking };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['d1', 'q1'] })],
      packets: [makeArchPacket('d1'), makeQaPacket('q1', 'd1', ['d1'])],
      completionIds: new Set(['d1', 'q1']),
    }));
    expect(action.kind).toBe('escalate_acceptance');
    expect(action.escalation).not.toBeNull();
    expect(action.escalation?.kind).toBe('acceptance');
    expect(action.escalation?.packet_ids).toContain('d1');
  });

  it('SV-U9: escalates blocked features', () => {
    const state = emptyState();
    const tracking = trackingFor('f1', 'executing');
    (state as { features: Record<string, FeatureTracking> }).features = { f1: tracking };

    // p2 depends on p1 but p1 is not in the feature (external dep, not accepted)
    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['p2'] })],
      packets: [makeDevPacket('p2', ['p1'])],
    }));
    expect(action.kind).toBe('escalate_blocked');
    expect(action.escalation?.kind).toBe('blocked');
  });

  // -----------------------------------------------------------------------
  // Escalation blocking (SI-6)
  // -----------------------------------------------------------------------

  it('SV-U10: unresolved acceptance escalation blocks progression', () => {
    const esc: Escalation = {
      id: 'esc-1',
      kind: 'acceptance',
      feature_id: 'f1',
      packet_ids: ['d1'],
      created_at: '2026-03-28T10:00:00Z',
      message: 'Needs acceptance',
      resolved: false,
      resolved_at: null,
    };

    const state: SupervisorState = {
      ...emptyState(),
      features: { f1: trackingFor('f1', 'awaiting_human') },
      pending_escalations: [esc],
    };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['d1', 'q1'] })],
      packets: [makeArchPacket('d1'), makeQaPacket('q1', 'd1', ['d1'])],
      completionIds: new Set(['d1', 'q1']),
    }));
    // Should re-report the escalation, not try to spawn packets
    expect(action.kind).toBe('escalate_acceptance');
  });

  it('SV-U11: resolved acceptance escalation allows progression', () => {
    const esc: Escalation = {
      id: 'esc-1',
      kind: 'acceptance',
      feature_id: 'f1',
      packet_ids: ['d1'],
      created_at: '2026-03-28T10:00:00Z',
      message: 'Needs acceptance',
      resolved: false,
      resolved_at: null,
    };

    const state: SupervisorState = {
      ...emptyState(),
      features: { f1: trackingFor('f1', 'awaiting_human') },
      pending_escalations: [esc],
    };

    // Human has accepted d1
    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['d1', 'q1'] })],
      packets: [makeArchPacket('d1'), makeQaPacket('q1', 'd1', ['d1'])],
      completionIds: new Set(['d1', 'q1']),
      acceptanceIds: new Set(['d1']),
    }));
    // Should resolve the escalation via update_state
    expect(action.kind).toBe('update_state');
    expect(action.message).toContain('resolved');
  });

  // -----------------------------------------------------------------------
  // Completion
  // -----------------------------------------------------------------------

  it('SV-U12: marks feature complete when all packets done', () => {
    const state: SupervisorState = {
      ...emptyState(),
      features: { f1: trackingFor('f1', 'executing', {
        packets_spawned: ['p1'],
        packets_completed: ['p1'],
      }) },
    };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['p1'] })],
      packets: [makeDevPacket('p1')],
      completionIds: new Set(['p1']),
    }));
    expect(action.kind).toBe('update_state');
    expect(action.state_patch?.features?.['f1']?.phase).toBe('complete');
  });

  // -----------------------------------------------------------------------
  // Idempotency (SI-3)
  // -----------------------------------------------------------------------

  it('SV-U13: same input produces same action kind', () => {
    const input = makeInput({
      features: [makeFeature({ id: 'f1', packets: ['p1'] })],
    });
    const action1 = resolveSupervisorAction(input);
    const action2 = resolveSupervisorAction(input);
    expect(action1.kind).toBe(action2.kind);
    expect(action1.feature_id).toBe(action2.feature_id);
  });

  // -----------------------------------------------------------------------
  // Feature filter
  // -----------------------------------------------------------------------

  it('SV-U14: --feature filter scopes to one feature', () => {
    const state: SupervisorState = {
      ...emptyState(),
      features: {
        f1: trackingFor('f1', 'executing'),
        f2: trackingFor('f2', 'executing'),
      },
    };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [
        makeFeature({ id: 'f1', packets: ['p1'] }),
        makeFeature({ id: 'f2', packets: ['p2'] }),
      ],
      packets: [makeDevPacket('p1'), makeDevPacket('p2')],
      featureFilter: 'f1',
    }));
    expect(action.feature_id).toBe('f1');
  });

  // -----------------------------------------------------------------------
  // Skips complete features
  // -----------------------------------------------------------------------

  it('SV-U15: skips features already in complete phase', () => {
    const state: SupervisorState = {
      ...emptyState(),
      features: { f1: trackingFor('f1', 'complete') },
    };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['p1'] })],
      packets: [makeDevPacket('p1')],
      completionIds: new Set(['p1']),
    }));
    expect(action.kind).toBe('idle');
  });

  it('SV-U16: reuses active dispatch ids across repeated ticks', () => {
    const state: SupervisorState = {
      ...emptyState(),
      features: {
        f1: trackingFor('f1', 'executing', {
          active_dispatches: [{
            dispatch_id: 'dispatch-f1-p1-existing',
            feature_id: 'f1',
            packet_id: 'p1',
            persona: 'developer',
            model: 'opus',
            instructions: [],
            start_command: 'npx tsx tools/start.ts p1',
            dispatched_at: '2026-03-28T11:00:00Z',
          }],
        }),
      },
    };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [makeFeature({ id: 'f1', packets: ['p1'] })],
      packets: [makeDevPacket('p1')],
    }));
    expect(action.kind).toBe('execute_feature');
    expect(action.dispatches[0].dispatch_id).toBe('dispatch-f1-p1-existing');
  });

  it('SV-U17: dispatches ready packets across multiple independent features in one tick', () => {
    const state: SupervisorState = {
      ...emptyState(),
      features: {
        f1: trackingFor('f1', 'executing'),
        f2: trackingFor('f2', 'executing'),
      },
    };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [
        makeFeature({ id: 'f1', packets: ['p1'] }),
        makeFeature({ id: 'f2', packets: ['p2'] }),
      ],
      packets: [makeDevPacket('p1'), makeDevPacket('p2')],
    }));

    expect(action.kind).toBe('execute_feature');
    expect(action.feature_id).toBeNull();
    expect(action.feature_ids).toEqual(['f1', 'f2']);
    expect(action.ready_packets.map((packet) => packet.packet_id)).toEqual(['p1', 'p2']);
    expect(action.dispatches.map((dispatch) => dispatch.packet_id)).toEqual(['p1', 'p2']);
    expect(action.state_patch?.features?.['f1']?.packets_spawned).toContain('p1');
    expect(action.state_patch?.features?.['f2']?.packets_spawned).toContain('p2');
  });

  it('SV-U18: does not let one waiting feature block another ready feature', () => {
    const state: SupervisorState = {
      ...emptyState(),
      features: {
        f1: trackingFor('f1', 'executing', { packets_spawned: ['p1'] }),
        f2: trackingFor('f2', 'executing'),
      },
    };

    const action = resolveSupervisorAction(makeInput({
      supervisorState: state,
      features: [
        makeFeature({ id: 'f1', packets: ['p1'] }),
        makeFeature({ id: 'f2', packets: ['p2'] }),
      ],
      packets: [
        makeDevPacket('p1', [], '2026-03-28T10:00:00Z'),
        makeDevPacket('p2'),
      ],
    }));

    expect(action.kind).toBe('execute_feature');
    expect(action.feature_ids).toEqual(['f2']);
    expect(action.ready_packets.map((packet) => packet.packet_id)).toEqual(['p2']);
  });
});
