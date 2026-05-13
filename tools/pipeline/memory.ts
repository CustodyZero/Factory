import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defaultMemoryConfig } from '../config.js';
import type { FactoryConfig, PipelinePersona } from '../config.js';
import { resolveCacheRoot, resolveMemoryRoot } from '../config.js';

const CATEGORY_DIRS = [
  'architectural-facts',
  'recurring-failures',
  'project-conventions',
  'code-patterns',
] as const;

const CACHE_FILENAME = 'memory-context-cache.json';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CacheEntryFile {
  readonly path: string;
  readonly mtime_ms: number;
}

interface CacheEntry {
  readonly key: string;
  readonly generated_at: string;
  readonly files: ReadonlyArray<CacheEntryFile>;
  readonly block: string;
}

interface CacheStore {
  readonly entries: ReadonlyArray<CacheEntry>;
}

export interface MemoryQuery {
  readonly persona: PipelinePersona;
  readonly projectRoot: string;
  readonly config: FactoryConfig;
  readonly title?: string | null;
  readonly intent?: string | null;
  readonly acceptanceCriteria?: ReadonlyArray<string>;
  readonly spec?: string | null;
  readonly changeClass?: string | null;
}

export interface MemoryContext {
  readonly block: string;
  readonly files: ReadonlyArray<string>;
  readonly cache_hit: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toTerms(parts: ReadonlyArray<string | null | undefined>): string[] {
  const tokens = parts
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .flatMap((v) => normalizeWhitespace(v).toLowerCase().split(/[^a-z0-9]+/g))
    .filter((v) => v.length >= 4);
  return [...new Set(tokens)].slice(0, 16);
}

function categoriesForQuery(persona: PipelinePersona, changeClass: string | null | undefined): string[] {
  const categories = new Set<string>();
  const klass = changeClass ?? null;

  switch (persona) {
    case 'planner':
      categories.add('architectural-facts');
      categories.add('project-conventions');
      categories.add('code-patterns');
      break;
    case 'developer':
    case 'code_reviewer':
      categories.add('project-conventions');
      categories.add('code-patterns');
      if (klass === 'architectural' || klass === 'cross_cutting') categories.add('architectural-facts');
      if (klass !== 'trivial') categories.add('recurring-failures');
      break;
    case 'qa':
      categories.add('project-conventions');
      categories.add('recurring-failures');
      if (klass === 'architectural' || klass === 'cross_cutting') categories.add('architectural-facts');
      break;
  }

  return [...categories];
}

function cachePath(projectRoot: string, config: FactoryConfig): string {
  return join(resolveCacheRoot(projectRoot, config), CACHE_FILENAME);
}

function readCache(projectRoot: string, config: FactoryConfig): CacheStore {
  const path = cachePath(projectRoot, config);
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CacheStore;
    if (!Array.isArray(parsed.entries)) return { entries: [] };
    return parsed;
  } catch {
    return { entries: [] };
  }
}

function isCacheEntryFresh(entry: CacheEntry): boolean {
  const generatedAt = new Date(entry.generated_at).getTime();
  if (Number.isNaN(generatedAt)) return false;
  return Date.now() - generatedAt <= CACHE_MAX_AGE_MS;
}

