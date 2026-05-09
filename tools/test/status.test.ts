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
    kind: string;
    status: string | null;
    started_at: string | null;
    dependencies: string[];
  }> = {},
) {
  return {
    id,
    title: overrides.title ?? `Packet ${id}`,
    kind: overrides.kind ?? 'dev',
    status: overrides.status,
    started_at: overrides.started_at !== undefined ? overrides.started_at : '2026-03-20T00:00:00Z',
    dependencies: overrides.dependencies ?? [],
  };
}

function makeCompletion(packetId: string) {
  return { packet_id: packetId };
}

function makeInput(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    packets: overrides.packets ?? [],
    completions: overrides.completions ?? [],
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

  it('FS-U2: all clear when all packets are completed', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1'), makePacket('s2')],
      completions: [makeCompletion('s1'), makeCompletion('s2')],
    }));
    expect(status.summary.completed).toBe(2);
    expect(status.next_action.kind).toBe('all_clear');
  });

  it('FS-U3: incomplete packet surfaces in status', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1'), makePacket('s2')],
      completions: [makeCompletion('s1')],
    }));
    expect(status.incomplete).toHaveLength(1);
    expect(status.incomplete[0]!.id).toBe('s2');
  });

  it('FS-U4: not-started packets are not listed as incomplete', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('s1', { started_at: null })],
    }));
    expect(status.incomplete).toHaveLength(0);
    expect(status.summary.not_started).toBe(1);
  });

  it('FS-U5: summary counts across mixed states', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [
        makePacket('p1', { started_at: null }),
        makePacket('p2'),
        makePacket('p3'),
        makePacket('p4'),
      ],
      completions: [makeCompletion('p3'), makeCompletion('p4')],
    }));
    expect(status.summary.not_started).toBe(1);
    expect(status.summary.in_progress).toBe(1);
    expect(status.summary.completed).toBe(2);
    expect(status.summary.total).toBe(4);
  });

  it('FS-U6: feature filter scopes status to feature packets only', () => {
    const status = deriveFactoryStatus({
      packets: [makePacket('p1'), makePacket('p2'), makePacket('p3')],
      completions: [makeCompletion('p1')],
      featureFilter: 'my-feature',
      features: [{ id: 'my-feature', intent: 'test', status: 'planned', packets: ['p1', 'p2'] }],
    });
    expect(status.summary.total).toBe(2);
    expect(status.feature_filter).toBe('my-feature');
  });

  it('FS-U7: no feature filter shows all packets', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('p1'), makePacket('p2')],
    }));
    expect(status.summary.total).toBe(2);
    expect(status.feature_filter).toBeNull();
  });

  it('FS-U8: proposed intent becomes next planning action when execution is clear', () => {
    const status = deriveFactoryStatus({
      packets: [],
      completions: [],
      intents: [{ id: 'customer-dashboard', title: 'Customer dashboard', status: 'proposed', feature_id: null }],
      features: [],
    });
    expect(status.next_action.kind).toBe('plan_intent');
    expect(status.next_action.command).toContain('customer-dashboard');
  });

  it('FS-U9: features in progress produce run_feature action', () => {
    const status = deriveFactoryStatus({
      packets: [makePacket('p1')],
      completions: [],
      intents: [],
      features: [{ id: 'my-feature', intent: 'test', status: 'executing', packets: ['p1'] }],
    });
    expect(status.next_action.kind).toBe('run_feature');
    expect(status.features_in_progress).toHaveLength(1);
  });

  it('FS-U10: packet kind is exposed in summary', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [makePacket('p1', { kind: 'qa' })],
    }));
    expect(status.incomplete[0]!.kind).toBe('qa');
  });

  it('FS-U11: blocked packets with unmet dependencies are reported', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [
        makePacket('p1', { started_at: null, dependencies: ['external-dep'] }),
      ],
    }));
    expect(status.blocked).toHaveLength(1);
    expect(status.blocked[0]!.unmet_dependencies).toContain('external-dep');
  });

  it('FS-U17: planned feature with approved intent shows as in-progress', () => {
    const status = deriveFactoryStatus({
      packets: [],
      completions: [],
      intents: [{ id: 'customer-dashboard', title: 'Customer dashboard', status: 'approved', feature_id: 'customer-dashboard' }],
      features: [{ id: 'customer-dashboard', intent: 'Dashboard', status: 'planned', packets: [], intent_id: 'customer-dashboard' }],
    });
    expect(status.features_in_progress).toHaveLength(1);
    expect(status.next_action.kind).toBe('run_feature');
  });

  // ---------------------------------------------------------------------------
  // Phase 6 — terminal `failed` status is recognized as terminal-failed,
  // distinct from completed/in_progress/not_started.
  // ---------------------------------------------------------------------------

  it('FS-U18: packet with status="failed" is classified as failed (not in_progress / completed)', () => {
    const status = deriveFactoryStatus(makeInput({
      packets: [{
        ...makePacket('pkt-failed', { started_at: '2026-03-20T00:00:00Z' }),
        status: 'failed',
      }],
    }));
    // Failed list is populated; in_progress is NOT.
    expect(status.failed).toHaveLength(1);
    expect(status.failed[0]!.id).toBe('pkt-failed');
    expect(status.failed[0]!.status).toBe('failed');
    expect(status.incomplete).toHaveLength(0);
    expect(status.summary.failed).toBe(1);
    expect(status.summary.in_progress).toBe(0);
    expect(status.summary.completed).toBe(0);
  });

  it('FS-U19: failed packet does NOT appear in blocked even when dependencies unmet', () => {
    // A failed packet with unmet dependencies is still terminal-failed,
    // not "blocked" — blocked means "waiting and could still progress."
    const status = deriveFactoryStatus(makeInput({
      packets: [{
        ...makePacket('pkt-bad', {
          started_at: '2026-03-20T00:00:00Z',
          dependencies: ['nonexistent-dep'],
        }),
        status: 'failed',
      }],
    }));
    expect(status.failed).toHaveLength(1);
    expect(status.blocked).toHaveLength(0);
  });

  it('FS-U20: status="failed" takes precedence over started_at heuristic', () => {
    // Without the explicit 'failed' status check, started_at would
    // misclassify the packet as in_progress.
    const status = deriveFactoryStatus(makeInput({
      packets: [{
        ...makePacket('pkt-x', { started_at: '2026-03-20T00:00:00Z' }),
        status: 'failed',
      }],
    }));
    expect(status.summary.in_progress).toBe(0);
    expect(status.summary.failed).toBe(1);
  });
});
