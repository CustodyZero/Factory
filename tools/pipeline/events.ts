/**
 * Factory — Pipeline / Events (pure logic)
 *
 * Phase 5.5 of specs/single-entry-pipeline.md. Implements
 * docs/decisions/event_observability.md.
 *
 * This module owns the pure event types, payload taxonomy, provenance
 * derivation, and constructor helpers. It has NO filesystem dependency
 * by design: the I/O wrapper for emission lives in `tools/events.ts`,
 * and the split mirrors `pipeline/integrity.ts` (pure) vs
 * `tools/validate.ts` (CLI/I/O).
 *
 * SCOPE
 *
 *   - Closed `EventType` taxonomy (string-literal union). Phase 6
 *     extends this for recovery scenarios; Phase 5.7 adds cost events.
 *     The discriminated-union payload makes that extension purely
 *     additive — no restructuring of existing variants is required.
 *   - `Provenance` distinguishes live runs from tests/dry-runs.
 *     `deriveProvenance` is the sole authority on provenance — callers
 *     do not pass provenance directly. This pins the
 *     "tests cannot lie about being live runs" invariant: VITEST env
 *     var → 'test' is hardwired and wins over dryRun.
 *   - One `make*` constructor per event type. Each takes typed inputs
 *     and returns a fully-formed `Event`. The constructor is the
 *     single place that knows how to build a payload for its type.
 *
 * NON-SCOPE
 *
 *   - Filesystem reads or writes. See `tools/events.ts`.
 *   - Recovery / cost events. See Phase 6 / 5.7.
 *   - Schema validation against `schemas/event.schema.json`. The
 *     schema is documentation, not authoritative validation
 *     (per the Phase 4.6 decision recorded in the spec brief).
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where this event came from. Consumers filter by provenance: a future
 * recovery recipe operating on `live_run` events ignores `test` events;
 * the future memory write-side ingests `live_run` events only.
 *
 *   - `live_run`     — the canonical case
 *   - `test`         — synthetic events emitted under vitest
 *   - `healthcheck`  — reserved for future preflight tools
 *   - `replay`       — reserved for replaying historical streams
 *   - `dry_run`      — emitted during `--dry-run` invocations
 *
 * `healthcheck` and `replay` are part of the contract today but are
 * NOT yet auto-derived; only later phases set them explicitly.
 */
export type Provenance =
  | 'live_run'
  | 'test'
  | 'healthcheck'
  | 'replay'
  | 'dry_run';

/**
 * Derive the provenance for an event from the invocation context.
 *
 * Order matters and is invariant:
 *   1. Running under vitest (process.env.VITEST set) → 'test'.
 *      This is hardwired so tests cannot accidentally (or deliberately)
 *      label themselves as live runs.
 *   2. Else if `dryRun` is true → 'dry_run'.
 *   3. Else → 'live_run'.
 *
 * `'healthcheck'` and `'replay'` are not auto-derived; later phases
 * pass them explicitly when applicable.
 */
export function deriveProvenance(opts: { readonly dryRun: boolean }): Provenance {
  if (process.env['VITEST'] !== undefined) return 'test';
  if (opts.dryRun) return 'dry_run';
  return 'live_run';
}

// ---------------------------------------------------------------------------
// Event taxonomy (closed string-literal union)
//
// Adding a new event type:
//   1. Extend EventType below.
//   2. Add the matching payload variant to EventPayload.
//   3. Add a `make<Name>` constructor that returns Event<NewType>.
//
// Phase 6 / Phase 5.7 will follow exactly that pattern. Existing
// variants do not need to be touched.
// ---------------------------------------------------------------------------

export type EventType =
  // Pipeline lifecycle
  | 'pipeline.started'
  | 'pipeline.spec_resolved'
  | 'pipeline.finished'
  | 'pipeline.failed'
  // Spec lifecycle
  | 'spec.started'
  | 'spec.blocked'
  | 'spec.completed'
  // Phase lifecycle
  | 'phase.started'
  | 'phase.completed'
  // Packet lifecycle
  | 'packet.started'
  | 'packet.review_requested'
  | 'packet.review_approved'
  | 'packet.changes_requested'
  | 'packet.completed'
  | 'packet.failed'
  // Verification
  | 'verification.passed'
  | 'verification.failed';

