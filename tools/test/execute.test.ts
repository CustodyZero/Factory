/**
 * Tests for factory execute — the stateless action resolver.
 */

import { describe, it, expect } from 'vitest';
import { resolveExecuteAction } from '../execute.js';
import type { Feature, ExecuteInput, PacketAssignment } from '../execute.js';

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

function makeRuntimeQaPacket(id: string, verifies: string, deps: string[] = [], envDeps: string[] = []) {
  return {
    ...makeQaPacket(id, verifies, deps),
    environment_dependencies: envDeps,
    acceptance_criteria: ['Run the code and verify the browser UI renders correctly'],
  };
}

function makeInput(overrides: Partial<ExecuteInput> = {}): ExecuteInput {
  return {
    feature: overrides.feature ?? makeFeature(),
    packets: overrides.packets ?? [],
    completionIds: overrides.completionIds ?? new Set(),
    acceptanceIds: overrides.acceptanceIds ?? new Set(),
  };
}

function readyIds(assignments: ReadonlyArray<PacketAssignment>): string[] {
  return assignments.map((a) => a.packet_id);
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

  it('EX-U3: single dev packet produces spawn_packets with developer persona', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [makeDevPacket('p1')],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toEqual([{
      packet_id: 'p1',
      persona: 'developer',
      task: 'implement',
      model: 'opus',
      instructions: [],
      start_command: 'npx tsx tools/start.ts p1',
    }]);
  });

  it('EX-U4: dev/qa pair — QA blocked until dev completes', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
      packets: [makeDevPacket('dev-1'), makeQaPacket('qa-1', 'dev-1', ['dev-1'])],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(readyIds(action.ready_packets)).toEqual(['dev-1']);
    expect(action.blocked_packets).toHaveLength(1);
    expect(action.blocked_packets[0]!.id).toBe('qa-1');
  });

  it('EX-U5: dev complete — QA becomes ready with qa persona', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
      packets: [makeDevPacket('dev-1'), makeQaPacket('qa-1', 'dev-1', ['dev-1'])],
      completionIds: new Set(['dev-1']),
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toEqual([{
      packet_id: 'qa-1',
      persona: 'qa',
      task: 'verify',
      model: 'opus',
      instructions: [],
      start_command: 'npx tsx tools/start.ts qa-1',
    }]);
  });

  it('EX-U6: independent dev packets are all ready for parallel spawn', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2'] }),
      packets: [makeDevPacket('p1'), makeDevPacket('p2')],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(readyIds(action.ready_packets)).toEqual(['p1', 'p2']);
  });

  it('EX-U7: dependent packet is blocked until dependency completes', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2'] }),
      packets: [makeDevPacket('p1'), makeDevPacket('p2', ['p1'])],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(readyIds(action.ready_packets)).toEqual(['p1']);
    expect(action.blocked_packets).toHaveLength(1);
    expect(action.blocked_packets[0]!.id).toBe('p2');
  });

  it('EX-U8: completing dependency unblocks dependent packet', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2'] }),
      packets: [makeDevPacket('p1'), makeDevPacket('p2', ['p1'])],
      completionIds: new Set(['p1']),
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(readyIds(action.ready_packets)).toEqual(['p2']);
    expect(action.completed_packets).toEqual(['p1']);
  });

  it('EX-U9: diamond graph resolves parallelism correctly', () => {
    const packets = [
      makeDevPacket('p1'),
      makeDevPacket('p2', ['p1']),
      makeDevPacket('p3', ['p1']),
      makeDevPacket('p4', ['p2', 'p3']),
    ];
    const feature = makeFeature({ packets: ['p1', 'p2', 'p3', 'p4'] });

    expect(readyIds(resolveExecuteAction(makeInput({ feature, packets })).ready_packets)).toEqual(['p1']);

    const action2 = resolveExecuteAction(makeInput({ feature, packets, completionIds: new Set(['p1']) }));
    expect(readyIds(action2.ready_packets)).toEqual(['p2', 'p3']);

    const action3 = resolveExecuteAction(makeInput({ feature, packets, completionIds: new Set(['p1', 'p2', 'p3']) }));
    expect(readyIds(action3.ready_packets)).toEqual(['p4']);
  });

  it('EX-U10: in-progress packet is reported with persona', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [makeDevPacket('p1', [], '2026-03-21T00:00:00Z')],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.in_progress_packets).toEqual([{
      packet_id: 'p1',
      persona: 'developer',
      task: 'implement',
      model: 'opus',
      instructions: [],
      start_command: 'npx tsx tools/start.ts p1',
    }]);
    expect(action.ready_packets).toEqual([]);
  });

  it('EX-U11: all packets blocked produces blocked action', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1'] }),
      packets: [makeDevPacket('p1', ['external-dep'])],
    }));
    expect(action.kind).toBe('blocked');
    expect(action.blocked_packets).toHaveLength(1);
  });

  it('EX-U12: executing status is allowed', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ status: 'executing', packets: ['p1'] }),
      packets: [makeDevPacket('p1')],
    }));
    expect(action.kind).toBe('spawn_packets');
  });

  it('EX-U13: completed status is not allowed for execution', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ status: 'completed', packets: ['p1'] }),
    }));
    expect(action.kind).toBe('not_approved');
  });

  it('EX-U14: message includes progress counts', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['p1', 'p2', 'p3'] }),
      packets: [makeDevPacket('p1'), makeDevPacket('p2'), makeDevPacket('p3', ['p1', 'p2'])],
      completionIds: new Set(['p1']),
    }));
    expect(action.message).toContain('1/3');
    expect(readyIds(action.ready_packets)).toEqual(['p2']);
  });

  it('EX-U15: all local dev+qa complete produces all_complete', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
      packets: [makeDevPacket('dev-1'), makeQaPacket('qa-1', 'dev-1', ['dev-1'])],
      completionIds: new Set(['dev-1', 'qa-1']),
    }));
    expect(action.kind).toBe('all_complete');
    expect(action.message).toContain('ready for delivery');
  });

  it('EX-U16: architectural dev packet with QA complete but no acceptance produces awaiting_acceptance', () => {
    const archDev = { ...makeDevPacket('dev-1'), change_class: 'architectural' as const };
    const qaPacket = makeQaPacket('qa-1', 'dev-1', ['dev-1']);
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
      packets: [archDev, qaPacket],
      completionIds: new Set(['dev-1', 'qa-1']),
    }));
    expect(action.kind).toBe('awaiting_acceptance');
    expect(action.message).toContain('dev-1');
    expect(action.message).toContain('accept');
  });

  it('EX-U17: architectural dev packet with acceptance produces all_complete', () => {
    const archDev = { ...makeDevPacket('dev-1'), change_class: 'architectural' as const };
    const qaPacket = makeQaPacket('qa-1', 'dev-1', ['dev-1']);
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
      packets: [archDev, qaPacket],
      completionIds: new Set(['dev-1', 'qa-1']),
      acceptanceIds: new Set(['dev-1']),
    }));
    expect(action.kind).toBe('all_complete');
  });

  it('EX-U18: architectural dev packet without QA complete does not trigger awaiting_acceptance', () => {
    // If QA hasn't completed, the feature isn't "all complete" yet
    const archDev = { ...makeDevPacket('dev-1'), change_class: 'architectural' as const };
    const qaPacket = makeQaPacket('qa-1', 'dev-1', ['dev-1']);
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
      packets: [archDev, qaPacket],
      completionIds: new Set(['dev-1']),
    }));
    // QA is ready to execute, not awaiting_acceptance
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toEqual([{
      packet_id: 'qa-1',
      persona: 'qa',
      task: 'verify',
      model: 'opus',
      instructions: [],
      start_command: 'npx tsx tools/start.ts qa-1',
    }]);
  });

  it('EX-U19: mixed dev/qa — only architectural dev packets need acceptance', () => {
    const localDev = makeDevPacket('dev-1');
    const localQa = makeQaPacket('qa-1', 'dev-1', ['dev-1']);
    const archDev = { ...makeDevPacket('dev-2'), change_class: 'architectural' as const };
    const archQa = makeQaPacket('qa-2', 'dev-2', ['dev-2']);
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1', 'dev-2', 'qa-2'] }),
      packets: [localDev, localQa, archDev, archQa],
      completionIds: new Set(['dev-1', 'qa-1', 'dev-2', 'qa-2']),
    }));
    expect(action.kind).toBe('awaiting_acceptance');
    expect(action.message).toContain('dev-2');
    expect(action.message).not.toContain('dev-1');
  });

  it('EX-U20: full dev/qa lifecycle — dev → qa → acceptance → complete', () => {
    const archDev = { ...makeDevPacket('dev-1'), change_class: 'architectural' as const };
    const qaPacket = makeQaPacket('qa-1', 'dev-1', ['dev-1']);
    const feature = makeFeature({ packets: ['dev-1', 'qa-1'] });

    // Step 1: dev ready
    const a1 = resolveExecuteAction(makeInput({ feature, packets: [archDev, qaPacket] }));
    expect(a1.kind).toBe('spawn_packets');
    expect(a1.ready_packets).toEqual([{
      packet_id: 'dev-1',
      persona: 'developer',
      task: 'implement',
      model: 'opus',
      instructions: [],
      start_command: 'npx tsx tools/start.ts dev-1',
    }]);

    // Step 2: dev complete, qa ready
    const a2 = resolveExecuteAction(makeInput({ feature, packets: [archDev, qaPacket], completionIds: new Set(['dev-1']) }));
    expect(a2.kind).toBe('spawn_packets');
    expect(a2.ready_packets).toEqual([{
      packet_id: 'qa-1',
      persona: 'qa',
      task: 'verify',
      model: 'opus',
      instructions: [],
      start_command: 'npx tsx tools/start.ts qa-1',
    }]);

    // Step 3: both complete, awaiting acceptance
    const a3 = resolveExecuteAction(makeInput({ feature, packets: [archDev, qaPacket], completionIds: new Set(['dev-1', 'qa-1']) }));
    expect(a3.kind).toBe('awaiting_acceptance');

    // Step 4: accepted
    const a4 = resolveExecuteAction(makeInput({ feature, packets: [archDev, qaPacket], completionIds: new Set(['dev-1', 'qa-1']), acceptanceIds: new Set(['dev-1']) }));
    expect(a4.kind).toBe('all_complete');
  });

  it('EX-U21: persona instructions from config are included in assignment', () => {
    const personas = {
      planner: { description: 'planner', instructions: [], model: 'opus' as const },
      developer: { description: 'dev', instructions: ['Use MCP server X'], model: 'opus' as const },
      code_reviewer: { description: 'code_reviewer', instructions: [], model: 'sonnet' as const },
      qa: { description: 'qa', instructions: ['Check compliance'], model: 'sonnet' as const },
    };
    const action = resolveExecuteAction({
      ...makeInput({
        feature: makeFeature({ packets: ['dev-1'] }),
        packets: [makeDevPacket('dev-1')],
      }),
      personas,
    });
    expect(action.ready_packets).toEqual([{
      packet_id: 'dev-1',
      persona: 'developer',
      task: 'implement',
      model: 'opus',
      instructions: ['Use MCP server X'],
      start_command: 'npx tsx tools/start.ts dev-1',
    }]);
  });

  it('EX-U22: packet-level instructions merge with persona instructions', () => {
    const personas = {
      planner: { description: 'planner', instructions: [], model: 'opus' as const },
      developer: { description: 'dev', instructions: ['Always lint'], model: 'opus' as const },
      code_reviewer: { description: 'code_reviewer', instructions: [], model: 'sonnet' as const },
      qa: { description: 'qa', instructions: [], model: 'sonnet' as const },
    };
    const packet = { ...makeDevPacket('dev-1'), instructions: ['Requires GPU access'] };
    const action = resolveExecuteAction({
      ...makeInput({
        feature: makeFeature({ packets: ['dev-1'] }),
        packets: [packet],
      }),
      personas,
    });
    expect(action.ready_packets[0]!.instructions).toEqual(['Always lint', 'Requires GPU access']);
    expect(action.ready_packets[0]!.start_command).toBe('npx tsx tools/start.ts dev-1');
  });

  it('EX-U23: QA packet gets qa persona instructions', () => {
    const personas = {
      planner: { description: 'planner', instructions: [], model: 'opus' as const },
      developer: { description: 'dev', instructions: ['Dev instruction'], model: 'opus' as const },
      code_reviewer: { description: 'code_reviewer', instructions: [], model: 'sonnet' as const },
      qa: { description: 'qa', instructions: ['Review instruction'], model: 'sonnet' as const },
    };
    const action = resolveExecuteAction({
      ...makeInput({
        feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
        packets: [makeDevPacket('dev-1'), makeQaPacket('qa-1', 'dev-1', ['dev-1'])],
        completionIds: new Set(['dev-1']),
      }),
      personas,
    });
    expect(action.ready_packets[0]!.persona).toBe('qa');
    expect(action.ready_packets[0]!.model).toBe('sonnet');
    expect(action.ready_packets[0]!.instructions).toEqual(['Review instruction']);
  });

  it('EX-U24: no personas provided defaults to empty instructions and opus model', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1'] }),
      packets: [makeDevPacket('dev-1')],
    }));
    expect(action.ready_packets[0]!.instructions).toEqual([]);
    expect(action.ready_packets[0]!.model).toBe('opus');
  });

  it('EX-U25: model resolves from persona config', () => {
    const personas = {
      planner: { description: 'planner', instructions: [], model: 'opus' as const },
      developer: { description: 'dev', instructions: [], model: 'sonnet' as const },
      code_reviewer: { description: 'code_reviewer', instructions: [], model: 'sonnet' as const },
      qa: { description: 'qa', instructions: [], model: 'haiku' as const },
    };
    const action = resolveExecuteAction({
      ...makeInput({
        feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
        packets: [makeDevPacket('dev-1'), makeQaPacket('qa-1', 'dev-1', ['dev-1'])],
      }),
      personas,
    });
    expect(action.ready_packets[0]!.model).toBe('sonnet');
  });

  it('EX-U26: packet-level model overrides persona model', () => {
    const personas = {
      planner: { description: 'planner', instructions: [], model: 'opus' as const },
      developer: { description: 'dev', instructions: [], model: 'sonnet' as const },
      code_reviewer: { description: 'code_reviewer', instructions: [], model: 'sonnet' as const },
      qa: { description: 'qa', instructions: [], model: 'sonnet' as const },
    };
    const packet = { ...makeDevPacket('dev-1'), model: 'opus' as const };
    const action = resolveExecuteAction({
      ...makeInput({
        feature: makeFeature({ packets: ['dev-1'] }),
        packets: [packet],
      }),
      personas,
    });
    expect(action.ready_packets[0]!.model).toBe('opus');
  });

  it('EX-U27: model fallback chain — packet > persona > opus default', () => {
    // No persona config, no packet model → defaults to opus
    const a1 = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1'] }),
      packets: [makeDevPacket('dev-1')],
    }));
    expect(a1.ready_packets[0]!.model).toBe('opus');

    // Persona model set, no packet model → persona model
    const personas = {
      planner: { description: 'planner', instructions: [], model: 'opus' as const },
      developer: { description: 'dev', instructions: [], model: 'haiku' as const },
      code_reviewer: { description: 'code_reviewer', instructions: [] },
      qa: { description: 'qa', instructions: [] },
    };
    const a2 = resolveExecuteAction({
      ...makeInput({
        feature: makeFeature({ packets: ['dev-1'] }),
        packets: [makeDevPacket('dev-1')],
      }),
      personas,
    });
    expect(a2.ready_packets[0]!.model).toBe('haiku');

    // Packet model set → packet model wins
    const packet = { ...makeDevPacket('dev-1'), model: 'sonnet' as const };
    const a3 = resolveExecuteAction({
      ...makeInput({
        feature: makeFeature({ packets: ['dev-1'] }),
        packets: [packet],
      }),
      personas,
    });
    expect(a3.ready_packets[0]!.model).toBe('sonnet');
  });

  it('EX-U28: runtime QA packet without environment_dependencies is blocked before handoff', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
      packets: [makeDevPacket('dev-1'), makeRuntimeQaPacket('qa-1', 'dev-1', ['dev-1'])],
      completionIds: new Set(['dev-1']),
    }));
    expect(action.kind).toBe('blocked');
    expect(action.blocked_packets[0]?.id).toBe('qa-1');
    expect(action.blocked_packets[0]?.blocked_by[0]).toContain('environment_dependencies');
  });

  it('EX-U29: QA packet with environment_dependencies advertises evidence requirement', () => {
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
      packets: [makeDevPacket('dev-1'), makeRuntimeQaPacket('qa-1', 'dev-1', ['dev-1'], ['browser-env'])],
      completionIds: new Set(['dev-1']),
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets[0]?.instructions).toContain(
      'Evidence required before completion for environment_dependencies: browser-env',
    );
  });

  // -------------------------------------------------------------------------
  // Packet status field tests (Phase 2 — explicit lifecycle status)
  // -------------------------------------------------------------------------

  it('EX-U30: packet with implementing status and started_at is reported as in-progress', () => {
    const packet = { ...makeDevPacket('dev-1', [], '2026-03-21T00:00:00Z'), status: 'implementing' as const };
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1'] }),
      packets: [packet],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.in_progress_packets).toHaveLength(1);
    expect(action.in_progress_packets[0]!.packet_id).toBe('dev-1');
  });

  it('EX-U31: packet with completed status and completion record is reported as completed', () => {
    const packet = { ...makeDevPacket('dev-1'), status: 'completed' as const };
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1'] }),
      packets: [packet],
      completionIds: new Set(['dev-1']),
    }));
    expect(action.kind).toBe('all_complete');
  });

  // -------------------------------------------------------------------------
  // Code review lifecycle tests (Phase 3)
  // -------------------------------------------------------------------------

  it('EX-U32: dev packet with review_requested status dispatches code_reviewer persona', () => {
    const packet = {
      ...makeDevPacket('dev-1', [], '2026-03-21T00:00:00Z'),
      status: 'review_requested' as const,
      branch: 'feature/dev-1',
    };
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1'] }),
      packets: [packet],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toHaveLength(1);
    expect(action.ready_packets[0]!.packet_id).toBe('dev-1');
    expect(action.ready_packets[0]!.persona).toBe('code_reviewer');
    expect(action.ready_packets[0]!.task).toBe('review');
  });

  it('EX-U33: dev packet with changes_requested status dispatches developer for rework', () => {
    const packet = {
      ...makeDevPacket('dev-1', [], '2026-03-21T00:00:00Z'),
      status: 'changes_requested' as const,
      branch: 'feature/dev-1',
      review_iteration: 1,
    };
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1'] }),
      packets: [packet],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toHaveLength(1);
    expect(action.ready_packets[0]!.packet_id).toBe('dev-1');
    expect(action.ready_packets[0]!.persona).toBe('developer');
    expect(action.ready_packets[0]!.task).toBe('rework');
  });

  it('EX-U34: dev packet with review_approved status dispatches developer for finalize', () => {
    const packet = {
      ...makeDevPacket('dev-1', [], '2026-03-21T00:00:00Z'),
      status: 'review_approved' as const,
      branch: 'feature/dev-1',
    };
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1'] }),
      packets: [packet],
    }));
    expect(action.kind).toBe('spawn_packets');
    expect(action.ready_packets).toHaveLength(1);
    expect(action.ready_packets[0]!.packet_id).toBe('dev-1');
    expect(action.ready_packets[0]!.persona).toBe('developer');
    expect(action.ready_packets[0]!.task).toBe('finalize');
  });

  it('EX-U35: code_reviewer gets branch info in instructions', () => {
    const personas = {
      planner: { description: 'planner', instructions: [], model: 'opus' as const },
      developer: { description: 'dev', instructions: [], model: 'opus' as const },
      code_reviewer: { description: 'cr', instructions: ['Check invariants'], model: 'sonnet' as const },
      qa: { description: 'qa', instructions: [], model: 'sonnet' as const },
    };
    const packet = {
      ...makeDevPacket('dev-1', [], '2026-03-21T00:00:00Z'),
      status: 'review_requested' as const,
      branch: 'feature/dev-1',
    };
    const action = resolveExecuteAction({
      ...makeInput({
        feature: makeFeature({ packets: ['dev-1'] }),
        packets: [packet],
      }),
      personas,
    });
    expect(action.ready_packets[0]!.persona).toBe('code_reviewer');
    expect(action.ready_packets[0]!.task).toBe('review');
    expect(action.ready_packets[0]!.model).toBe('sonnet');
    expect(action.ready_packets[0]!.instructions).toContain('Check invariants');
    expect(action.ready_packets[0]!.instructions).toContain('Review branch: feature/dev-1');
  });

  it('EX-U36: full review lifecycle — implementing → review → changes → re-review → approve → complete', () => {
    const feature = makeFeature({ packets: ['dev-1', 'qa-1'] });
    const qaPacket = makeQaPacket('qa-1', 'dev-1', ['dev-1']);

    // Step 1: dev packet is implementing (in-progress)
    const devImpl = { ...makeDevPacket('dev-1', [], '2026-03-21T00:00:00Z'), status: 'implementing' as const };
    const a1 = resolveExecuteAction(makeInput({ feature, packets: [devImpl, qaPacket] }));
    expect(a1.in_progress_packets).toHaveLength(1);
    expect(a1.in_progress_packets[0]!.persona).toBe('developer');

    // Step 2: review requested — code_reviewer dispatched
    const devReview = { ...devImpl, status: 'review_requested' as const, branch: 'feature/dev-1' };
    const a2 = resolveExecuteAction(makeInput({ feature, packets: [devReview, qaPacket] }));
    expect(a2.ready_packets).toHaveLength(1);
    expect(a2.ready_packets[0]!.persona).toBe('code_reviewer');
    expect(a2.ready_packets[0]!.task).toBe('review');

    // Step 3: changes requested — developer dispatched for rework
    const devChanges = { ...devReview, status: 'changes_requested' as const, review_iteration: 1 };
    const a3 = resolveExecuteAction(makeInput({ feature, packets: [devChanges, qaPacket] }));
    expect(a3.ready_packets).toHaveLength(1);
    expect(a3.ready_packets[0]!.persona).toBe('developer');
    expect(a3.ready_packets[0]!.task).toBe('rework');

    // Step 4: re-request review
    const devReReview = { ...devChanges, status: 'review_requested' as const };
    const a4 = resolveExecuteAction(makeInput({ feature, packets: [devReReview, qaPacket] }));
    expect(a4.ready_packets).toHaveLength(1);
    expect(a4.ready_packets[0]!.persona).toBe('code_reviewer');
    expect(a4.ready_packets[0]!.task).toBe('review');

    // Step 5: approved — developer dispatched for finalize
    const devApproved = { ...devReReview, status: 'review_approved' as const };
    const a5 = resolveExecuteAction(makeInput({ feature, packets: [devApproved, qaPacket] }));
    expect(a5.ready_packets).toHaveLength(1);
    expect(a5.ready_packets[0]!.persona).toBe('developer');
    expect(a5.ready_packets[0]!.task).toBe('finalize');

    // Step 6: completed — QA unblocked
    const a6 = resolveExecuteAction(makeInput({
      feature,
      packets: [devApproved, qaPacket],
      completionIds: new Set(['dev-1']),
    }));
    expect(a6.ready_packets).toHaveLength(1);
    expect(a6.ready_packets[0]!.persona).toBe('qa');
    expect(a6.ready_packets[0]!.task).toBe('verify');
  });

  it('EX-U37: QA packets are not affected by review status routing', () => {
    // QA packets with a status field should still be handled normally
    const qaPacket = {
      ...makeQaPacket('qa-1', 'dev-1', ['dev-1']),
      status: 'implementing' as const,
      started_at: '2026-03-21T00:00:00Z',
    };
    const action = resolveExecuteAction(makeInput({
      feature: makeFeature({ packets: ['dev-1', 'qa-1'] }),
      packets: [makeDevPacket('dev-1'), qaPacket],
      completionIds: new Set(['dev-1']),
    }));
    expect(action.in_progress_packets).toHaveLength(1);
    expect(action.in_progress_packets[0]!.persona).toBe('qa');
  });
});
