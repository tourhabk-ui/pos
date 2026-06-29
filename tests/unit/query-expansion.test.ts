import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallAIFast = vi.fn();
vi.mock('@/lib/ai/providers', () => ({ callAIFast: (...a: unknown[]) => mockCallAIFast(...a) }));

import { parseQueryVariants, expandQuery, multiQueryEnabled } from '@/lib/ai/query-expansion';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RAG_MULTIQUERY;
});

describe('parseQueryVariants', () => {
  it('always includes the original first', () => {
    expect(parseQueryVariants('', 'вулкан')).toEqual(['вулкан']);
  });

  it('parses newline-separated variants and strips list markers', () => {
    const raw = '1. восхождение на вулкан\n2) подъём на сопку\n- треккинг к кратеру';
    const out = parseQueryVariants(raw, 'вулкан');
    expect(out[0]).toBe('вулкан');
    expect(out).toContain('восхождение на вулкан');
    expect(out).toContain('подъём на сопку');
  });

  it('parses a JSON array of variants', () => {
    const out = parseQueryVariants('["сплав по реке","рафтинг"]', 'сплав');
    expect(out).toEqual(['сплав', 'сплав по реке', 'рафтинг']);
  });

  it('dedups against original and caps the count', () => {
    const raw = 'вулкан\nВУЛКАН\nсопка\nгора\nхребет\nпик';
    const out = parseQueryVariants(raw, 'вулкан');
    expect(out.filter(v => v.toLowerCase() === 'вулкан')).toHaveLength(1);
    expect(out.length).toBeLessThanOrEqual(4); // оригинал + max 3
  });
});

describe('expandQuery (env-gated, fail-open)', () => {
  it('default OFF: returns [original] without calling AI', async () => {
    const out = await expandQuery('вулкан Авачинский');
    expect(out).toEqual(['вулкан Авачинский']);
    expect(mockCallAIFast).not.toHaveBeenCalled();
    expect(multiQueryEnabled()).toBe(false);
  });

  it('ON: expands short queries via AI', async () => {
    process.env.RAG_MULTIQUERY = '1';
    mockCallAIFast.mockResolvedValue('сопка\nгора');
    const out = await expandQuery('вулкан');
    expect(out).toContain('вулкан');
    expect(out).toContain('сопка');
    expect(mockCallAIFast).toHaveBeenCalledTimes(1);
  });

  it('ON: does not expand long queries', async () => {
    process.env.RAG_MULTIQUERY = '1';
    const out = await expandQuery('как добраться до вулкана и сколько это стоит летом');
    expect(out).toHaveLength(1);
    expect(mockCallAIFast).not.toHaveBeenCalled();
  });

  it('ON: fail-open when AI throws → [original]', async () => {
    process.env.RAG_MULTIQUERY = '1';
    mockCallAIFast.mockRejectedValue(new Error('egress'));
    const out = await expandQuery('гейзер');
    expect(out).toEqual(['гейзер']);
  });
});