// ---------------------------------------------------------------------------
// Payload variants — discriminated union keyed on `event_type`.
//
// Each payload type is a record of FACTS describing the transition.
// We keep the payload narrow on purpose: an event is an observability
// signal, not a state mirror. Consumers that need richer state read
// the canonical artifact files (packets/<id>.json, etc.) directly.
// ---------------------------------------------------------------------------

export type PhaseName = 'plan' | 'develop' | 'verify';

export type SpecCompletedStatus = 'completed' | 'failed';

export type VerificationKind = 'build' | 'lint' | 'tests' | 'ci';

export interface PipelineStartedPayload {
  readonly event_type: 'pipeline.started';
  readonly args: ReadonlyArray<string>;
  readonly dry_run: boolean;
}

export interface PipelineSpecResolvedPayload {
  readonly event_type: 'pipeline.spec_resolved';
  readonly spec_ids: ReadonlyArray<string>;
  readonly order: ReadonlyArray<string>;
}

export interface PipelineFinishedPayload {
  readonly event_type: 'pipeline.finished';
  readonly success: true;
  readonly message: string;
  readonly specs_completed: number;
}

export interface PipelineFailedPayload {
  readonly event_type: 'pipeline.failed';
  readonly success: false;
  readonly message: string;
  readonly specs_completed: number;
  readonly specs_failed: number;
  readonly specs_blocked: number;
}

export interface SpecStartedPayload {
  readonly event_type: 'spec.started';
  readonly spec_id: string;
}

export interface SpecBlockedPayload {
  readonly event_type: 'spec.blocked';
  readonly spec_id: string;
  readonly blocked_by: ReadonlyArray<string>;
  readonly reason: string;
}

export interface SpecCompletedPayload {
  readonly event_type: 'spec.completed';
  readonly spec_id: string;
  readonly status: SpecCompletedStatus;
  readonly feature_id: string | null;
  readonly packets_completed: ReadonlyArray<string>;
  readonly packets_failed: ReadonlyArray<string>;
  readonly reason?: string;
}

export interface PhaseStartedPayload {
  readonly event_type: 'phase.started';
  readonly phase: PhaseName;
  readonly spec_id: string | null;
}

export interface PhaseCompletedPayload {
  readonly event_type: 'phase.completed';
  readonly phase: PhaseName;
  readonly spec_id: string | null;
  readonly outcome: 'ok' | 'failed';
}

export interface PacketStartedPayload {
  readonly event_type: 'packet.started';
  readonly packet_id: string;
}

export interface PacketReviewRequestedPayload {
  readonly event_type: 'packet.review_requested';
  readonly packet_id: string;
  readonly review_iteration: number;
}

export interface PacketReviewApprovedPayload {
  readonly event_type: 'packet.review_approved';
  readonly packet_id: string;
  readonly review_iteration: number;
}

export interface PacketChangesRequestedPayload {
  readonly event_type: 'packet.changes_requested';
  readonly packet_id: string;
  readonly review_iteration: number;
}

export interface PacketCompletedPayload {
  readonly event_type: 'packet.completed';
  readonly packet_id: string;
}

export interface PacketFailedPayload {
  readonly event_type: 'packet.failed';
  readonly packet_id: string;
  readonly reason: string;
}

export interface VerificationPassedPayload {
  readonly event_type: 'verification.passed';
  readonly packet_id: string;
  readonly checks: ReadonlyArray<VerificationKind>;
}

export interface VerificationFailedPayload {
  readonly event_type: 'verification.failed';
  readonly packet_id: string;
  readonly failed_checks: ReadonlyArray<VerificationKind>;
}

export type EventPayload =
  | PipelineStartedPayload
  | PipelineSpecResolvedPayload
  | PipelineFinishedPayload
  | PipelineFailedPayload
  | SpecStartedPayload
  | SpecBlockedPayload
  | SpecCompletedPayload
  | PhaseStartedPayload
  | PhaseCompletedPayload
  | PacketStartedPayload
  | PacketReviewRequestedPayload
  | PacketReviewApprovedPayload
  | PacketChangesRequestedPayload
  | PacketCompletedPayload
  | PacketFailedPayload
  | VerificationPassedPayload
  | VerificationFailedPayload;

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

