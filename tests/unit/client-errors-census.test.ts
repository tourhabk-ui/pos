// @vitest-environment node
/**
 * Суточная перепись ловушки ошибок (client-errors-census, 13.10) — поведением
 * с подменённым пулом и подменённым Telegram: группы и итоги в ответе,
 * чистка только по ?prune=1, дайджест только по ?notify=1 и только когда
 * есть что сказать; упавший замер — в failed_measures, а не пустой список.
 * Плюс запуск: workflow по расписанию зовёт роут с prune и notify, реестр
 * кронов и возможностей знает запись.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, unknown>;
const queries: Array<{ sql: string; params: unknown[] }> = [];
let answer: (sql: string) => Row[] | Error = () => [];
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const out = answer(sql);
      if (out instanceof Error) throw out;
      return { rows: out, rowCount: /DELETE/.test(sql) ? 7 : out.length };
    }),
  },
}));

import { GET, RETENTION_DAYS, digestText } from '@/app/api/cron/client-errors-census/route';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const ROOT = process.cwd();

const GROUP = { fingerprint: 'abc123abc123abc1', kind: 'error', message: "Cannot read properties of undefined (reading 'map')", n: '14', visitor_days: '9', paths: ['/catalog', '/catalog/tours/51'], from_phone: '11', offline_n: '2', builds: ['d9793da8'], first_seen: '2026-10-13 05:10', last_seen: '2026-10-13 18:40' };

function healthyAnswer(sql: string): Row[] {
  if (/COUNT\(\*\) AS rows,/.test(sql)) return [{ rows: '20', external: '16', self: '3', bot: '1', visitor_days: '9' }];
  if (/GROUP BY 1, 2/.test(sql) && /NOT is_self AND NOT is_bot/.test(sql)) return [GROUP];
  if (/GROUP BY 1, 2/.test(sql) && /AND is_self/.test(sql)) return [{ ...GROUP, fingerprint: 'self0000self0000', message: 'owner-only crash', n: '3', visitor_days: '1' }];
  if (/COUNT\(DISTINCT fingerprint\) AS groups/.test(sql)) return [{ path: '/catalog', n: '12', groups: '1' }];
  if (/rows_total/.test(sql)) return [{ rows_total: '120', since: '2026-10-13' }];
  return [];
}

function get(qs = '', secret = 'cron-test') {
  return GET(new NextRequest(`http://localhost/api/cron/client-errors-census${qs}`, { headers: { Authorization: `Bearer ${secret}` } }));
}

beforeEach(() => {
  queries.length = 0;
  answer = healthyAnswer;
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_CHAT_ID', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('перепись', () => {
  it('итоги, группы внешних и своих, пути; без prune ничего не удаляет; 401 без секрета', async () => {
    const res = await get('?days=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.totals).toEqual({ rows: 20, external: 16, self: 3, bot: 1, visitor_days: 9 });
    expect(body.groups[0]).toMatchObject({ fingerprint: 'abc123abc123abc1', n: 14, visitor_days: 9, from_phone: 11, offline_n: 2, builds: ['d9793da8'], paths: ['/catalog', '/catalog/tours/51'] });
    expect(body.self_groups[0]).toMatchObject({ message: 'owner-only crash', n: 3 });
    expect(body.by_path).toEqual([{ path: '/catalog', n: 12, groups: 1 }]);
    expect(body.marks).toEqual({ rows_total: 120, since: '2026-10-13' });
    expect(body.pruned).toBeNull();
    expect(body.notify).toBeNull();
    expect(queries.some((q) => /DELETE/.test(q.sql))).toBe(false);
    // Окно — параметром, не склейкой строки.
    expect(queries.every((q) => !/interval '\d/.test(q.sql))).toBe(true);
    expect((await get('', 'wrong')).status).toBe(401);
  });

  it(`?prune=1 удаляет только старше ${RETENTION_DAYS} дней и называет число`, async () => {
    const body = await (await get('?days=1&prune=1')).json();
    const del = queries.find((q) => /DELETE FROM client_errors/.test(q.sql));
    expect(del).toBeDefined();
    expect(del?.sql).toMatch(/created_at < NOW\(\) - \(\$1 \|\| ' days'\)::interval/);
    expect(del?.params).toEqual([String(RETENTION_DAYS)]);
    expect(body.pruned).toBe(7);
  });

  it('упавший замер — в failed_measures и ok=false, а не пустые группы', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    answer = (sql) => (/GROUP BY 1, 2/.test(sql) && /NOT is_self/.test(sql) ? Object.assign(new Error('boom'), { code: '42703' }) : healthyAnswer(sql));
    const body = await (await get('?days=1')).json();
    expect(body.ok).toBe(false);
    expect(body.groups).toBeNull();
    expect(body.failed_measures).toEqual([expect.stringContaining('groups: 42703')]);
    expect(err).toHaveBeenCalled();
  });
});

describe('дайджест в Telegram', () => {
  it('?notify=1 шлёт верх списка и цифры; без ошибок не шлёт и говорит почему; отказ канала — в ответе', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tok');
    vi.stubEnv('TELEGRAM_CHAT_ID', '42');
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response('{"ok":true}', { status: 200 });
    }));
    const body = await (await get('?days=1&notify=1')).json();
    expect(body.notify).toEqual({ sent: true, reason: 'доставлен' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/bot');
    const text = String(calls[0].body.text);
    expect(text).toContain('внешних 16');
    expect(text).toContain("reading &#39;map&#39;");
    expect(text).toContain('owner-only crash');
    expect(text).not.toContain('abc123abc123abc1');

    answer = (sql) => (/COUNT\(\*\) AS rows,/.test(sql) ? [{ rows: '0', external: '0', self: '0', bot: '0', visitor_days: '0' }] : []);
    const quiet = await (await get('?days=1&notify=1')).json();
    expect(quiet.notify).toEqual({ sent: false, reason: 'ошибок нет' });
    expect(calls).toHaveLength(1);

    answer = healthyAnswer;
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = await (await get('?days=1&notify=1')).json();
    expect(down.notify.sent).toBe(false);
    expect(down.notify.reason).toContain('TELEGRAM_BOT_TOKEN');
    expect(err).toHaveBeenCalled();
  });

  it('digestText экранирует HTML и укладывается в потолок', () => {
    const t = digestText(1, { rows: 1, external: 1, self: 0, bot: 0, visitor_days: 1 }, [{ fingerprint: 'f', kind: 'error', message: '<script>alert(1)</script>', n: 1, visitor_days: 1, paths: ['/x'], from_phone: 0, offline_n: 0, builds: [], first_seen: '', last_seen: '' }], []);
    expect(t).toContain('&lt;script&gt;');
    expect(t).not.toContain('<script>');
    expect(t.length).toBeLessThanOrEqual(3500);
  });
});

describe('запуск и объявления', () => {
  it('workflow по расписанию зовёт перепись с prune и notify; реестры знают запись; красный только без ответа', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/cron-client-errors.yml'), 'utf8');
    expect(wf).toMatch(/schedule:\s*\n\s*- cron: '17 19 \* \* \*'/);
    expect(wf).toMatch(/\/api\/cron\/client-errors-census\?days=1&prune=1&notify=1/);
    expect(wf).toContain('secrets.CRON_SECRET');
    const entry = CRON_REGISTRY.find((e) => e.key === 'client-errors-census');
    expect(entry).toMatchObject({ workflow: 'cron-client-errors.yml', cron: '17 19 * * *', tier: 'ops' });
    expect(CRON_CAPABILITIES['client-errors-census']).toEqual(expect.arrayContaining(['db_read', 'db_write', 'telegram']));
    // Миграция таблицы есть — реестр схемы (schema-coverage) её видит.
    expect(readFileSync(join(ROOT, 'migrations/1236_client_errors.sql'), 'utf8')).toMatch(/CREATE TABLE IF NOT EXISTS client_errors/);
  });
});
