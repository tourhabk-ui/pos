// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { GET } from '@/app/llms-zh.txt/route';
import { LLMS_ZH_TOPICS } from '@/lib/mcp/zh-layer';
import { ACTIVITY_LABELS } from '@/lib/tours/labels';

describe('/llms-zh.txt', () => {
  it('отдаёт китайский текст с ключевыми словами и адресом MCP', async () => {
    const res = await GET();
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-language')).toBe('zh-CN');
    const body = await res.text();
    for (const w of ['堪察加', '火山', '温泉', '观熊', '住宿', '接送', '预订', 'https://vedarai.ru/api/mcp']) {
      expect(body).toContain(w);
    }
    expect(body).not.toMatch(/₽|руб|¥|\d+\s*元/);
  });
  it('темы — только существующие типы активностей', () => {
    for (const t of LLMS_ZH_TOPICS) expect(ACTIVITY_LABELS[t.key], t.key).toBeTruthy();
  });
});
