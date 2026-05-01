/**
 * CLI smoke tests for tools/validate.ts.
 *
 * validate.ts walks the project root discovered at module load time, so
 * the cleanest way to drive it under fixtures is via spawnSync into a
 * tmpdir that contains its own factory.config.json. This is the same
 * pattern lifecycle_cli.test.ts already uses for the lifecycle scripts.
 *
 * Phase 4 of specs/single-entry-pipeline.md teaches validate.ts to walk
 * `specs/` and to report cycles in `depends_on`. These tests pin:
 *   - A valid spec passes validation
 *   - Malformed spec frontmatter is reported with the file path
 *   - Filename / id mismatch is reported
 *   - Cyclic spec dependencies (A -> B -> A) are reported
 *   - Intent depends_on validation: bad type is rejected
 *
 * Phase 4.6 of single-entry-pipeline added this file's compatibility
 * suite. These pin the exact accept/reject behavior of the hand-rolled
 * per-artifact validators and of the cross-cutting integrity layer
 * (now in tools/pipeline/integrity.ts) so that any future change
 * (including a possible re-attempt at moving these validators onto a
 * schema engine) cannot silently shift the contract.
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
    project_name: 'validate-test',
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
  };
}

let fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
  fixtures = [];
});

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'validate-test-'));
  writeFileSync(
    join(root, 'factory.config.json'),
    JSON.stringify(makeBaseConfig(), null, 2),
    'utf-8',
  );
  fixtures.push({ root });
  return { root };
}

function writeSpec(root: string, filename: string, body: string): void {
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, 'specs', filename), body, 'utf-8');
}

function writeIntent(root: string, intent: Record<string, unknown>): void {
  mkdirSync(join(root, 'intents'), { recursive: true });
  writeFileSync(
    join(root, 'intents', `${String(intent['id'])}.json`),
    JSON.stringify(intent, null, 2) + '\n',
    'utf-8',
  );
}

function writePacket(root: string, packet: Record<string, unknown>): void {
  mkdirSync(join(root, 'packets'), { recursive: true });
  writeFileSync(
    join(root, 'packets', `${String(packet['id'])}.json`),
    JSON.stringify(packet, null, 2) + '\n',
    'utf-8',
  );
}

function writeCompletion(
  root: string,
  packetId: string,
  completion: Record<string, unknown>,
): void {
  mkdirSync(join(root, 'completions'), { recursive: true });
  writeFileSync(
    join(root, 'completions', `${packetId}.json`),
    JSON.stringify(completion, null, 2) + '\n',
    'utf-8',
  );
}

function writeFeature(root: string, feature: Record<string, unknown>): void {
  mkdirSync(join(root, 'features'), { recursive: true });
  writeFileSync(
    join(root, 'features', `${String(feature['id'])}.json`),
    JSON.stringify(feature, null, 2) + '\n',
    'utf-8',
  );
}

/**
 * Build a minimum-valid dev packet with the supplied overrides spread on
 * top. Every field validate.ts requires is set so individual tests can
 * vary one axis at a time without re-stating the whole record.
 */
function devPacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dev-1',
    title: 'dev packet 1',
    intent: 'do a thing',
    kind: 'dev',
    scope: { packages: ['pkg'] },
    owner: 'team',
    created_at: '2026-04-29T00:00:00.000Z',
    acceptance_criteria: ['ac one'],
    ...overrides,
  };
}

function qaPacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'qa-1',
    title: 'qa packet 1',
    intent: 'verify the dev packet',
    kind: 'qa',
    verifies: 'dev-1',
    scope: { packages: ['pkg'] },
    owner: 'team',
    created_at: '2026-04-29T00:00:00.000Z',
    acceptance_criteria: ['ac one'],
    ...overrides,
  };
}

