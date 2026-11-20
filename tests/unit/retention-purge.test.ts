/**
 * Уборка технических журналов по сроку хранения (#3388, п. 2, шаг 2).
 *
 * Что держится:
 *  - каждый журнал переписи с 90-дневным сроком либо убирается, либо назван
 *    в списке пропущенных с причиной — молча выпавшего нет;
 *  - сухой прогон только считает: ни DELETE, ни UPDATE, ни строки журнала;
 *  - с apply — пачками до исчерпания или до потолка, и тогда `more`;
 *  - журнал уборки пишется на каждое действие; его отказ уборку не роняет;
 *  - нет таблицы — свой исход, отказ — «не смог» с SQLSTATE, а не ноль;
 *  - роут закрыт CRON_SECRET и по умолчанию сухой.
 * На настоящем PostgreSQL — блок «уборка сроков хранения» в
 * tests/integration/schema-model.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

import {
  PURGE_STEPS, PURGE_SKIPPED, PURGE_LOG_SQL, ERASED_MARK,
  purgeCountSql, purgeBatchSql, runRetentionPurge, type PurgeStep,
} from '@/lib/legal/retention-purge';
import { RETENTION_TARGETS } from '@/lib/legal/retention-census';

const step = (table: string): PurgeStep => {
  const s = PURGE_STEPS.find((x) => x.table === table);
  if (!s) throw new Error(`нет шага ${table}`);
  return s;
};

beforeEach(() => { poolQuery.mockReset(); });

describe('список уборки', () => {
  it('каждый журнал переписи с 90-дневным сроком — либо убирается, либо пропущен с причиной; не то и другое сразу', () => {
    const logs = RETENTION_TARGETS.filter((t) => t.term === 'tech_logs_90d' || t.term === 'own_expiry').map((t) => t.table);
    const purged = PURGE_STEPS.map((s) => s.table);
    const skipped = Object.keys(PURGE_SKIPPED);
    expect(logs.filter((t) => !purged.includes(t) && !skipped.includes(t))).toEqual([]);
    expect(purged.filter((t) => skipped.includes(t))).toEqual([]);
    // Ни шаг, ни пропуск не называют таблицу вне переписи: иначе её срок никто не считает.
    expect([...purged, ...skipped].filter((t) => !logs.includes(t))).toEqual([]);
    for (const [t, why] of Object.entries(PURGE_SKIPPED)) expect(why.length, t).toBeGreaterThan(10);
  });

  it('у каждого шага срок переписи (журналы — 90 дней) и причина словами', () => {
    for (const s of PURGE_STEPS) {
      const target = RETENTION_TARGETS.find((t) => t.table === s.table);
      expect(s.days, s.table).toBe(target?.days);
      expect(s.column, s.table).toBe(target?.column);
      expect(s.why.length, s.table).toBeGreaterThan(20);
    }
    // Свой срок (own_expiry) — память агентов и черновики заявок ИИ-агентов: удаляются в день истечения.
    const own = RETENTION_TARGETS.filter((t) => t.term === 'own_expiry').map((t) => t.table);
    expect(own).toEqual(['agent_memory', 'mcp_pending_requests']);
    expect(PURGE_STEPS.filter((s) => !own.includes(s.table)).every((s) => s.days === 90)).toBe(true);
  });

  it('память агентов: удаляется истёкшее по её собственному сроку, бессрочное не трогается (#3433)', () => {
    expect(step('agent_memory')).toMatchObject({ column: 'expires_at', days: 0, action: { kind: 'delete' } });
    // NULL в «expires_at < …» не проходит: запись без срока под условие не попадает.
    expect(purgeBatchSql(step('agent_memory'))).toMatch(
      /^DELETE FROM agent_memory WHERE ctid = ANY\(ARRAY\(SELECT ctid FROM agent_memory WHERE expires_at < NOW\(\) - make_interval\(days => \$1::int\) LIMIT \$2::int\)\)$/,
    );
  });

  it('строки, которые читают без окна, не удаляются, а обезличиваются', () => {
    // admin-owners-census, «за всё время» A2A, даты «с какого дня» MCP, расход ИИ по диапазону.
    for (const t of ['audit_log', 'audit_logs', 'a2a_requests', 'mcp_tool_calls', 'llm_usage_log', 'page_views']) {
      expect(step(t).action.kind, t).toBe('anonymize');
    }
  });
});

describe('SQL', () => {
  it('удаление: пачка по ctid, срок параметром через make_interval', () => {
    const sql = purgeBatchSql(step('rag_quality_log'));
    expect(sql).toMatch(/^DELETE FROM rag_quality_log WHERE ctid = ANY\(ARRAY\(SELECT ctid FROM rag_quality_log WHERE created_at < NOW\(\) - make_interval\(days => \$1::int\) LIMIT \$2::int\)\)$/);
    expect(purgeCountSql(step('rag_quality_log'))).toMatch(/^SELECT COUNT\(\*\)::int AS n FROM rag_quality_log WHERE created_at < NOW\(\) - make_interval\(days => \$1::int\)$/);
  });

  it('обезличивание: только поля о человеке; колонка без NULL — метка; уже убранное не трогается', () => {
    const sql = purgeBatchSql(step('a2a_requests'));
    expect(sql).toContain(`UPDATE a2a_requests SET context_key = NULL, caller_hash = '${ERASED_MARK}' WHERE`);
    expect(sql).toContain(`AND (context_key IS NOT NULL OR caller_hash <> '${ERASED_MARK}')`);
    expect(purgeBatchSql(step('audit_log'))).toContain("SET ip_address = NULL, user_agent = NULL, data = data - ARRAY['email','inn']::text[] WHERE");
  });

  it('журнал аудита: из data уходят почта и ИНН, а ключи, которые читает перепись владельцев, остаются', () => {
    const a = step('audit_log').action;
    if (a.kind !== 'anonymize') throw new Error('audit_log должен обезличиваться');
    expect(a.jsonDrop).toEqual({ column: 'data', keys: ['email', 'inn'] });
    // admin-owners-census судит по role, from, to и changedBy.
    for (const k of ['role', 'from', 'to', 'changedBy']) expect(a.jsonDrop?.keys).not.toContain(k);
    expect(purgeCountSql(step('audit_log'))).toContain("OR data ?| ARRAY['email','inn'])");
  });

  it('mcp_clients — по дню записи, а не по created_at', () => {
    expect(purgeCountSql(step('mcp_clients'))).toContain('WHERE day < NOW() - make_interval');
  });

  it('недопустимое имя — отказ, а не запрос', () => {
    const bad: PurgeStep = { table: 'x; DROP TABLE y', column: 'created_at', days: 90, action: { kind: 'delete' }, why: 'проверка' };
    expect(() => purgeBatchSql(bad)).toThrow(/недопустимое имя/);
    const badCol: PurgeStep = { ...step('audit_log'), action: { kind: 'anonymize', nullable: ['ip_address = 1, x'] } };
    expect(() => purgeCountSql(badCol)).toThrow(/недопустимое имя/);
    const badKey: PurgeStep = { ...step('audit_log'), action: { kind: 'anonymize', nullable: [], jsonDrop: { column: 'data', keys: ["email'] OR TRUE --"] } } };
    expect(() => purgeBatchSql(badKey)).toThrow(/недопустимое имя/);
  });
});

describe('прогон', () => {
  const two = [step('rag_quality_log'), step('audit_log')];

  it('сухой прогон только считает — ни удаления, ни обезличивания, ни журнала', async () => {
    const q = vi.fn(async () => ({ rows: [{ n: 7 }] }));
    const run = await runRetentionPurge(q, { apply: false, steps: two });
    expect(run).toMatchObject({ apply: false, total: 14, failed: 0 });
    for (const [sql] of q.mock.calls as unknown as Array<[string]>) expect(sql).toMatch(/^SELECT COUNT/);
  });

  it('с apply — пачками до исчерпания, журнал на каждое действие', async () => {
    const counts = [3, 2, 1, 0];
    const q = vi.fn(async (sql: string) => (sql.startsWith('INSERT') ? { rows: [], rowCount: 1 } : { rows: [], rowCount: counts.shift() ?? 0 }));
    const run = await runRetentionPurge(q, { apply: true, steps: two, batch: 3 });
    // rag_quality_log: 3 (полная пачка) + 2 (меньше пачки — конец); audit_log: 1.
    expect(run.rows).toEqual([
      { table: 'rag_quality_log', action: 'delete', state: 'ok', rows: 5, more: false },
      { table: 'audit_log', action: 'anonymize', state: 'ok', rows: 1, more: false },
    ]);
    const logs = (q.mock.calls as unknown as Array<[string, unknown[]]>).filter(([sql]) => sql === PURGE_LOG_SQL).map(([, p]) => p);
    expect(logs).toEqual([['rag_quality_log', 'delete', 5, 'ok', null], ['audit_log', 'anonymize', 1, 'ok', null]]);
  });

  it('потолок пачек — остаток назван, а не потерян', async () => {
    const q = vi.fn(async (sql: string) => (sql.startsWith('INSERT') ? { rows: [] } : { rows: [], rowCount: 2 }));
    const run = await runRetentionPurge(q, { apply: true, steps: [step('rag_quality_log')], batch: 2, maxBatches: 3 });
    expect(run.rows[0]).toEqual({ table: 'rag_quality_log', action: 'delete', state: 'ok', rows: 6, more: true });
  });

  it('нет таблицы — свой исход; отказ — «не смог» с SQLSTATE и строкой журнала; журнал упал — уборка идёт дальше', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT')) throw Object.assign(new Error('журнал недоступен'), { code: '42P01' });
      if (sql.includes('rag_quality_log')) throw Object.assign(new Error('нет'), { code: '42P01' });
      throw Object.assign(new Error('сбой'), { code: '57014' });
    });
    const run = await runRetentionPurge(q, { apply: true, steps: two });
    expect(run.rows).toEqual([
      { table: 'rag_quality_log', action: 'delete', state: 'no_table' },
      { table: 'audit_log', action: 'anonymize', state: 'failed', reason: 'SQLSTATE 57014' },
    ]);
    expect(run.failed).toBe(1);
    const lines = err.mock.calls.map((c) => JSON.stringify(c));
    expect(lines.some((l) => l.includes('уборка не удалась') && l.includes('57014'))).toBe(true);
    expect(lines.some((l) => l.includes('журнал уборки не записан'))).toBe(true);
    err.mockRestore();
  });
});

describe('GET /api/cron/retention-purge', () => {
  it('без секрета — 401; по умолчанию сухой прогон; ?apply=1 — уборка', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const { GET } = await import('@/app/api/cron/retention-purge/route');
    expect((await GET(new NextRequest('https://vedarai.ru/api/cron/retention-purge'))).status).toBe(401);
    expect(poolQuery).not.toHaveBeenCalled();

    poolQuery.mockResolvedValue({ rows: [{ n: 0 }], rowCount: 0 });
    const auth = { headers: { authorization: 'Bearer test-secret' } };
    const dry = await (await GET(new NextRequest('https://vedarai.ru/api/cron/retention-purge', auth))).json();
    expect(dry).toMatchObject({ ok: true, apply: false, total: 0 });
    expect(poolQuery.mock.calls.every(([sql]) => String(sql).startsWith('SELECT COUNT'))).toBe(true);

    poolQuery.mockClear();
    const applied = await (await GET(new NextRequest('https://vedarai.ru/api/cron/retention-purge?apply=1', auth))).json();
    expect(applied.apply).toBe(true);
    expect(poolQuery.mock.calls.some(([sql]) => /^(DELETE|UPDATE)/.test(String(sql)))).toBe(true);
    // В ответе только таблицы и числа.
    expect(Object.keys(applied.rows[0]).sort()).toEqual(['action', 'more', 'rows', 'state', 'table']);
  });
});
