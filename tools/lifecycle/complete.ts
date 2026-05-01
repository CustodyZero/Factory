/**
 * Factory — Lifecycle / Complete
 *
 * Library function for finalizing a packet: runs build/lint/test, collects
 * changed files from git, and writes the completion record. The CLI wrapper
 * at tools/complete.ts re-exports from here.
 *
 * SCOPE FOR PHASE 3
 *
 * Phase 1 already extracted completePacket() as an export of
 * tools/complete.ts. Phase 3 moves it into this dedicated module so
 * run.ts can import it by responsibility (lifecycle) rather than by
 * historical filename. The CLI wrapper continues to re-export for
 * backward compatibility.
 *
 * I/O: this file runs the project's verification commands (build / lint /
 * test) via execSync, reads/writes packet JSON, and writes the completion
 * record. It does NOT shell out to other lifecycle scripts.
 *
 * Idempotency contract:
 *   If a completion record already exists, the function returns the
 *   existing values WITHOUT re-running verification. The FI-1 invariant
 *   (one completion per packet) is preserved by refusing to overwrite,
 *   not by erroring on re-invocation.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig, findProjectRoot, resolveArtifactRoot } from '../config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompleteOptions {
  readonly packetId: string;
  readonly summary?: string;
  readonly identity?: string;
  readonly projectRoot?: string;
}

export interface CompleteResult {
  readonly packet_id: string;
  readonly build_pass: boolean;
  readonly lint_pass: boolean;
  readonly tests_pass: boolean;
  readonly ci_pass: boolean;
  readonly files_changed: string[];
  readonly already_complete: boolean;
}

interface RawCompletion {
  readonly packet_id: string;
  readonly files_changed?: ReadonlyArray<string>;
  readonly verification?: {
    readonly tests_pass?: boolean;
    readonly build_pass?: boolean;
    readonly lint_pass?: boolean;
    readonly ci_pass?: boolean;
  };
}

export function completePacket(options: CompleteOptions): CompleteResult {
  const config = loadConfig(options.projectRoot);
  const projectRoot = options.projectRoot ?? findProjectRoot();
  const artifactRoot = resolveArtifactRoot(projectRoot, config);
  const { packetId } = options;

  const packetPath = join(artifactRoot, 'packets', `${packetId}.json`);
  if (!existsSync(packetPath)) {
    throw new Error(`Packet not found: packets/${packetId}.json`);
  }

  const completionPath = join(artifactRoot, 'completions', `${packetId}.json`);

  // Idempotency: if a completion record already exists, return its values
  // WITHOUT re-running verification. This must happen before any work to
  // avoid the cost (and potential nondeterminism) of re-running build/lint/
  // test on already-complete work. The FI-1 invariant is preserved: we do
  // NOT overwrite the existing file. The downstream writeFileSync below is
  // unreachable on the already-complete path; if execution somehow reaches
  // that point with the file still present, it would still refuse — but
  // the early return is the documented contract.
  if (existsSync(completionPath)) {
    const existing = JSON.parse(readFileSync(completionPath, 'utf-8')) as RawCompletion;
    // FI-1 reinforcement: a completion file at completions/<packetId>.json
    // must actually be the completion record for that packet. A mismatched
    // packet_id means the file is corrupt or misnamed; refusing to short-
    // circuit forces the operator to fix it rather than silently treating
    // a foreign record as success for this packet.
    if (existing.packet_id !== packetId) {
      throw new Error(
        `Completion record at completions/${packetId}.json has packet_id '${String(existing.packet_id)}', ` +
          `expected '${packetId}'. The completion file may be corrupt or misnamed.`,
      );
    }
    const verification = existing.verification ?? {};
    return {
      packet_id: existing.packet_id,
      build_pass: verification.build_pass ?? false,
      lint_pass: verification.lint_pass ?? false,
      tests_pass: verification.tests_pass ?? false,
      ci_pass: verification.ci_pass ?? false,
      files_changed: [...(existing.files_changed ?? [])],
      already_complete: true,
    };
  }

  const packet = JSON.parse(readFileSync(packetPath, 'utf-8')) as Record<string, unknown>;
  const startedAt = typeof packet['started_at'] === 'string' ? packet['started_at'] : null;
  if (startedAt === null) {
    throw new Error(`Packet '${packetId}' has not been started.`);
  }

  // Run verification
  const buildPass = runVerification('build', config.verification.build, projectRoot);
  const lintPass = runVerification('lint', config.verification.lint, projectRoot);
  const testsPass = runVerification('tests', config.verification.test, projectRoot);
  const ciPass = buildPass && lintPass && testsPass;

  // Collect changed files. Best-effort: when the project root is not a git
  // repo (e.g. test fixtures) git emits a usage banner on stderr; we silence
  // it by piping stderr to a buffer we then discard. The catch swallows the
  // non-zero exit so the absence of git history never blocks completion.
  let filesChanged: string[] = [];
  try {
    const diffOutput = execSync('git diff --name-only HEAD~1', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (diffOutput.length > 0) {
      filesChanged = diffOutput.split('\n');
    }
  } catch { /* best-effort */ }

  const summary = options.summary ?? `Completed implementation for packet ${packetId}.`;
  const failedSteps = [
    ...(buildPass ? [] : ['build']),
    ...(lintPass ? [] : ['lint']),
    ...(testsPass ? [] : ['tests']),
  ];
  const verificationNotes = failedSteps.length > 0
    ? `Verification failed for: ${failedSteps.join(', ')}`
    : 'All verification passed.';

  const completion = {
    packet_id: packetId,
    completed_at: new Date().toISOString(),
    completed_by: options.identity !== undefined
      ? { ...config.completed_by_default, id: options.identity }
      : config.completed_by_default,
    summary,
    files_changed: filesChanged,
    verification: {
      tests_pass: testsPass,
      build_pass: buildPass,
      lint_pass: lintPass,
      ci_pass: ciPass,
      notes: verificationNotes,
    },
  };

  // FI-1 last-line defense: refuse to overwrite an existing completion file.
  // This branch is unreachable in normal flow because of the early return at
  // the top of this function, but the check is preserved as a structural
  // safety net against any future refactor that changes the early return.
  if (existsSync(completionPath)) {
    throw new Error(`Completion already exists: completions/${packetId}.json (FI-1)`);
  }

  writeFileSync(completionPath, JSON.stringify(completion, null, 2) + '\n', 'utf-8');

  // Update packet status
  packet['status'] = 'completed';
  writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf-8');

  return {
    packet_id: packetId,
    build_pass: buildPass,
    lint_pass: lintPass,
    tests_pass: testsPass,
    ci_pass: ciPass,
    files_changed: filesChanged,
    already_complete: false,
  };
}

function runVerification(_name: string, command: string, cwd: string): boolean {
  try {
    execSync(command, { cwd, encoding: 'utf-8', timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}
