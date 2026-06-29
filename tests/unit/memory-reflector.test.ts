import { describe, it, expect } from 'vitest';
import { formatEpisodesForSynthesis, parseInsights } from '@/lib/agents/memory-reflector';
import type { MemoryEntry } from '@/lib/agents/memory/agent-memory';

function entry(value: Record<string, unknown>, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'x', agent_id: 'evo', memory_type: 'intelligence', key: 'tg_group_intel_1',
    value, confidence: 0.85, source: 'telegram_group',
    expires_at: null, created_at: '2026-06-29T00:00:00Z', updated_at: '2026-06-29T00:00:00Z',
    ...over,
  };
}

describe('formatEpisodesForSynthesis', () => {
  it('serializes hot-signal episodes', () => {
    const out = formatEpisodesForSynthesis([
      entry({ group_title: 'Отельеры', signals: ['спрос на туры вырос', 'демпинг конкурента'], timestamp: '2026-06-28T10:00:00Z' }),
    ]);
    expect(out).toContain('Отельеры');
    expect(out).toContain('спрос на туры вырос');
    expect(out).toContain('2026-06-28');
  });

  it('serializes intel episodes flattening non-empty fields', () => {
    const out = formatEpisodesForSynthesis([
      entry({ group_title: 'Гиды', analyzed_at: '2026-06-27T09:00:00Z', intel: { trends: ['рост вертолётных'], empty: [], price: '15000' } }),
    ]);
    expect(out).toContain('Гиды');
    expect(out).toContain('trends: рост вертолётных');
    expect(out).toContain('price: 15000');
    expect(out).not.toContain('empty');
  });

  it('skips episodes with no usable content', () => {
    const out = formatEpisodesForSynthesis([entry({ group_title: 'Пусто', intel: { a: null, b: [] } })]);
    expect(out).toBe('');
  });
});

describe('parseInsights', () => {
  it('parses a valid JSON array of insights', () => {
    const raw = `тут [{"title":"Рост спроса","insight":"спрос на вертолётные туры растёт третью неделю","category":"demand","confidence":0.9}] конец`;
    const out = parseInsights(raw);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('demand');
    expect(out[0].confidence).toBe(0.9);
  });

  it('drops items failing schema (bad category / missing fields)', () => {
    const raw = `[{"title":"ok одобрено","insight":"достаточно длинный осмысленный текст","category":"demand","confidence":0.8},{"title":"x","insight":"y","category":"НЕВЕРНО","confidence":2}]`;
    const out = parseInsights(raw);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('ok одобрено');
  });

  it('returns [] on malformed / missing JSON', () => {
    expect(parseInsights('нет данных')).toEqual([]);
    expect(parseInsights('')).toEqual([]);
    expect(parseInsights('[not json')).toEqual([]);
  });
});
