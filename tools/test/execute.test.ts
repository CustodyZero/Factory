/**
 * Tests for factory execute — the stateless action resolver.
 */

import { describe, it, expect } from 'vitest';
import { resolveExecuteAction } from '../execute.js';
import type { Feature, ExecuteInput } from '../execute.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makePacket(id: string, deps: string[] = [], started_at: string | null = null) {
  return {
    id,
    title: `Packet ${id}`,
    change_class: 'local' as const,
    dependencies: deps,
    started_at,
  };
}

function makeInput(overrides: Partial<ExecuteInput> = {}): ExecuteInput {
  return {
    feature: overrides.feature ?? makeFeature(),
    packets: overrides.packets ?? [],
    completionIds: overrides.completionIds ?? new Set(),
    acceptanceIds: overrides.acceptanceIds ?? new Set(),
    hasReport: overrides.hasReport ?? false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveExecuteAction', () => {
  it('EX-U1: rejects feature in draft status', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ status: 'draft', packets: ['p1'] }),
    }));
    expect(action.kind).toBe('not_approved');
    expect(action.message).toContain('draft');
  });

  it('EX-U2: empty feature is immediately all_complete', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: [] }),
    }));
    expect(action.kind).toBe('all_complete');
  });

  it('EX-U3: single ready packet produces spawn_packets', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [makePacket('p1')],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toEqual(['p1']);
  });

  it('EX-U4: all packets completed without report produces produce_report', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [makePacket('p1')],
      completionIds: new Set(['p1']),
    }));
    expect(action.kind).toBe('produce_report');
    expect(action.completed_packets).toEqual(['p1']);
  });

  it('EX-U5: independent packets are all ready for parallel spawn', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2'] }),
      packets: [makePacket('p1'), makePacket('p2')],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toEqual(['p1', 'p2']);
  });

  it('EX-U6: dependent packet is blocked until dependency completes', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2'] }),
      packets: [makePacket('p1'), makePacket('p2', ['p1'])],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toEqual(['p1']);
    expect(action.blocked_packets).toHaveLength(1);
    expect(action.blocked_packets[0]!.id).toBe('p2');
    expect(action.blocked_packets[0]!.blocked_by).toContain('p1');
  });

  it('EX-U7: completing dependency unblocks dependent packet', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2'] }),
      packets: [makePacket('p1'), makePacket('p2', ['p1'])],
      completionIds: new Set(['p1']),
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toEqual(['p2']);
    expect(action.completed_packets).toEqual(['p1']);
  });

  it('EX-U8: diamond graph resolves parallelism correctly', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2', 'p3', 'p4'] }),
      packets: [
        makePacket('p1'),
        makePacket('p2', ['p1']),
        makePacket('p3', ['p1']),
        makePacket('p4', ['p2', 'p3']),
      ],
    }));
    expect(action.ready_packets).toEqual(['p1']);

    const action2 = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2', 'p3', 'p4'] }),
      packets: [
        makePacket('p1'),
        makePacket('p2', ['p1']),
        makePacket('p3', ['p1']),
        makePacket('p4', ['p2', 'p3']),
      ],
      completionIds: new Set(['p1']),
    }));
    expect(action2.ready_packets).toEqual(['p2', 'p3']);
    expect(action2.blocked_packets).toHaveLength(1);
    expect(action2.blocked_packets[0]!.id).toBe('p4');

    const action3 = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2', 'p3', 'p4'] }),
      packets: [
        makePacket('p1'),
        makePacket('p2', ['p1']),
        makePacket('p3', ['p1']),
        makePacket('p4', ['p2', 'p3']),
      ],
      completionIds: new Set(['p1', 'p2', 'p3']),
    }));
    expect(action3.ready_packets).toEqual(['p4']);
  });

  it('EX-U9: in-progress packet is reported as in_progress', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [makePacket('p1', [], '2026-03-21T00:00:00Z')],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.in_progress_packets).toEqual(['p1']);
    expect(action.ready_packets).toEqual([]);
  });

  it('EX-U10: all packets blocked produces blocked action', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [makePacket('p1', ['external-dep'])],
    }));
    expect(action.kind).toBe('blocked');
    expect(action.blocked_packets).toHaveLength(1);
  });

  it('EX-U11: executing status is allowed', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ status: 'executing', packets: ['p1'] }),
      packets: [makePacket('p1')],
    }));
    expect(action.kind).toBe('spawn_packets');
  });

  it('EX-U12: completed status is not allowed for execution', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ status: 'completed', packets: ['p1'] }),
    }));
    expect(action.kind).toBe('not_approved');
  });

  it('EX-U13: message includes progress counts', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2', 'p3'] }),
      packets: [makePacket('p1'), makePacket('p2'), makePacket('p3', ['p1', 'p2'])],
      completionIds: new Set(['p1']),
    }));
    expect(action.message).toContain('1/3');
    expect(action.ready_packets).toEqual(['p2']);
  });

  it('EX-U14: produce_report message suggests QA report tool', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ id: 'my-feature', packets: ['p1'] }),
      packets: [makePacket('p1')],
      completionIds: new Set(['p1']),
    }));
    expect(action.kind).toBe('produce_report');
    expect(action.message).toContain('report');
    expect(action.message).toContain('my-feature');
  });

  it('EX-U15: all complete with report and no architectural packets produces all_complete', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [makePacket('p1')],
      completionIds: new Set(['p1']),
      hasReport: true,
    }));
    expect(action.kind).toBe('all_complete');
    expect(action.message).toContain('ready for delivery');
  });

  it('EX-U16: architectural packet without acceptance produces awaiting_acceptance', () => {
    const archPacket = { ...makePacket('p1'), change_class: 'architectural' as const };
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [archPacket],
      completionIds: new Set(['p1']),
      hasReport: true,
    }));
    expect(action.kind).toBe('awaiting_acceptance');
    expect(action.message).toContain('p1');
    expect(action.message).toContain('accept');
  });

  it('EX-U17: architectural packet with acceptance produces all_complete', () => {
    const archPacket = { ...makePacket('p1'), change_class: 'architectural' as const };
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [archPacket],
      completionIds: new Set(['p1']),
      acceptanceIds: new Set(['p1']),
      hasReport: true,
    }));
    expect(action.kind).toBe('all_complete');
  });

  it('EX-U18: mixed packets — only architectural ones need acceptance', () => {
    const localPacket = makePacket('p1');
    const archPacket = { ...makePacket('p2'), change_class: 'architectural' as const };
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2'] }),
      packets: [localPacket, archPacket],
      completionIds: new Set(['p1', 'p2']),
      hasReport: true,
    }));
    expect(action.kind).toBe('awaiting_acceptance');
    expect(action.message).toContain('p2');
    expect(action.message).not.toContain('p1');
  });
});