function devCompletion(packetId: string, identityId: string): Record<string, unknown> {
  return {
    packet_id: packetId,
    completed_at: '2026-04-29T01:00:00.000Z',
    completed_by: { kind: 'agent', id: identityId },
    summary: 'done',
    verification: {
      tests_pass: true,
      build_pass: true,
      lint_pass: true,
      ci_pass: true,
    },
  };
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runValidate(cwd: string): Run {
  const scriptPath = join(TOOLS_DIR, 'validate.ts');
  const result = spawnSync('npx', ['tsx', scriptPath], {
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

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

describe('validate.ts — spec frontmatter', () => {
  it('passes when a single valid spec is present and there are no other artifacts', () => {
    const f = makeFixture();
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: A title\n---\n\nbody\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
    expect(r.stdout).toContain('1 specs');
  });

  it('reports malformed frontmatter with the spec file path', () => {
    const f = makeFixture();
    writeSpec(f.root, 'broken.md', 'no frontmatter here\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL');
    expect(r.stdout).toContain('specs/broken.md');
    expect(r.stdout).toContain('missing frontmatter');
  });

  it('reports filename / id mismatch', () => {
    const f = makeFixture();
    // File is foo.md but declares id: bar
    writeSpec(f.root, 'foo.md', '---\nid: bar\ntitle: t\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('specs/foo.md');
    expect(r.stdout).toContain('filename must match id');
  });

  it('reports cyclic spec dependencies (A -> B -> A)', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a.md', '---\nid: a\ntitle: A\ndepends_on: [b]\n---\n');
    writeSpec(f.root, 'b.md', '---\nid: b\ntitle: B\ndepends_on: [a]\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Cyclic spec dependency');
    // Each member is reported once; both files mentioned.
    expect(r.stdout).toContain('specs/a.md');
    expect(r.stdout).toContain('specs/b.md');
  });

  it('reports a spec depending on a missing target', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a.md', '---\nid: a\ntitle: A\ndepends_on: [ghost]\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Spec 'a' depends_on 'ghost'");
  });

  it('passes a chain dependency (A -> B, no cycle)', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a.md', '---\nid: a\ntitle: A\ndepends_on: [b]\n---\n');
    writeSpec(f.root, 'b.md', '---\nid: b\ntitle: B\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });
});

// ---------------------------------------------------------------------------
// Intent depends_on additive field
// ---------------------------------------------------------------------------

describe('validate.ts — intent depends_on field', () => {
  it('accepts an intent with depends_on as an array of kebab-case ids', () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec_path: 'specs/foo.md',
      status: 'proposed',
      depends_on: ['bar', 'baz'],
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    // Spec file referenced by spec_path must exist or validate.ts errors.
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: foo\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('rejects an intent with depends_on that is not a string array', () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec_path: 'specs/foo.md',
      status: 'proposed',
      depends_on: 'bar',
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: foo\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("'depends_on' must be an array");
  });

  it('rejects an intent with depends_on entry that is not kebab-case', () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec_path: 'specs/foo.md',
      status: 'proposed',
      depends_on: ['Not_KebabCase'],
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: foo\n---\n');

    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Not_KebabCase');
  });
});

// ---------------------------------------------------------------------------
// Backward-compatibility — pre-Phase-4 layouts must keep validating
// ---------------------------------------------------------------------------
//
// These pin compatibility with two flavors of pre-spec layouts that the
// decision doc commits to keep working:
//
//   1. No specs/ directory at all (a brand-new project that has not yet
//      authored any specs).
//   2. A legacy intent that exists with no corresponding spec — running
//      `run.ts <intent-id>` was always allowed for spec-less intents
//      (docs/decisions/spec_artifact_model.md, "What this does NOT decide").
//
// Both must validate cleanly so that adding spec support never silently
// breaks an existing host project.

describe('validate.ts — legacy / spec-less compatibility', () => {
  it('passes when there is no specs/ directory at all', () => {
    const f = makeFixture();
    // No specs/, no intents/, no other artifacts. Just factory.config.json.
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('passes a legacy intent-only fixture (no specs/ directory)', () => {
    const f = makeFixture();
    // Legacy intent shape: inline `spec` field, no spec_path, no specs/ dir.
    // This is the pre-Phase-4 layout that must continue to work.
    writeIntent(f.root, {
      id: 'legacy-intent',
      title: 'A legacy intent',
      spec: 'inline body for the planner',
      status: 'proposed',
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });

    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });
});

// ---------------------------------------------------------------------------
// Phase 4.6 compatibility suite — packet validator
// ---------------------------------------------------------------------------
//
// These pin the *current* hand-rolled validator's accept/reject decisions
// so a future refactor cannot silently change them. They intentionally
// document looseness in the existing implementation (e.g. unknown fields
// accepted, missing optional fields accepted) — those are the contract
// today, regardless of whether they are ideal.

describe('validate.ts — packet validator (compatibility)', () => {
  it('accepts unknown extra fields on a packet', () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ extra_unknown_field: 42, another: 'x' }));
    const r = runValidate(f.root);
    // The packet has no QA counterpart and no feature; FI-8 only fires when
    // the packet is listed in a feature, so this passes cleanly.
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('accepts a packet with no started_at and no dependencies (optional fields)', () => {
    const f = makeFixture();
    // devPacket() omits started_at and dependencies; assert no schema error.
    writePacket(f.root, devPacket());
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
  });

  it('accepts a packet with no change_class (validator only enum-checks when present as a string)', () => {
    const f = makeFixture();
    const p = devPacket();
    // change_class is intentionally absent; the validator's guard is
    // `typeof data['change_class'] === 'string'` so missing is silently ok.
    writePacket(f.root, p);
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('change_class');
  });

  it("rejects a QA packet with no 'verifies' field", () => {
    const f = makeFixture();
    const q = qaPacket();
    delete q['verifies'];
    writePacket(f.root, q);
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("QA packet must have 'verifies'");
  });

  it("rejects a QA packet with non-string 'verifies'", () => {
    const f = makeFixture();
    writePacket(f.root, qaPacket({ verifies: 42 }));
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("QA packet must have 'verifies'");
  });

  it("rejects a QA packet with non-kebab-case 'verifies'", () => {
    const f = makeFixture();
    writePacket(f.root, qaPacket({ verifies: 'NotKebabCase' }));
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("QA packet must have 'verifies'");
  });

  it("rejects a dev packet with 'verifies' set", () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ verifies: 'something-else' }));
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Dev packet must not have 'verifies' set");
  });

  it("accepts a dev packet with 'verifies: null'", () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ verifies: null }));
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("Dev packet must not have 'verifies'");
  });

  it('rejects a review-state status on a QA packet (review states are dev-only)', () => {
    const f = makeFixture();
    writePacket(f.root, qaPacket({ status: 'review_requested' }));
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Review status 'review_requested' is only valid for dev packets");
  });
});