/**
 * The wire format for a single event line in the JSONL file.
 *
 *   - `event_type` is the discriminator; payload's `event_type` matches.
 *   - `timestamp` is an ISO-8601 string.
 *   - `provenance` is set by the emitter via deriveProvenance.
 *   - `run_id` ties this event to its pipeline invocation.
 *   - `payload` carries the per-event-type fields.
 *
 * The redundancy of `event_type` at both the envelope and payload
 * level lets readers narrow on the envelope without parsing the
 * payload AND lets a payload variant stand alone if it's lifted out.
 */
export interface Event<P extends EventPayload = EventPayload> {
  readonly event_type: P['event_type'];
  readonly timestamp: string;
  readonly provenance: Provenance;
  readonly run_id: string;
  readonly payload: P;
}

// ---------------------------------------------------------------------------
// Run-id generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique run id for a single pipeline invocation.
 *
 * Format: `<filesystem-safe ISO timestamp>-<8-hex-char random suffix>`
 * Example: `2026-05-02T07-52-06Z-a1b2c3d4`
 *
 * The colons in a normal ISO string are filesystem-hostile (Windows
 * cannot use them in filenames), so we substitute hyphens. The fixed
 * 8-hex random suffix guarantees that two invocations starting in the
 * same millisecond produce different ids.
 *
 * `clock` is injectable for testing; default is `Date.now()`.
 */
