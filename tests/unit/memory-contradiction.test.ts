import { describe, it, expect } from 'vitest';
import { parseContradictions } from '@/lib/agents/memory-contradiction';

describe('parseContradictions', () => {
  it('parses a valid JSON array', () => {
    const raw = `вот результат [{"subject":"тропа на Авачу","statement_a":"открыта","statement_b":"закрыта из-за схода лавины","severity":"high","why":"не могут быть истинны одновременно"}] конец`;
    const out = parseContradictions(raw);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('high');
    expect(out[0].subject).toContain('Авач');
  });

  it('returns [] for an empty array (no contradictions)', () => {
    expect(parseContradictions('[]')).toEqual([]);
  });

  it('drops items failing schema (bad severity / missing field)', () => {
    const raw = `[{"subject":"вертолёты","statement_a":"летают","statement_b":"отменены","severity":"high","why":"взаимоисключают"},{"subject":"x","statement_a":"a","statement_b":"b","severity":"ОЧЕНЬ","why":"z"}]`;
    const out = parseContradictions(raw);
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('вертолёты');
  });

  it('returns [] on malformed / missing JSON', () => {
    expect(parseContradictions('нет данных')).toEqual([]);
    expect(parseContradictions('')).toEqual([]);
    expect(parseContradictions('[broken')).toEqual([]);
  });
});