// ---------------------------------------------------------------------------
// Phase 4.6 compatibility suite — feature validator
// ---------------------------------------------------------------------------

describe('validate.ts — feature validator (compatibility)', () => {
  it('accepts acceptance_criteria of [42] (validator only checks array shape)', () => {
    const f = makeFixture();
    writeFeature(f.root, {
      id: 'feat-1',
      intent: 'an intent',
      acceptance_criteria: [42],
      status: 'planned',
      packets: [],
      created_by: { kind: 'human', id: 'me' },
    });
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('accepts acceptance_criteria of [""] (validator does not check element strings)', () => {
    const f = makeFixture();
    writeFeature(f.root, {
      id: 'feat-1',
      intent: 'an intent',
      acceptance_criteria: [''],
      status: 'planned',
      packets: [],
      created_by: { kind: 'human', id: 'me' },
    });
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
  });

  it('accepts planned_by: {} (validator does not enforce optional shape)', () => {
    const f = makeFixture();
    writeFeature(f.root, {
      id: 'feat-1',
      intent: 'an intent',
      acceptance_criteria: ['x'],
      status: 'planned',
      packets: [],
      created_by: { kind: 'human', id: 'me' },
      planned_by: {},
    });
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
  });

  it('accepts unknown extra fields on a feature', () => {
    const f = makeFixture();
    writeFeature(f.root, {
      id: 'feat-1',
      intent: 'an intent',
      acceptance_criteria: ['x'],
      status: 'planned',
      packets: [],
      created_by: { kind: 'human', id: 'me' },
      extra: 'unknown',
    });
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 4.6 compatibility suite — intent validator
// ---------------------------------------------------------------------------

describe('validate.ts — intent validator (compatibility)', () => {
  it('accepts constraints: [""] (validator only checks string-array shape, not non-empty strings)', () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec: 'inline body',
      status: 'proposed',
      constraints: [''],
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    const r = runValidate(f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it("rejects constraints that aren't a string array", () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec: 'inline body',
      status: 'proposed',
      constraints: [42],
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("'constraints' must be an array of strings");
  });

  it("treats empty 'spec' as absent (must require spec or spec_path)", () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec: '',
      status: 'proposed',
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("either 'spec' or 'spec_path' is required");
  });

  it("treats empty 'spec_path' as absent (must require spec or spec_path)", () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec_path: '',
      status: 'proposed',
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("either 'spec' or 'spec_path' is required");
  });

  it("rejects an intent with both non-empty 'spec' and 'spec_path' (mutex)", () => {
    const f = makeFixture();
    writeIntent(f.root, {
      id: 'foo',
      title: 'foo',
      spec: 'inline',
      spec_path: 'specs/foo.md',
      status: 'proposed',
      created_by: { kind: 'cli', id: 'factory-run' },
      created_at: '2026-04-29T00:00:00.000Z',
    });
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: foo\n---\n');
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("'spec' and 'spec_path' are mutually exclusive");
  });
});

// ---------------------------------------------------------------------------
// Phase 4.6 compatibility suite — spec parser end-to-end
// ---------------------------------------------------------------------------

describe('validate.ts — spec parser end-to-end (compatibility)', () => {
  it('rejects unknown frontmatter keys (parser is strict; validator surfaces parser error)', () => {
    const f = makeFixture();
    writeSpec(f.root, 'foo.md', '---\nid: foo\ntitle: foo\nbogus_key: value\n---\n');
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('specs/foo.md');
    expect(r.stdout).toContain("Unknown frontmatter key 'bogus_key'");
  });
});

// ---------------------------------------------------------------------------
// Phase 4.6 compatibility suite — cross-cutting integrity
// ---------------------------------------------------------------------------
//
// These exercise the relational layer now living in
// tools/pipeline/integrity.ts. Each invariant has a positive (passes)
// and a negative (fires) case. End-to-end via spawn so the CLI output
// path is also pinned.

describe('validate.ts — FI-1 unique completion per packet (compatibility)', () => {
  it('passes when each packet has at most one completion', () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ id: 'dev-1' }));
    writeCompletion(f.root, 'dev-1', devCompletion('dev-1', 'developer'));
    const r = runValidate(f.root);
    expect(r.stdout).not.toContain('FI-1 violation');
  });

  it('reports FI-1 when a single packet has two completion records on disk', () => {
    // Two completions for the same packet require two files. Use a sidecar
    // file naming so both records survive the directory read; the packet_id
    // inside both points at dev-1.
    const f = makeFixture();
    writePacket(f.root, devPacket({ id: 'dev-1' }));
    writeCompletion(f.root, 'dev-1', devCompletion('dev-1', 'developer'));
    // Second file: same packet_id inside; different filename so both load.
    writeCompletion(f.root, 'dev-1-dup', devCompletion('dev-1', 'developer'));
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FI-1 violation');
    expect(r.stdout).toContain("packet 'dev-1'");
  });
});

describe('validate.ts — FI-7 QA identity must differ from dev (compatibility)', () => {
  it('passes when QA completion identity differs from dev completion identity', () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ id: 'dev-1' }));
    writePacket(f.root, qaPacket({ id: 'qa-1', verifies: 'dev-1' }));
    writeCompletion(f.root, 'dev-1', devCompletion('dev-1', 'alice'));
    writeCompletion(f.root, 'qa-1', devCompletion('qa-1', 'bob'));
    const r = runValidate(f.root);
    expect(r.stdout).not.toContain('FI-7 violation');
  });

  it('reports FI-7 when a QA packet is completed by the same identity as its dev counterpart', () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ id: 'dev-1' }));
    writePacket(f.root, qaPacket({ id: 'qa-1', verifies: 'dev-1' }));
    writeCompletion(f.root, 'dev-1', devCompletion('dev-1', 'alice'));
    writeCompletion(f.root, 'qa-1', devCompletion('qa-1', 'alice'));
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FI-7 violation');
    expect(r.stdout).toContain("QA packet 'qa-1'");
  });
});

