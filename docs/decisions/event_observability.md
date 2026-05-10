---
name: factory-event-observability
description: Factory emits typed events during pipeline execution. Events have provenance labels distinguishing live runs from tests, healthchecks, replays, and dry runs. Events are recorded as a stream consumable by the recovery layer, the future memory write-side, and external tooling. This is foundational — the recovery scenarios in Phase 6 are event classifications, and the memory write-side will extract facts from event streams.
type: project
---

# Event Observability

## Decision

Factory emits **typed events** during pipeline execution. Events are written to the host's tracked artifact tree as a stream. Each event carries a **provenance label** that distinguishes its origin (live run, test, healthcheck, replay, dry run) so consumers can filter appropriately.

This is the observability backbone the architecture has been missing. It underpins:

- **Phase 6 (recovery layer):** failure scenarios become events; recovery recipes match on event types
- **The future memory write-side:** facts are extracted from event streams (architectural facts from spec.planned events, recurring failures from packet.failed events, code patterns from packet.completed events)
- **Future operator tooling:** a doctor command, a status dashboard, an external dispatcher (clawhip-style) — all consume the event stream

## Context

Two patterns from the external research surfaced the gap:

- **claw-code's lane events** — typed enum (Started, Ready, Blocked, Red, Green, Failed, Reconciled, etc.) with provenance labels (LiveLane, Test, Healthcheck, Replay, Transport). The events are the system's nervous system.
- **claurst's session_memory** — extracts facts from accumulated session content. The natural input to extraction is structured events, not unstructured logs.

The first pass of `specs/single-entry-pipeline.md` had Phase 6 (recovery) operating on ad-hoc failure detection — string-matching exit codes and stderr to classify into 8 scenarios. That works but couples recovery's correctness to the format of provider error output. Events make recovery operate on a stable internal contract instead.

Reference: [`research/claw_code_audit.md`](../research/claw_code_audit.md) §4 (lane events as canonical event schema), §6 (recovery recipes consuming worker failure events).

## What this decides

1. **Factory emits typed events at every meaningful state transition** during pipeline execution. The taxonomy is closed (a TypeScript enum or string-literal union) — unknown event types are rejected.

2. **Each event carries a provenance label.** At minimum:
   - `live_run` — the canonical case
   - `test` — synthetic events from test suites
   - `healthcheck` — emitted by future preflight tools
   - `replay` — events emitted while replaying historical streams
   - `dry_run` — emitted during `--dry-run` invocations
   
   Consumers filter by provenance. A recovery recipe operating on `live_run` events ignores `test` events. The future memory write-side ingests `live_run` events; tests don't pollute the trained memory.

3. **Events are written to the host's tracked artifact tree.** Specific path TBD by the implementation spec; likely `factory/events/<pipeline-run-id>.jsonl` (one JSONL file per run). The host owns the records.

4. **Event-emission is structured, not free-form.** Each event is `{ event_type, timestamp, provenance, payload }`. Payload schema varies per event type but is well-defined. Free-form `console.log` is not an event.

5. **The recovery layer (Phase 6) is event-driven.** When the orchestrator's runner detects a failure, it emits an event with classification fields; the recovery recipe matches on the event, not on the original error string.

6. **Events are append-only during a run.** No event is rewritten or deleted mid-run. Compaction/rotation is a separate concern (out of scope).

## Event taxonomy (initial)

The implementation spec defines the full set; an indicative starting list:

- **Pipeline lifecycle:** `pipeline.started`, `pipeline.spec_resolved`, `pipeline.finished`, `pipeline.failed`
- **Spec lifecycle:** `spec.started`, `spec.blocked`, `spec.completed` (status field carries success/failure)
- **Phase lifecycle:** `phase.started`, `phase.completed` (payload includes `outcome: 'ok' | 'failed'` — there is no separate `phase.failed` event)
- **Packet lifecycle:** `packet.started`, `packet.review_requested`, `packet.review_approved`, `packet.changes_requested`, `packet.completed`, `packet.failed`
- **Verification:** `verification.passed`, `verification.failed`
- **Recovery:** `recovery.attempt_started`, `recovery.succeeded`, `recovery.exhausted`, `recovery.escalated`
- **Cost:** `cost.cap_crossed` (companion to the cost visibility decision)
- **Provider:** `provider.unavailable`, `provider.failover_attempted` (deferred — Phase 7 ships failover via the existing `recovery.*` events instead of new provider-specific events)

This list is not load-bearing here; the implementation spec authors it. The Phase 5.5 / 5.7 / 6 / 7 implementations are the source of truth — see the `EventType` union in `tools/pipeline/events.ts`.

## What this does NOT decide

- **Exact event payload schemas.** Per-event-type schemas go in the implementation spec.
- **Storage format and rotation.** JSONL is the obvious starting point; rotation/archival deferred.
- **Real-time event consumers** (e.g., a Discord-like dispatcher or live-tailing dashboard). Out of scope for the architecture; possible future feature.
- **Event sourcing as a primary state model.** Events are an observability stream, not the state of record. Packet status is still the source of truth in `packets/<id>.json`. Events are derived (or co-emitted) from that state.
- **Implementation timing.** Could land as a sister spec before Phase 6, or as the first part of Phase 6, or fold into Phase 6's existing scope. The roadmap discussion that follows this decision will sequence it.
- **Provenance labels beyond the initial five.** New labels can be added later if the need arises (e.g., a `benchmark` provenance).

## References

- [`research/claw_code_audit.md`](../research/claw_code_audit.md) §4 (lane events — typed enum, provenance labels), §6 (recovery recipes consume events)
- [`research/claurst_audit.md`](../research/claurst_audit.md) §9.2 (session_memory extracts from accumulated content; events make this clean)
- [`single_entry_pipeline.md`](single_entry_pipeline.md) — Phase 6 recovery layer; events are the substrate
- [`cost_visibility.md`](cost_visibility.md) — companion decision; cost-cap-crossings emit events
- [`memory_scope_split.md`](memory_scope_split.md) — future memory write-side ingests live_run events