export function newRunId(clock: () => Date = () => new Date()): string {
  const iso = clock().toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  // Strip milliseconds and replace ':' with '-' for filesystem safety.
  // Example transform:
  //   2026-05-02T07:52:06.123Z -> 2026-05-02T07-52-06Z
  const stamp = iso.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  const suffix = randomBytes(4).toString('hex');
  return `${stamp}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Constructor helpers
//
// Each constructor sets `event_type` exactly once (at both the envelope
// and the payload). Discriminated-union narrowing means a caller of
// `makePipelineStarted` gets a value typed as `Event<PipelineStartedPayload>`.
// ---------------------------------------------------------------------------

interface BaseInputs {
  readonly run_id: string;
  readonly provenance: Provenance;
  readonly timestamp?: string; // ISO; default now
}

function nowIso(): string { return new Date().toISOString(); }

function envelope<P extends EventPayload>(
  base: BaseInputs,
  payload: P,
): Event<P> {
  return {
    event_type: payload.event_type,
    timestamp: base.timestamp ?? nowIso(),
    provenance: base.provenance,
    run_id: base.run_id,
    payload,
  };
}

export function makePipelineStarted(
  base: BaseInputs,
  fields: { readonly args: ReadonlyArray<string>; readonly dry_run: boolean },
): Event<PipelineStartedPayload> {
  return envelope(base, {
    event_type: 'pipeline.started',
    args: [...fields.args],
    dry_run: fields.dry_run,
  });
}

export function makePipelineSpecResolved(
  base: BaseInputs,
  fields: { readonly spec_ids: ReadonlyArray<string>; readonly order: ReadonlyArray<string> },
): Event<PipelineSpecResolvedPayload> {
  return envelope(base, {
    event_type: 'pipeline.spec_resolved',
    spec_ids: [...fields.spec_ids],
    order: [...fields.order],
  });
}

export function makePipelineFinished(
  base: BaseInputs,
  fields: { readonly message: string; readonly specs_completed: number },
): Event<PipelineFinishedPayload> {
  return envelope(base, {
    event_type: 'pipeline.finished',
    success: true,
    message: fields.message,
    specs_completed: fields.specs_completed,
  });
}

export function makePipelineFailed(
  base: BaseInputs,
  fields: {
    readonly message: string;
    readonly specs_completed: number;
    readonly specs_failed: number;
    readonly specs_blocked: number;
  },
): Event<PipelineFailedPayload> {
  return envelope(base, {
    event_type: 'pipeline.failed',
    success: false,
    message: fields.message,
    specs_completed: fields.specs_completed,
    specs_failed: fields.specs_failed,
    specs_blocked: fields.specs_blocked,
  });
}

export function makeSpecStarted(
  base: BaseInputs,
  fields: { readonly spec_id: string },
): Event<SpecStartedPayload> {
  return envelope(base, {
    event_type: 'spec.started',
    spec_id: fields.spec_id,
  });
}

export function makeSpecBlocked(
  base: BaseInputs,
  fields: {
    readonly spec_id: string;
    readonly blocked_by: ReadonlyArray<string>;
    readonly reason: string;
  },
): Event<SpecBlockedPayload> {
  return envelope(base, {
    event_type: 'spec.blocked',
    spec_id: fields.spec_id,
    blocked_by: [...fields.blocked_by],
    reason: fields.reason,
  });
}

export function makeSpecCompleted(
  base: BaseInputs,
  fields: {
    readonly spec_id: string;
    readonly status: SpecCompletedStatus;
    readonly feature_id: string | null;
    readonly packets_completed: ReadonlyArray<string>;
    readonly packets_failed: ReadonlyArray<string>;
    readonly reason?: string;
  },
): Event<SpecCompletedPayload> {
  const payload: SpecCompletedPayload = fields.reason !== undefined
    ? {
        event_type: 'spec.completed',
        spec_id: fields.spec_id,
        status: fields.status,
        feature_id: fields.feature_id,
        packets_completed: [...fields.packets_completed],
        packets_failed: [...fields.packets_failed],
        reason: fields.reason,
      }
    : {
        event_type: 'spec.completed',
        spec_id: fields.spec_id,
        status: fields.status,
        feature_id: fields.feature_id,
        packets_completed: [...fields.packets_completed],
        packets_failed: [...fields.packets_failed],
      };
  return envelope(base, payload);
}

export function makePhaseStarted(
  base: BaseInputs,
  fields: { readonly phase: PhaseName; readonly spec_id: string | null },
): Event<PhaseStartedPayload> {
  return envelope(base, {
    event_type: 'phase.started',
    phase: fields.phase,
    spec_id: fields.spec_id,
  });
}

export function makePhaseCompleted(
  base: BaseInputs,
  fields: {
    readonly phase: PhaseName;
    readonly spec_id: string | null;
    readonly outcome: 'ok' | 'failed';
  },
): Event<PhaseCompletedPayload> {
  return envelope(base, {
    event_type: 'phase.completed',
    phase: fields.phase,
    spec_id: fields.spec_id,
    outcome: fields.outcome,
  });
}

export function makePacketStarted(
  base: BaseInputs,
  fields: { readonly packet_id: string },
): Event<PacketStartedPayload> {
  return envelope(base, {
    event_type: 'packet.started',
    packet_id: fields.packet_id,
  });
}

export function makePacketReviewRequested(
  base: BaseInputs,
  fields: { readonly packet_id: string; readonly review_iteration: number },
): Event<PacketReviewRequestedPayload> {
  return envelope(base, {
    event_type: 'packet.review_requested',
    packet_id: fields.packet_id,
    review_iteration: fields.review_iteration,
  });
}

export function makePacketReviewApproved(
  base: BaseInputs,
  fields: { readonly packet_id: string; readonly review_iteration: number },
): Event<PacketReviewApprovedPayload> {
  return envelope(base, {
    event_type: 'packet.review_approved',
    packet_id: fields.packet_id,
    review_iteration: fields.review_iteration,
  });
}

export function makePacketChangesRequested(
  base: BaseInputs,
  fields: { readonly packet_id: string; readonly review_iteration: number },
): Event<PacketChangesRequestedPayload> {
  return envelope(base, {
    event_type: 'packet.changes_requested',
    packet_id: fields.packet_id,
    review_iteration: fields.review_iteration,
  });
}

export function makePacketCompleted(
  base: BaseInputs,
  fields: { readonly packet_id: string },
): Event<PacketCompletedPayload> {
  return envelope(base, {
    event_type: 'packet.completed',
    packet_id: fields.packet_id,
  });
}

export function makePacketFailed(
  base: BaseInputs,
  fields: { readonly packet_id: string; readonly reason: string },
): Event<PacketFailedPayload> {
  return envelope(base, {
    event_type: 'packet.failed',
    packet_id: fields.packet_id,
    reason: fields.reason,
  });
}

export function makeVerificationPassed(
  base: BaseInputs,
  fields: { readonly packet_id: string; readonly checks: ReadonlyArray<VerificationKind> },
): Event<VerificationPassedPayload> {
  return envelope(base, {
    event_type: 'verification.passed',
    packet_id: fields.packet_id,
    checks: [...fields.checks],
  });
}

export function makeVerificationFailed(
  base: BaseInputs,
  fields: {
    readonly packet_id: string;
    readonly failed_checks: ReadonlyArray<VerificationKind>;
  },
): Event<VerificationFailedPayload> {
  return envelope(base, {
    event_type: 'verification.failed',
    packet_id: fields.packet_id,
    failed_checks: [...fields.failed_checks],
  });
}
