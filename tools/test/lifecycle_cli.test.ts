/**
 * CLI smoke tests for the Phase 2 idempotent lifecycle scripts.
 *
 * These tests spawn the actual CLI entry points in a child process and assert
 * on stdout/stderr/exit-code. They exist to catch *output drift* — the kind of
 * regression that library-level tests cannot see, because the library throws
 * Error objects whereas the CLI renders multi-line operator output.
 *
 * Coverage per script (one happy idempotent path + one legacy multi-line
 * error path):
 *   - request-review.ts:
 *       1. already-review_requested → no-op success message on stdout, exit 0.
 *       2. wrong-kind (qa packet) → 3-line ERROR block on stderr, exit 1.
 *   - review.ts:
 *       1. already-approved + --approve → no-op success message, exit 0.
 *       2. wrong-status ('implementing') → 3-line ERROR block on stderr, exit 1.
 *   - complete.ts:
 *       1. already-complete → no-op success message, exit 0.
 *       2. mismatched packet_id in completion file → ERROR on stderr, exit 1.
 *
 * The fixture writes its own factory.config.json so the spawned scripts'
 * findProjectRoot() resolves to the temp dir, isolating the test from the
 * surrounding repo.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');

interface Fixture {
  readonly root: string;
}

function makeBaseConfig(): Record<string, unknown> {
  return {
    project_name: 'cli-smoke',
    factory_dir: '.',
    artifact_dir: '.',
    // 'true' commands so that if complete.ts ever DID run verification, it
    // would still pass; that means an early-return idempotent path is the
    // only thing that produces an "already complete" message — but other
    // CLI tests don't depend on this.
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
  };
}

function makeFixture(opts: {
  packets?: ReadonlyArray<Record<string, unknown>>;
  completions?: ReadonlyArray<Record<string, unknown>>;
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-cli-'));
  mkdirSync(join(root, 'packets'), { recursive: true });
  mkdirSync(join(root, 'completions'), { recursive: true });
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(makeBaseConfig(), null, 2),
    'utf-8',
  );
  for (const p of opts.packets ?? []) {
    writeFileSync(
      join(root, 'packets', `${String(p['id'])}.json`),
      JSON.stringify(p, null, 2) + '\n',
      'utf-8',
    );
  }
  for (const c of opts.completions ?? []) {
    writeFileSync(
      join(root, 'completions', `${String(c['packet_id'])}.json`),
      JSON.stringify(c, null, 2) + '\n',
      'utf-8',
    );
  }
  return { root };
}

let fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
  fixtures = [];
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn `npx tsx <script>` with the given args and cwd. We use `npx tsx`
 * rather than a direct binary to avoid coupling tests to a specific
 * install layout.
 */