function entryStillValid(entry: CacheEntry, memoryRoot: string): boolean {
  if (!isCacheEntryFresh(entry)) return false;
  for (const file of entry.files) {
    const absolute = join(memoryRoot, file.path);
    if (!existsSync(absolute)) return false;
    try {
      const stat = statSync(absolute);
      if (stat.mtimeMs !== file.mtime_ms) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function writeCache(projectRoot: string, config: FactoryConfig, entry: CacheEntry): void {
  try {
    const memory = config.memory ?? defaultMemoryConfig();
    const root = resolveCacheRoot(projectRoot, config);
    mkdirSync(root, { recursive: true });
    const current = readCache(projectRoot, config).entries.filter((item) => item.key !== entry.key);
    const entries = [entry, ...current].slice(0, memory.max_cache_entries);
    writeFileSync(cachePath(projectRoot, config), JSON.stringify({ entries }, null, 2) + '\n', 'utf-8');
  } catch {
    // best-effort only
  }
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => join(dir, name));
}

function scoreCandidate(path: string, content: string, terms: ReadonlyArray<string>): number {
  if (terms.length === 0) return 0;
  const haystack = `${path}\n${content}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (path.toLowerCase().includes(term)) score += 5;
    const matches = haystack.split(term).length - 1;
    score += matches;
  }
  return score;
}

function truncateContent(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf-8');
  if (buf.length <= maxBytes) return content.trim();
  return buf.subarray(0, maxBytes).toString('utf-8').trimEnd() + '\n...[truncated]';
}

function selectFiles(
  memoryRoot: string,
  config: FactoryConfig,
  categories: ReadonlyArray<string>,
  terms: ReadonlyArray<string>,
): Array<{ readonly path: string; readonly content: string }> {
  const memory = config.memory ?? defaultMemoryConfig();
  const selected: Array<{ path: string; content: string }> = [];
  const categoryCandidates: Array<{ path: string; content: string; score: number; category: string }> = [];

  for (const category of categories) {
    const dir = join(memoryRoot, category);
    for (const file of listMarkdownFiles(dir)) {
      if (relative(memoryRoot, file).startsWith(memory.suggestion_dir + '/')) continue;
      const raw = readFileSync(file, 'utf-8');
      const content = truncateContent(raw, memory.max_file_bytes);
      categoryCandidates.push({
        path: file,
        content,
        score: scoreCandidate(file, content, terms),
        category,
      });
    }
  }

  categoryCandidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const chosen = new Set<string>();
  for (const candidate of categoryCandidates) {
    if (selected.length >= memory.max_additional_files) break;
    if (candidate.score <= 0) continue;
    if (chosen.has(candidate.path)) continue;
    chosen.add(candidate.path);
    selected.push({ path: candidate.path, content: candidate.content });
  }

  if (selected.length < memory.max_additional_files) {
    for (const category of categories) {
      const fallback = categoryCandidates.find((candidate) => candidate.category === category && !chosen.has(candidate.path));
      if (fallback === undefined) continue;
      chosen.add(fallback.path);
      selected.push({ path: fallback.path, content: fallback.content });
      if (selected.length >= memory.max_additional_files) break;
    }
  }

  return selected;
}

function buildBlock(memoryRoot: string, files: ReadonlyArray<{ readonly path: string; readonly content: string }>): string {
  if (files.length === 0) return '';
  const lines = ['## Project Memory', 'Load this memory as advisory project context. Prefer the artifact graph and current code when they conflict.', ''];
  for (const file of files) {
    lines.push(`### ${relative(memoryRoot, file.path)}`);
    lines.push(file.content);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function loadMemoryContext(query: MemoryQuery): MemoryContext {
  const { projectRoot, config, persona } = query;
  const memoryRoot = resolveMemoryRoot(projectRoot, config);
  if (!existsSync(memoryRoot)) {
    return { block: '', files: [], cache_hit: false };
  }

  const key = [
    persona,
    query.changeClass ?? '',
    normalizeWhitespace(query.title ?? ''),
    normalizeWhitespace(query.intent ?? ''),
    normalizeWhitespace((query.acceptanceCriteria ?? []).join(' ')),
    normalizeWhitespace(query.spec ?? ''),
  ].join('|');

  const cached = readCache(projectRoot, config).entries.find((entry) => entry.key === key);
  if (cached !== undefined && entryStillValid(cached, memoryRoot)) {
    return {
      block: cached.block,
      files: cached.files.map((file) => file.path),
      cache_hit: true,
    };
  }

  const selected: Array<{ path: string; content: string }> = [];
  const memory = config.memory ?? defaultMemoryConfig();
  const indexPath = join(memoryRoot, 'MEMORY.md');
  if (existsSync(indexPath)) {
    selected.push({
      path: indexPath,
      content: truncateContent(readFileSync(indexPath, 'utf-8'), memory.max_file_bytes),
    });
  }

  const terms = toTerms([
    query.title,
    query.intent,
    ...(query.acceptanceCriteria ?? []),
    query.spec,
  ]);
  const categories = categoriesForQuery(persona, query.changeClass);
  selected.push(...selectFiles(memoryRoot, config, categories, terms));

  const block = buildBlock(memoryRoot, selected);
  const cacheEntry: CacheEntry = {
    key,
    generated_at: new Date().toISOString(),
    files: selected.map((file) => ({
      path: relative(memoryRoot, file.path),
      mtime_ms: statSync(file.path).mtimeMs,
    })),
    block,
  };
  writeCache(projectRoot, config, cacheEntry);

  return {
    block,
    files: cacheEntry.files.map((file) => file.path),
    cache_hit: false,
  };
}

interface SuggestionPacketLike {
  readonly id: string;
  readonly title?: string;
  readonly change_class?: string;
  readonly instructions?: ReadonlyArray<string>;
  readonly failure?: {
    readonly scenario?: string;
    readonly reason?: string;
  } | null;
}

export interface WriteSuggestionReportOptions {
  readonly projectRoot: string;
  readonly config: FactoryConfig;
  readonly specId: string;
  readonly featureId: string | null;
  readonly status: 'completed' | 'failed';
  readonly packets: ReadonlyArray<SuggestionPacketLike>;
}

export function writeMemorySuggestionReport(opts: WriteSuggestionReportOptions): string | null {
  const memoryRoot = resolveMemoryRoot(opts.projectRoot, opts.config);
  const memory = opts.config.memory ?? defaultMemoryConfig();
  const suggestionRoot = join(memoryRoot, memory.suggestion_dir);
  try {
    mkdirSync(suggestionRoot, { recursive: true });
    const path = join(suggestionRoot, `${opts.specId}.md`);
    const recurringFailures = opts.packets
      .filter((packet) => packet.failure != null)
      .map((packet) => `- ${packet.id}: ${packet.failure?.scenario ?? 'unknown'} — ${packet.failure?.reason ?? 'no reason recorded'}`);
    const conventionCandidates = [...new Set(
      opts.packets.flatMap((packet) => packet.instructions ?? []).map((value) => value.trim()).filter((value) => value.length > 0),
    )].map((value) => `- ${value}`);
    const architectureCandidates = opts.packets
      .filter((packet) => packet.change_class === 'architectural' || packet.change_class === 'cross_cutting')
      .map((packet) => `- ${packet.id}: ${packet.title ?? packet.id}`);

    const lines = [
      '---',
      `name: Memory suggestions for ${opts.specId}`,
      `generated_at: ${new Date().toISOString()}`,
      `feature_id: ${opts.featureId ?? 'null'}`,
      `status: ${opts.status}`,
      'type: suggestion',
      '---',
      '',
      '# Summary',
      '',
      `- Spec: ${opts.specId}`,
      `- Feature: ${opts.featureId ?? 'none'}`,
      `- Outcome: ${opts.status}`,
      '',
      '# Suggested architectural facts to review',
      '',
      ...(architectureCandidates.length > 0 ? architectureCandidates : ['- None surfaced from packet change classes in this run.']),
      '',
      '# Suggested recurring failures to review',
      '',
      ...(recurringFailures.length > 0 ? recurringFailures : ['- None surfaced in this run.']),
      '',
      '# Suggested project conventions to review',
      '',
      ...(conventionCandidates.length > 0 ? conventionCandidates : ['- No packet-level instructions surfaced candidate conventions.']),
      '',
      'Human review required before promoting any suggestion into durable project memory.',
      '',
    ];

    writeFileSync(path, lines.join('\n'), 'utf-8');
    return path;
  } catch {
    return null;
  }
}
