/**
 * Tests for factory status derivation — the pure logic.
 */

import { describe, it, expect } from 'vitest';
import { deriveFactoryStatus } from '../status.js';
import type { StatusInput } from '../status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePacket(
  id: string,
  overrides: Partial<{
    title: string;
    change_class: string;
    started_at: string | null;
    dependencies: string[];
  }> = {},
) {
  return {
    id,
    title: overrides.title ?? `Packet ${id}`,
    change_class: overrides.change_class ?? 'local',
    started_at: overrides.started_at !== undefined ? overrides.started_at : '2026-03-20T00:00:00Z',
    dependencies: overrides.dependencies ?? [],
  };
}

function makeCompletion(packetId: string, allPass = true) {
  return {
    packet_id: packetId,
    verification: {
      tests_pass: allPass,
      build_pass: allPass,
      lint_pass: allPass,
      ci_pass: allPass,
    },
  };
}

function makeAcceptance(packetId: string) {
  return { packet_id: packetId };
}

function makeInput(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    packets: overrides.packets ?? [],
    completions: overrides.completions ?? [],
    acceptances: overrides.acceptances ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveFactoryStatus', () => {
  it('FS-U1: all clear with no packets', () => {
    const status = deriveFactoryStatus(makeInput());
    expect(status.summary.total).toBe(0);
    expect(status.next_action.kind).toBe('all_clear');
    expect(status.incomplete).toEqual([]);
  });

  it('FS-U2: all clear when all packets are accepted', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1'), makePacket('s2')],
      completions: [makeCompletion('s1'), makeCompletion('s2')],
    }));
    expect(status.summary.accepted).toBe(2);
    expect(status.next_action.kind).toBe('all_clear');
  });

  it('FS-U3: incomplete packet produces complete_packet next action', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1'), makePacket('s2')],
      completions: [makeCompletion('s1')],
    }));
    expect(status.incomplete).toHaveLength(1);
    expect(status.incomplete[0]!.id).toBe('s2');
    expect(status.next_action.kind).toBe('complete_packet');
    expect(status.next_action.packet_id).toBe('s2');
  });

  it('FS-U4: architectural packet awaiting human acceptance', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1', { change_class: 'architectural' })],
      completions: [makeCompletion('s1')],
    }));
    expect(status.awaiting_acceptance).toHaveLength(1);
    expect(status.next_action.kind).toBe('accept_packet');
    expect(status.next_action.packet_id).toBe('s1');
  });

  it('FS-U5: cross-cutting with passing verification is accepted with audit flag', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1', { change_class: 'cross_cutting' })],
      completions: [makeCompletion('s1')],
    }));
    expect(status.summary.accepted).toBe(1);
    expect(status.audit_pending).toHaveLength(1);
    expect(status.audit_pending[0]!.id).toBe('s1');
    expect(status.next_action.kind).toBe('all_clear');
  });

  it('FS-U6: cross-cutting with human acceptance clears audit', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1', { change_class: 'cross_cutting' })],
      completions: [makeCompletion('s1')],
      acceptances: [makeAcceptance('s1')],
    }));
    expect(status.audit_pending).toHaveLength(0);
    expect(status.next_action.kind).toBe('all_clear');
  });

  it('FS-U7: not-started packets are not listed as incomplete', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1', { started_at: null })],
    }));
    expect(status.incomplete).toHaveLength(0);
    expect(status.summary.not_started).toBe(1);
  });

  it('FS-U8: oldest incomplete packet is recommended first', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [
        makePacket('s2', { started_at: '2026-03-20T02:00:00Z' }),
        makePacket('s1', { started_at: '2026-03-20T01:00:00Z' }),
      ],
    }));
    expect(status.next_action.packet_id).toBe('s1');
  });

  it('FS-U9: incomplete packet takes priority over acceptance debt', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [
        makePacket('s1', { change_class: 'architectural' }),
        makePacket('s2'),
      ],
      completions: [makeCompletion('s1')],
    }));
    expect(status.next_action.kind).toBe('complete_packet');
    expect(status.next_action.packet_id).toBe('s2');
  });

  it('FS-U10: failing verification prevents auto-acceptance for local', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1')],
      completions: [makeCompletion('s1', false)],
    }));
    expect(status.summary.completed).toBe(1);
    expect(status.summary.accepted).toBe(0);
  });

  it('FS-U11: summary counts across mixed states', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [
        makePacket('p1', { started_at: null }),
        makePacket('p2'),
        makePacket('p3', { change_class: 'architectural' }),
        makePacket('p4'),
      ],
      completions: [makeCompletion('p3'), makeCompletion('p4')],
    }));
    expect(status.summary.not_started).toBe(1);
    expect(status.summary.in_progress).toBe(1);
    expect(status.summary.completed).toBe(1);
    expect(status.summary.accepted).toBe(1);
    expect(status.summary.total).toBe(4);
  });

  it('FS-U12: next action command includes correct packet ID', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s14-some-work')],
    }));
    expect(status.next_action.command).toContain('s14-some-work');
  });

  it('FS-U13: feature filter scopes status to feature packets only', () => {
    const status = deriveFactoryStatus({
      packets: [makePacket('p1'), makePacket('p2'), makePacket('p3')],
      completions: [makeCompletion('p1')],
      acceptances: [],
      featureFilter: 'my-feature',
      features: [{ id: 'my-feature', intent: 'test', status: 'approved', packets: ['p1', 'p2'] }],
    });
    expect(status.summary.total).toBe(2);
    expect(status.feature_filter).toBe('my-feature');
  });

  it('FS-U14: no feature filter shows all packets', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('p1'), makePacket('p2')],
    }));
    expect(status.summary.total).toBe(2);
    expect(status.feature_filter).toBeNull();
  });

  it('FS-U15: produce_report when feature packets all complete but no report', () => {
    const status = deriveFactoryStatus({
      packets: [makePacket('p1'), makePacket('p2')],
      completions: [makeCompletion('p1'), makeCompletion('p2')],
      acceptances: [],
      features: [{ id: 'my-feature', intent: 'test', status: 'approved', packets: ['p1', 'p2'] }],
      reportIds: new Set<string>(),
    });
    expect(status.next_action.kind).toBe('produce_report');
    expect(status.next_action.command).toContain('my-feature');
  });

  it('FS-U16: all_clear when feature has report', () => {
    const status = deriveFactoryStatus({
      packets: [makePacket('p1'), makePacket('p2')],
      completions: [makeCompletion('p1'), makeCompletion('p2')],
      acceptances: [],
      features: [{ id: 'my-feature', intent: 'test', status: 'approved', packets: ['p1', 'p2'] }],
      reportIds: new Set<string>(['my-feature']),
    });
    expect(status.next_action.kind).toBe('all_clear');
  });

  it('FS-U17: produce_report takes priority over acceptance', () => {
    const status = deriveFactoryStatus({
      packets: [
        makePacket('p1', { change_class: 'architectural' }),
      ],
      completions: [makeCompletion('p1')],
      acceptances: [],
      features: [{ id: 'feat', intent: 'test', status: 'approved', packets: ['p1'] }],
      reportIds: new Set<string>(),
    });
    expect(status.next_action.kind).toBe('produce_report');
  });
});
