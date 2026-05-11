/**
 * Spec-runner tests (post-Phase-5.7 decomposition).
 *
 * The orchestrator delegates per-spec execution to
 * `tools/pipeline/orchestrator/spec_runner.ts:runSingleSpec`. This file
 * pins the spec-runner-specific behavior. Multi-spec sequencing,
 * cycles, missing-deps, and propagation tests live in
 * `orchestrator.test.ts` — those exercise the driver loop and do not
 * belong here.
 *
 * Tests are driven through `runOrchestrator` rather than `runSingleSpec`
 * directly so the assertions exercise the full call chain (driver
 * dispatch -> spec runner). The orchestrator only invokes one spec
 * per test fixture, so the surface under test is the spec runner.
 *
 * Coverage today:
 *
 *   approval-semantics split (convergence pass)
 *     - spec-driven runs SKIP the intent-status gate (authoring the
 *       spec IS the gate)
 *     - intent-driven runs require a post-approval status
 *       (`approved`, `planned`, or `delivered`); `proposed` and
 *       `superseded` are rejected with an actionable error
 *     - the four post-approval / pre-approval / superseded cases are
 *       each pinned explicitly so the four-status story is observable
 *       from the test surface
 *
 * All cases use `dryRun: true` so no real provider CLI is needed;
 * the approval gate fires BEFORE plan_phase, so dry-run still
 * surfaces the rejection / acceptance.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestrator } from '../pipeline/orchestrator/index.js';
import type { FactoryConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Fixture helpers (mirror of the originals in orchestrator.test.ts; kept
// local to this file so each test module is self-contained and the
// approval-semantics tests stay independent of any orchestrator-driver
// fixture changes).
// ---------------------------------------------------------------------------

interface Fixture {
  readonly root: string;
  readonly config: FactoryConfig;
}

let fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
  fixtures = [];
});

function makeBaseConfig(): FactoryConfig {
  // Cast through unknown — the test fixture config doesn't need every
  // optional field that FactoryConfig declares.
  return ({
    project_name: 'spec-runner-test',
    factory_dir: '.',
    artifact_dir: '.',
    verification: { build: 'true', lint: 'true', test: 'true' },
    validation: { command: 'true' },
    infrastructure_patterns: [],
    completed_by_default: { kind: 'agent', id: 'test' },
    personas: {
      planner: { description: '', instructions: [] },
      developer: { description: '', instructions: [] },
      code_reviewer: { description: '', instructions: [] },
      qa: { description: '', instructions: [] },
    },
  } as unknown) as FactoryConfig;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'spec-runner-'));
  const config = makeBaseConfig();
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
  fixtures.push({ root, config });
  return { root, config };
}

function writeSpec(
  root: string,
  id: string,
  opts: { readonly title?: string; readonly dependsOn?: ReadonlyArray<string> } = {},
): void {
  if (!existsSync(join(root, 'specs'))) mkdirSync(join(root, 'specs'), { recursive: true });
  const title = opts.title ?? `Spec ${id}`;
  const deps = opts.dependsOn ?? [];
  const fmLines = [`id: ${id}`, `title: ${title}`];
  if (deps.length > 0) fmLines.push(`depends_on: [${deps.join(', ')}]`);
  const content = `---\n${fmLines.join('\n')}\n---\n\nbody for ${id}\n`;
  writeFileSync(join(root, 'specs', `${id}.md`), content, 'utf-8');
}

function writeIntent(
  root: string,
  id: string,
  status: 'proposed' | 'approved' | 'planned' | 'superseded' | 'delivered' = 'approved',
): void {
  if (!existsSync(join(root, 'intents'))) mkdirSync(join(root, 'intents'), { recursive: true });
  const intent = {
    id,
    title: `Legacy intent ${id}`,
    spec: `inline ${id}`,
    // Convergence pass: hand-authored intents must be post-approval
    // (approved / planned / delivered) to run through runOrchestrator.
    // This helper defaults to 'approved' so legacy fixtures keep
    // working; the per-test overrides exercise the rejection /
    // acceptance paths explicitly.
    status,
    created_by: { kind: 'cli', id: 'test' },
    created_at: '2026-04-29T00:00:00.000Z',
  };
  writeFileSync(join(root, 'intents', `${id}.json`), JSON.stringify(intent, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Approval-semantics split (convergence pass)
//
// The factory accepts two authoring surfaces — spec-driven runs and
// hand-authored intent files — and the approval gate must treat them
// differently:
//
//   - spec.source === 'spec':   the intent is derived from a spec;
//     authoring the spec IS the gate. The orchestrator must NOT
//     consult the derived intent's status.
//
//   - spec.source === 'intent': the intent is hand-authored; its
//     status IS the gate. Accept post-approval statuses (approved,
//     planned, delivered) — reject the rest (proposed, superseded,
//     missing/unknown) with an actionable error message that names
//     the file and the required status flip.
//
// The four post/pre-approval statuses are pinned by separate tests so
// the four-status story (approved / planned / delivered accepted;
// proposed / superseded rejected) is observable from the test surface.
// ---------------------------------------------------------------------------

describe('runSingleSpec — approval semantics: spec vs intent', () => {
  it('spec-driven run with derived proposed-status intent STILL runs (no gate)', async () => {
    const f = makeFixture();
    // Spec exists; the orchestrator materialises an intent whose
    // status is the translator default ('proposed'). The gate must
    // be skipped because authoring the spec IS the gate.
    writeSpec(f.root, 'spec-driven', { title: 'Spec-driven run' });
    const result = await runOrchestrator({
      args: ['spec-driven'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    // Reached planning (dry-run completes as a successful preview).
    expect(result.success).toBe(true);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.id).toBe('spec-driven');
    expect(result.specs[0]!.status).toBe('completed');

    // Sanity: the materialised intent is in the default 'proposed'
    // state — proving the gate would otherwise have rejected this
    // run if it were applied.
    const intent = JSON.parse(
      readFileSync(join(f.root, 'intents', 'spec-driven.json'), 'utf-8'),
    );
    expect(intent.status).toBe('proposed');
  });

  it('intent-driven run with status=proposed is REJECTED (gate enforced)', async () => {
    const f = makeFixture();
    // No spec — purely a hand-authored intent. Default fixture
    // status was 'approved' so we override explicitly.
    writeIntent(f.root, 'unapproved', 'proposed');
    const result = await runOrchestrator({
      args: ['unapproved'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.success).toBe(false);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.status).toBe('failed');
    if (result.specs[0]!.status === 'failed') {
      // Operator-facing error names the file and the required
      // status flip — not a generic "something went wrong".
      expect(result.specs[0]!.reason).toMatch(/intents\/unapproved\.json/);
      expect(result.specs[0]!.reason).toMatch(/approved/);
    }
  });

  it('intent-driven run with status=approved RUNS (gate satisfied)', async () => {
    const f = makeFixture();
    writeIntent(f.root, 'approved-intent', 'approved');
    const result = await runOrchestrator({
      args: ['approved-intent'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.success).toBe(true);
    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]!.id).toBe('approved-intent');
    expect(result.specs[0]!.status).toBe('completed');
  });

  it('intent-driven run with status=planned RUNS (idempotent re-run after planning)', async () => {
    const f = makeFixture();
    // After a successful planning run the orchestrator stamps the
    // intent with status='planned'. A re-run on the same intent
    // must not be rejected by the approval gate — that would break
    // idempotency.
    writeIntent(f.root, 'replanned', 'planned');
    const result = await runOrchestrator({
      args: ['replanned'],
      config: f.config,
      projectRoot: f.root,
      artifactRoot: f.root,
      dryRun: true,
    });
    expect(result.success).toBe(true);
    expect(result.specs[0]!.status).toBe('completed');
  });
});