function runCli(script: string, args: ReadonlyArray<string>, cwd: string): Run {
  const scriptPath = join(TOOLS_DIR, script);
  const result = spawnSync('npx', ['tsx', scriptPath, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('request-review.ts CLI', () => {
  it('idempotent rerun: prints already-requested message, exit 0', () => {
    const f = makeFixture({
      packets: [
        {
          id: 'pkt-cli-rr',
          kind: 'dev',
          title: 'already requested',
          status: 'review_requested',
          branch: 'feature/cli',
          review_iteration: 1,
          started_at: '2024-01-01T00:00:00Z',
        },
      ],
    });
    fixtures.push(f);

    const r = runCli('request-review.ts', ['pkt-cli-rr'], f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Review already requested for packet 'pkt-cli-rr'");
    expect(r.stdout).toContain("on branch 'feature/cli'");
    expect(r.stdout).toContain('iteration 1');
    expect(r.stdout).toContain('No action taken.');
  });

  it('wrong-kind: prints 3-line ERROR block on stderr, exit 1', () => {
    const f = makeFixture({
      packets: [
        {
          id: 'pkt-cli-qa',
          kind: 'qa',
          title: 'qa packet',
          status: 'implementing',
          started_at: '2024-01-01T00:00:00Z',
        },
      ],
    });
    fixtures.push(f);

    const r = runCli('request-review.ts', ['pkt-cli-qa'], f.root);
    expect(r.status).toBe(1);
    // First line: ERROR: <summary>
    expect(r.stderr).toContain('ERROR: Only dev packets can request code review.');
    // Indented detail lines (two-space indent) — both must be present.
    expect(r.stderr).toContain("  Packet 'pkt-cli-qa' has kind 'qa'.");
    expect(r.stderr).toContain('  QA packets do not go through code review.');
  });
});

describe('review.ts CLI', () => {
  it('idempotent --approve on already-approved: prints no-op message, exit 0', () => {
    const f = makeFixture({
      packets: [
        {
          id: 'pkt-cli-approved',
          kind: 'dev',
          title: 'already approved',
          status: 'review_approved',
          review_iteration: 1,
          started_at: '2024-01-01T00:00:00Z',
        },
      ],
    });
    fixtures.push(f);

    const r = runCli('review.ts', ['pkt-cli-approved', '--approve'], f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Packet 'pkt-cli-approved' is already approved. No action taken.");
  });

  it('wrong-status (implementing): prints multi-line ERROR with hint, exit 1', () => {
    const f = makeFixture({
      packets: [
        {
          id: 'pkt-cli-impl',
          kind: 'dev',
          title: 'implementing',
          status: 'implementing',
          started_at: '2024-01-01T00:00:00Z',
        },
      ],
    });
    fixtures.push(f);

    const r = runCli('review.ts', ['pkt-cli-impl', '--approve'], f.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ERROR: Packet 'pkt-cli-impl' has status 'implementing'.");
    expect(r.stderr).toContain("  Only packets in 'review_requested' status can be reviewed.");
    expect(r.stderr).toContain('  The developer must call request-review.ts first.');
  });
});

describe('complete.ts CLI', () => {
  it('idempotent rerun: prints already-complete message, exit 0', () => {
    const f = makeFixture({
      packets: [
        {
          id: 'pkt-cli-done',
          kind: 'dev',
          title: 'already complete',
          status: 'completed',
          started_at: '2024-01-01T00:00:00Z',
        },
      ],
      completions: [
        {
          packet_id: 'pkt-cli-done',
          completed_at: '2024-01-02T00:00:00Z',
          completed_by: { kind: 'agent', id: 'old' },
          summary: 'done',
          files_changed: [],
          verification: {
            tests_pass: true,
            build_pass: true,
            lint_pass: true,
            ci_pass: true,
            notes: 'All verification passed.',
          },
        },
      ],
    });
    fixtures.push(f);

    const r = runCli('complete.ts', ['pkt-cli-done'], f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Packet 'pkt-cli-done' is already complete. No action taken.");
  });

  it('mismatched packet_id in completion file: prints ERROR on stderr, exit 1', () => {
    const f = makeFixture({
      packets: [
        {
          id: 'pkt-cli-asking',
          kind: 'dev',
          title: 'asks for completion',
          status: 'review_approved',
          started_at: '2024-01-01T00:00:00Z',
        },
      ],
      completions: [
        // The file is named pkt-cli-asking.json (because the helper uses
        // packet_id as the filename), but its internal packet_id disagrees.
        // We rewrite the file below with a different packet_id payload.
      ],
    });
    fixtures.push(f);

    // Manually write a foreign-payload completion at the asking packet's path.
    writeFileSync(
      join(f.root, 'completions', 'pkt-cli-asking.json'),
      JSON.stringify(
        {
          packet_id: 'pkt-cli-OTHER',
          completed_at: '2024-01-02T00:00:00Z',
          completed_by: { kind: 'agent', id: 'old' },
          summary: 'foreign',
          files_changed: [],
          verification: {
            tests_pass: true,
            build_pass: true,
            lint_pass: true,
            ci_pass: true,
            notes: 'All verification passed.',
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const r = runCli('complete.ts', ['pkt-cli-asking'], f.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "has packet_id 'pkt-cli-OTHER', expected 'pkt-cli-asking'",
    );
  });
});
