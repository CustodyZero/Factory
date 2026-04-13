/**
 * Factory — Terminal Output
 *
 * Zero-dependency terminal formatting for all Factory tools.
 * Provides colored text, status symbols, and structural formatting.
 *
 * Colors are derived from the Factory brand guidelines:
 *   Brand accent: Industrial green #5A9A6E
 *   Dark foundation inherited from CustodyZero design system
 *
 * Environment conventions:
 *   NO_COLOR    — disables all ANSI codes (https://no-color.org)
 *   FORCE_COLOR — enables colors even when stdout is not a TTY
 *
 * Brand constraints applied:
 *   - No emoji characters (brand guideline: "No emojis in brand contexts")
 *   - No amber accent (amber belongs to CustodyZero house only)
 *   - No purple, no blue (#4FC3F7 belongs to Archon)
 *   - Utilitarian, restrained, unadorned
 */

// ---------------------------------------------------------------------------
// Color detection (lazy, resettable for testing)
// ---------------------------------------------------------------------------

let _enabled: boolean | null = null;

function isColorEnabled(): boolean {
  if (_enabled === null) {
    _enabled = !process.env['NO_COLOR'] &&
      (!!process.env['FORCE_COLOR'] || (process.stdout.isTTY ?? false));
  }
  return _enabled;
}

/** Reset cached color detection. Exported for testing only. */
export function _resetColorDetection(): void {
  _enabled = null;
}

function wrap(code: string, text: string): string {
  return isColorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

// ---------------------------------------------------------------------------
// Semantic color functions
// ---------------------------------------------------------------------------

/** Factory brand green (#5A9A6E) — headers, brand text, structural bars. */
export function brand(text: string): string { return wrap('38;2;90;154;110', text); }

/** Success — passed checks, completions, approvals. */
export function success(text: string): string { return wrap('32', text); }

/** Error — failures, blocked states, violations. */
export function error(text: string): string { return wrap('31', text); }

/** Warning — caution states, incomplete, awaiting action. */
export function warn(text: string): string { return wrap('33', text); }

/** Informational — arrows, commands, neutral metadata. */
export function info(text: string): string { return wrap('36', text); }

/** Muted — timestamps, secondary text, IDs. */
export function muted(text: string): string { return wrap('2', text); }

/** Bold — emphasis, labels, packet IDs. */
export function bold(text: string): string { return wrap('1', text); }

// ---------------------------------------------------------------------------
// Status symbols
//
// All symbols are Unicode text characters — no emoji.
// Brand guideline: "No emojis in brand contexts."
// ---------------------------------------------------------------------------

export const sym = {
  /** ✓ — success, passed, completed */
  get ok(): string { return wrap('32', '✓'); },
  /** ✗ — failure, failed check */
  get fail(): string { return wrap('31', '✗'); },
  /** ⚠ — warning, incomplete */
  get warn(): string { return wrap('33', '⚠'); },
  /** → — directional, next step, needs */
  get arrow(): string { return wrap('36', '→'); },
  /** • — list bullet */
  get bullet(): string { return '•'; },
  /** ⊘ — blocked, prohibited */
  get blocked(): string { return wrap('31', '⊘'); },
  /** ○ — pending, awaiting action */
  get pending(): string { return wrap('33', '○'); },
  /** ◆ — audit, review needed */
  get audit(): string { return wrap('1', '◆'); },
  /** ▹ — planning, intent */
  get plan(): string { return wrap('36', '▹'); },
};

// ---------------------------------------------------------------------------
// Structural formatting (standardized across all tools)
// ---------------------------------------------------------------------------

const BAR_WIDTH = 59;

/**
 * Major section header — green double-line bars with FACTORY prefix.
 *
 *   ═══════════════════════════════════════════════════════════
 *     FACTORY TITLE  detail
 *   ═══════════════════════════════════════════════════════════
 */
export function header(title: string, detail?: string): string {
  const bar = brand('═'.repeat(BAR_WIDTH));
  const detailPart = detail !== undefined ? ` ${muted(detail)}` : '';
  return `\n${bar}\n  ${brand('FACTORY')} ${bold(title)}${detailPart}\n${bar}`;
}

/** Thin divider — muted single horizontal line. */
export function divider(): string {
  return muted('─'.repeat(BAR_WIDTH));
}

// ---------------------------------------------------------------------------
// Progress logging (writes to stderr — safe alongside --json on stdout)
// ---------------------------------------------------------------------------

let _startTime: number | null = null;

/** Reset the progress timer. Call at the start of a timed operation. */
export function resetTimer(): void {
  _startTime = null;
}

function elapsed(): string {
  if (_startTime === null) {
    _startTime = Date.now();
  }
  const ms = Date.now() - _startTime;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(tenths)}`;
}

/**
 * Write a timestamped progress line to stderr.
 * Used by the orchestrator runLoop for real-time feedback.
 *
 *   [00:04.2] planning    Feature created: customer-dashboard
 */
export function log(phase: string, message: string): void {
  const ts = muted(`[${elapsed()}]`);
  const ph = info(phase.padEnd(12));
  process.stderr.write(`  ${ts} ${ph} ${message}\n`);
}
