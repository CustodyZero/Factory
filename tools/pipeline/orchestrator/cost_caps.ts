/**
 * Factory — Pipeline / Orchestrator / Cost Caps
 *
 * Phase 5.7 cost-cap enforcement, extracted from the orchestrator
 * driver loop. Each helper aggregates the relevant cost rows
 * (per-run via `aggregateRunCost`, per-day via `readDayCost`),
 * compares against the configured cap with `>=` semantics
 * (delegated to `checkCap`), and on crossing emits the
 * `cost.cap_crossed` event. The per-day variant additionally calls
 * `recordDayCapBlock` so subsequent same-day runs are rejected at
 * the orchestrator's pre-flight gate.
 *
 * The event-then-write-then-return order matches the original
 * inline implementation. The `running_total` returned by both
 * helpers is the same value carried in the emitted event payload —
 * the driver uses it for the human-readable summary line.
 *
 * When the configured cap is `undefined`, no work is done and
 * `{ crossed: false, running_total: null }` is returned. Callers
 * MUST treat `running_total: null` as "not measured" rather than
 * "$0.00 of unknown limit".
 */

import { appendEvent } from '../../events.js';
import { makeCostCapCrossed } from '../events.js';
import { checkCap } from '../cost.js';
import {
  aggregateRunCost,
  readDayCost,
  recordDayCapBlock,
} from '../../cost.js';

interface CapCheckResult {
  readonly crossed: boolean;
  readonly running_total: number | null;
}

/**
 * Per-run cost cap. Aggregates every cost row written under the
 * given run id (every invocation in plan/develop/verify writes
 * one) and compares against `cap`. On crossing, emits the
 * `cost.cap_crossed(per_run)` event before returning.
 *
 * The driver's contract: on `crossed === true`, set the
 * `runCapCrossed` flag and `break` out of the per-spec loop. The
 * post-loop bracket-close emits `pipeline.failed` with a message
 * naming the cap.
 */
export function checkPerRunCap(opts: {
  readonly runId: string;
  readonly artifactRoot: string;
  readonly cap: number | undefined;
  readonly eventBase: { readonly run_id: string; readonly dry_run: boolean };
  readonly specId: string;
}): CapCheckResult {
  if (opts.cap === undefined) {
    return { crossed: false, running_total: null };
  }
  const runAgg = aggregateRunCost(opts.runId, opts.artifactRoot);
  if (!checkCap(runAgg.total, opts.cap)) {
    return { crossed: false, running_total: runAgg.total };
  }
  appendEvent(
    makeCostCapCrossed(opts.eventBase, {
      scope: 'per_run',
      cap_dollars: opts.cap,
      running_total: runAgg.total,
      packet_id: null,
      spec_id: opts.specId,
    }),
    opts.artifactRoot,
  );
  return { crossed: true, running_total: runAgg.total };
}

/**
 * Per-day cost cap. Sums across every run-file for the local date
 * `today` and compares against `cap`. On crossing, emits the
 * `cost.cap_crossed(per_day)` event AND calls `recordDayCapBlock`
 * so subsequent same-day runs are rejected at the orchestrator's
 * pre-flight gate.
 *
 * The day-cap is NOT a per-run boundary — it crosses the run-level
 * boundary. Persisting the block-marker is what enforces the
 * "subsequent same-day runs blocked" contract.
 */
export function checkPerDayCap(opts: {
  readonly today: string;
  readonly artifactRoot: string;
  readonly cap: number | undefined;
  readonly eventBase: { readonly run_id: string; readonly dry_run: boolean };
  readonly specId: string;
}): CapCheckResult {
  if (opts.cap === undefined) {
    return { crossed: false, running_total: null };
  }
  const dayAgg = readDayCost(opts.today, opts.artifactRoot);
  if (!checkCap(dayAgg.total, opts.cap)) {
    return { crossed: false, running_total: dayAgg.total };
  }
  appendEvent(
    makeCostCapCrossed(opts.eventBase, {
      scope: 'per_day',
      cap_dollars: opts.cap,
      running_total: dayAgg.total,
      packet_id: null,
      spec_id: opts.specId,
    }),
    opts.artifactRoot,
  );
  recordDayCapBlock(opts.today, opts.artifactRoot);
  return { crossed: true, running_total: dayAgg.total };
}
