import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { GET } from '@/app/api/cron/kuzmich-bad-outcomes/route';
import { clusterOutcomes } from '@/lib/kuzmich/bad-outcome-clusters';

const SECRET = 's';
const req = (auth = true) => new NextRequest('https://vedarai.ru/api/cron/kuzmich-bad-outcomes?days=7',
  { headers: auth ? { authorization: `Bearer ${SECRET}` } : {} });

const ROWS = [
  { compiled_truth: 'Вопрос: позвоните +7 999 123-45-67\nОтвет: x\n\nОценка 4/10. Проблемы: Не упомянута безопасность; Выдуманная цена тура', surface: 'telegram', provider: 'deepseek', answer_path: 'tools', outcome_kind: null, score: 4 },
  { compiled_truth: 'Оценка 5/10. Проблемы: НЕЗАЗЕМЛЁННЫЕ ФАКТЫ (price): цена без инструмента, пишите на a@b.ru', surface: 'web', provider: 'qwen', answer_path: 'waterfall', outcome_kind: null, score: 5 },
  { compiled_truth: 'ОТКАЗ МОДЕЛИ', surface: 'max', provider: 'groq', answer_path: 'tools', outcome_kind: 'refusal', score: null },
];

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  query.mockReset();
  query.mockImplementation((sql: string) => Promise.resolve({ rows: /COUNT\(\*\)::int AS n/.test(sql) ? [{ n: 30 }] : ROWS }));
});

describe('kuzmich-bad-outcomes', () => {
  it('без секрета — 401, в базу не ходит', async () => {
    expect((await GET(req(false))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('кластеры с числами, без ПД и без текста вопроса', async () => {
    const json = await (await GET(req())).json();
    expect(json.bad_total).toBe(3);
    expect(json.outcomes_total).toBe(30);
    const ids = json.clusters.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['safety_missing', 'invented', 'ungrounded', 'refusal']));
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/123-45-67|a@b\.ru|Вопрос:/);
    for (const c of query.mock.calls) expect(c[1]).toEqual([7]);
  });

  it('примеров не больше двух на тип', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...ROWS[0]!, compiled_truth: `Оценка 3/10. Проблемы: Не упомянута безопасность ${i}` }));
    const c = clusterOutcomes(many).find((x) => x.id === 'safety_missing')!;
    expect(c.count).toBe(5);
    expect(c.examples.length).toBe(2);
  });

  it('отказ базы — 502', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(() => Promise.reject(Object.assign(new Error('x'), { code: '42P01' })));
    const res = await GET(req());
    expect(res.status).toBe(502);
  });
});