describe('validate.ts — FI-8 every dev packet has a QA counterpart (compatibility)', () => {
  it('passes when each non-abandoned dev packet in a feature has a paired QA packet', () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ id: 'dev-1' }));
    writePacket(f.root, qaPacket({ id: 'qa-1', verifies: 'dev-1' }));
    writeFeature(f.root, {
      id: 'feat-1',
      intent: 'i',
      acceptance_criteria: ['x'],
      status: 'planned',
      packets: ['dev-1', 'qa-1'],
      created_by: { kind: 'human', id: 'me' },
    });
    const r = runValidate(f.root);
    expect(r.stdout).not.toContain('FI-8 violation');
  });

  it('reports FI-8 when a feature lists a dev packet but no matching QA packet', () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ id: 'dev-1' }));
    writeFeature(f.root, {
      id: 'feat-1',
      intent: 'i',
      acceptance_criteria: ['x'],
      status: 'planned',
      packets: ['dev-1'],
      created_by: { kind: 'human', id: 'me' },
    });
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FI-8 violation');
    expect(r.stdout).toContain("dev packet 'dev-1' in feature 'feat-1'");
  });
});

describe('validate.ts — FI-9 no cyclic packet dependencies (compatibility)', () => {
  it('passes when the dependency graph is acyclic', () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ id: 'dev-1' }));
    writePacket(f.root, devPacket({ id: 'dev-2', dependencies: ['dev-1'] }));
    const r = runValidate(f.root);
    expect(r.stdout).not.toContain('FI-9 violation');
  });

  it('reports FI-9 when packets form a dependency cycle (A -> B -> A)', () => {
    const f = makeFixture();
    writePacket(f.root, devPacket({ id: 'dev-a', dependencies: ['dev-b'] }));
    writePacket(f.root, devPacket({ id: 'dev-b', dependencies: ['dev-a'] }));
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FI-9 violation');
  });
});

describe('validate.ts — orphan completion detection (compatibility)', () => {
  it('reports an orphan completion when a completion file references a packet that does not exist', () => {
    const f = makeFixture();
    // No packet file written; just a completion that names dev-1.
    writeCompletion(f.root, 'dev-1', devCompletion('dev-1', 'alice'));
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Orphaned completion');
    expect(r.stdout).toContain("packet 'dev-1' does not exist");
  });
});

describe('validate.ts — spec dependency cycle detection (compatibility)', () => {
  it('reports a 3-cycle (A -> B -> C -> A) with each member named once', () => {
    const f = makeFixture();
    writeSpec(f.root, 'a.md', '---\nid: a\ntitle: A\ndepends_on: [b]\n---\n');
    writeSpec(f.root, 'b.md', '---\nid: b\ntitle: B\ndepends_on: [c]\n---\n');
    writeSpec(f.root, 'c.md', '---\nid: c\ntitle: C\ndepends_on: [a]\n---\n');
    const r = runValidate(f.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Cyclic spec dependency');
    expect(r.stdout).toContain('specs/a.md');
    expect(r.stdout).toContain('specs/b.md');
    expect(r.stdout).toContain('specs/c.md');
  });
});
