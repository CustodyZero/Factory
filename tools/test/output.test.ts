/**
 * Tests for the Factory terminal output module.
 *
 * Tests color detection, ANSI wrapping, symbol characters,
 * and structural formatting helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  brand,
  success,
  error,
  warn,
  info,
  muted,
  bold,
  sym,
  header,
  divider,
  log,
  resetTimer,
  _resetColorDetection,
} from '../output.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore process.env around each test. */
const savedEnv: Record<string, string | undefined> = {};

function stubEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear saved state
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('output', () => {
  afterEach(() => {
    restoreEnv();
    _resetColorDetection();
  });

  // -------------------------------------------------------------------------
  // NO_COLOR mode — all formatting stripped
  // -------------------------------------------------------------------------

  describe('with NO_COLOR', () => {
    beforeEach(() => {
      stubEnv('NO_COLOR', '1');
      stubEnv('FORCE_COLOR', undefined);
      _resetColorDetection();
    });

    it('OUT-U1: color functions return plain text', () => {
      expect(brand('test')).toBe('test');
      expect(success('ok')).toBe('ok');
      expect(error('fail')).toBe('fail');
      expect(warn('caution')).toBe('caution');
      expect(info('note')).toBe('note');
      expect(muted('dim')).toBe('dim');
      expect(bold('strong')).toBe('strong');
    });

    it('OUT-U2: symbols are plain Unicode characters', () => {
      expect(sym.ok).toBe('✓');
      expect(sym.fail).toBe('✗');
      expect(sym.warn).toBe('⚠');
      expect(sym.arrow).toBe('→');
      expect(sym.bullet).toBe('•');
      expect(sym.blocked).toBe('⊘');
      expect(sym.pending).toBe('○');
      expect(sym.audit).toBe('◆');
      expect(sym.plan).toBe('▹');
    });

    it('OUT-U3: header contains FACTORY and title without ANSI', () => {
      const h = header('STATUS');
      expect(h).toContain('═');
      expect(h).toContain('FACTORY');
      expect(h).toContain('STATUS');
      expect(h).not.toContain('\x1b');
    });

    it('OUT-U4: header with detail includes both parts', () => {
      const h = header('STATUS', '[my-project]');
      expect(h).toContain('FACTORY');
      expect(h).toContain('STATUS');
      expect(h).toContain('[my-project]');
    });

    it('OUT-U5: divider is 59 plain dash characters', () => {
      const d = divider();
      expect(d).toBe('─'.repeat(59));
    });
  });

  // -------------------------------------------------------------------------
  // FORCE_COLOR mode — ANSI codes applied
  // -------------------------------------------------------------------------

  describe('with FORCE_COLOR', () => {
    beforeEach(() => {
      stubEnv('NO_COLOR', undefined);
      stubEnv('FORCE_COLOR', '1');
      _resetColorDetection();
    });

    it('OUT-U6: brand wraps in Factory green truecolor', () => {
      expect(brand('test')).toBe('\x1b[38;2;90;154;110mtest\x1b[0m');
    });

    it('OUT-U7: semantic colors use correct ANSI codes', () => {
      expect(success('ok')).toBe('\x1b[32mok\x1b[0m');
      expect(error('fail')).toBe('\x1b[31mfail\x1b[0m');
      expect(warn('w')).toBe('\x1b[33mw\x1b[0m');
      expect(info('i')).toBe('\x1b[36mi\x1b[0m');
      expect(muted('m')).toBe('\x1b[2mm\x1b[0m');
      expect(bold('b')).toBe('\x1b[1mb\x1b[0m');
    });

    it('OUT-U8: symbols contain ANSI-wrapped characters', () => {
      expect(sym.ok).toBe('\x1b[32m✓\x1b[0m');
      expect(sym.fail).toBe('\x1b[31m✗\x1b[0m');
      expect(sym.blocked).toBe('\x1b[31m⊘\x1b[0m');
      expect(sym.pending).toBe('\x1b[33m○\x1b[0m');
    });

    it('OUT-U9: header bars use brand color', () => {
      const h = header('TEST');
      expect(h).toContain('\x1b[38;2;90;154;110m');
      expect(h).toContain('═');
    });
  });

  // -------------------------------------------------------------------------
  // NO_COLOR takes precedence over FORCE_COLOR
  // -------------------------------------------------------------------------

  it('OUT-U10: NO_COLOR overrides FORCE_COLOR', () => {
    stubEnv('NO_COLOR', '1');
    stubEnv('FORCE_COLOR', '1');
    _resetColorDetection();
    expect(brand('test')).toBe('test');
    expect(sym.ok).toBe('✓');
  });

  // -------------------------------------------------------------------------
  // Symbol character correctness (no emoji)
  // -------------------------------------------------------------------------

  it('OUT-U11: no symbol uses emoji codepoints (U+1F000+)', () => {
    stubEnv('NO_COLOR', '1');
    _resetColorDetection();
    const symbols = [sym.ok, sym.fail, sym.warn, sym.arrow, sym.bullet, sym.blocked, sym.pending, sym.audit, sym.plan];
    for (const s of symbols) {
      for (const char of s) {
        const code = char.codePointAt(0)!;
        expect(code).toBeLessThan(0x1F000);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Progress timer
  // -------------------------------------------------------------------------

  it('OUT-U12: log writes timestamped line to stderr', () => {
    stubEnv('NO_COLOR', '1');
    _resetColorDetection();

    const chunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      resetTimer();
      log('planning', 'Starting planner');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('planning');
      expect(chunks[0]).toContain('Starting planner');
      expect(chunks[0]).toMatch(/\[\d{2}:\d{2}\.\d]/);
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
