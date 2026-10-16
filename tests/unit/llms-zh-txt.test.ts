// @vitest-environment node
/**
 * /llms-zh.txt — китайский файл для агентов, которые берут файл по языку.
 *
 * Сторож держит связку целиком: файл отдаётся китайским текстом без выдуманных
 * цен (§4.0), темы — только существующие типы активностей, и у новой двери
 * есть счётчик, робот её разрешает, а китайская страница её называет. Дверь
 * без счётчика отвечала бы на вопрос «ходят ли китайские агенты» молчанием,
 * неотличимым от «не ходят» — ровно то, ради чего 15.10 в счёт взяли /zh.
 *
 * Судится поведением: ответ роута, запись счётчика параметрами SQL, правила
 * robots() вызовом, ссылка — рендером /zh, а не строкой в исходнике (13.10).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LLMS_ZH_TOPICS } from '@/lib/mcp/zh-layer';
import { ACTIVITY_LABELS } from '@/lib/tours/labels';
import { AGENT_ENTRY_PATHS } from '@/lib/analytics/agent-entry-paths';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'Mozilla/5.0 (compatible; Baiduspider/2.0)' }) }));

import { pool } from '@/lib/db-pool';
import { GET } from '@/app/llms-zh.txt/route';
import robots from '@/app/robots';
import ZhEntryPage from '@/app/zh/page';

const query = vi.mocked(pool.query);
const BAIDU = 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)';

beforeEach(() => {
  query.mockReset();
  query.mockImplementation((async () => ({ rows: [] })) as never);
});

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

describe('/llms-zh.txt: дверь видна и считается', () => {
  it('вход записан своей строкой в переписи краулеров', () => {
    expect([...AGENT_ENTRY_PATHS]).toContain('/llms-zh.txt');
  });

  it('обходчик записан своим путём и семейством, без UA и IP', async () => {
    await GET(new Request('https://vedarai.ru/llms-zh.txt', { headers: { 'user-agent': BAIDU } }));
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO agent_entry_hits/);
    expect(params).toEqual(['/llms-zh.txt', 'baidu']);
    expect(sql).not.toMatch(/user_agent|ip/i);
  });

  it('запрос без заголовков файл не роняет: счёт идёт меткой «неизвестно»', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('robots разрешает китайский файл каждой группе — иначе обходчик, уважающий robots.txt, его не возьмёт', async () => {
    const { rules } = await robots();
    const groups = Array.isArray(rules) ? rules : [rules];
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) {
      const allow = Array.isArray(g.allow) ? g.allow : [g.allow];
      expect(allow, String(g.userAgent)).toContain('/llms-zh.txt');
    }
  });

  it('китайская страница называет китайский файл ссылкой, русский — отдельно и подписан', async () => {
    const html = renderToString(await ZhEntryPage());
    expect(html).toContain('href="/llms-zh.txt"');
    expect(html).toContain('href="/llms.txt"');
    // Русский файл на китайской странице подписан как русский: иначе агент
    // возьмёт его первым и решит, что китайского слоя нет.
    expect(html).toContain('俄文完整版');
  });
});
