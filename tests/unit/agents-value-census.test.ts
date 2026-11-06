// @vitest-environment node
/**
 * Перепись пользы агентов (05.11, владелец: «нужно ли такое количество
 * агентов?»). Сторож держит: род записи — пять исходов, «не меряли» не
 * равно «ноль»; каждая запись реестра — одна строка; роут закрыт секретом,
 * отдаёт числа без ПД, холостых — первыми; отказ журнала — 503, а не пусто.
 * Расход модели — из книг (llm_usage_log) по agent_id: у записи без журнала
 * (судья, ревью эволюции) — по ключу реестра; строки без агента и агенты вне
 * реестра названы отдельно (06.11).
 * SQL исполняется на настоящей схеме — tests/integration/leads-followup.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { classifyAgentValue, joinWithRegistry, splitSpend, spendIdOf, toModelSpend, toSpend, toStats, type AgentRunStats } from '@/lib/agents/agents-value-census';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';

const stats = (over: Partial<AgentRunStats>): AgentRunStats => ({
  agent_id: 'x', runs: 10, ok: 10, partial: 0, failed: 0, measured_runs: 10, productive_runs: 0,
  items_processed: 0, items_created: 0, llm_calls: 0, cost_usd: 0, last_run: null, last_productive: null, ...over,
});

describe('род агента по журналу', () => {
  it('пять исходов: без телеметрии, молчит, без меры, холостой, полезный', () => {
    expect(classifyAgentValue(null, null)).toBe('no_telemetry');
    expect(classifyAgentValue('a', null)).toBe('silent');
    expect(classifyAgentValue('a', stats({ runs: 0 }))).toBe('silent');
    expect(classifyAgentValue('a', stats({ measured_runs: 0 }))).toBe('unmeasured');
    expect(classifyAgentValue('a', stats({}))).toBe('idle');
    expect(classifyAgentValue('a', stats({ productive_runs: 1, items_processed: 3 }))).toBe('productive');
  });

  it('каждая запись реестра — одна строка; запись без телеметрии журналом не судится', () => {
    const editor = CRON_REGISTRY.find((e) => e.agentId)!;
    const rows = joinWithRegistry(new Map([[editor.agentId!, stats({ agent_id: editor.agentId!, productive_runs: 2 })]]));
    expect(rows).toHaveLength(CRON_REGISTRY.length);
    expect(rows.find((r) => r.key === editor.key)!.kind).toBe('productive');
    for (const r of rows.filter((x) => !x.agent_id)) expect(r.kind).toBe('no_telemetry');
  });

  it('числа из базы (строки bigint/numeric) читаются числами, даты — ISO', () => {
    const s = toStats({
      agent_id: 'a', runs: 3, ok: 2, partial: 1, failed: 0, measured_runs: 3, productive_runs: 1,
      items_processed: '12', items_created: '0', llm_calls: '4', cost_usd: '0.123456',
      last_run: new Date('2026-11-05T10:00:00Z'), last_productive: '2026-11-04T10:00:00Z',
    });
    expect(s).toMatchObject({ items_processed: 12, llm_calls: 4, cost_usd: 0.123456, last_run: '2026-11-05T10:00:00.000Z', last_productive: '2026-11-04T10:00:00.000Z' });
  });
});

describe('расход модели по книгам', () => {
  it('у записи без журнала расход ищется по ключу реестра (судья эволюции)', () => {
    const judge = CRON_REGISTRY.find((e) => e.key === 'evo-judge')!;
    expect(judge.agentId).toBeNull();
    expect(spendIdOf(judge)).toBe('evo-judge');
    const split = splitSpend([{ agent_id: 'evo-judge', calls: 46, cost_usd: 3.1, unpriced_calls: 0 }]);
    const rows = joinWithRegistry(new Map(), split.byId);
    const row = rows.find((r) => r.key === 'evo-judge')!;
    expect(row.kind).toBe('no_telemetry');
    expect(row.llm).toEqual({ calls: 46, cost_usd: 3.1, unpriced_calls: 0 });
  });

  it('строки без агента — «без хозяина», агенты вне реестра — отдельным списком, дороже первыми', () => {
    const split = splitSpend([
      { agent_id: null, calls: 120, cost_usd: 0.9, unpriced_calls: 3 },
      { agent_id: 'kuzmich', calls: 500, cost_usd: 1.2, unpriced_calls: 0 },
      { agent_id: 'grader', calls: 10, cost_usd: 2.5, unpriced_calls: 0 },
    ]);
    expect(split.unattributed).toEqual({ calls: 120, cost_usd: 0.9, unpriced_calls: 3 });
    expect(split.outside.map((o) => o.agent_id)).toEqual(['grader', 'kuzmich']);
    expect(split.byId.size).toBe(0);
  });

  it('строка «агент × модель»: числа из базы — числами, дни и даты — как есть, без цены — null', () => {
    expect(toModelSpend({
      agent_id: 'kuzmich-eval-commercial', model: 'anthropic/claude-opus-5.5', calls: '120', cost_usd: null,
      unpriced_calls: '120', days_active: '3', first_at: new Date('2026-10-30T05:00:00Z'), last_at: '2026-11-03T10:00:00Z',
      prompt_tokens: '5000', completion_tokens: '700', cache_read_tokens: '90000', upper_bound_calls: '118',
    })).toEqual({
      agent_id: 'kuzmich-eval-commercial', model: 'anthropic/claude-opus-5.5', calls: 120, cost_usd: null,
      unpriced_calls: 120, days_active: 3, first_at: '2026-10-30T05:00:00.000Z', last_at: '2026-11-03T10:00:00.000Z',
      prompt_tokens: 5000, completion_tokens: 700, cache_read_tokens: 90000, upper_bound_calls: 118,
    });
  });

  it('кэш не сообщён ни одной строкой пары — null, а не ноль', () => {
    const row = toModelSpend({
      agent_id: null, model: 'm', calls: 1, cost_usd: 0.1, unpriced_calls: 0, days_active: 1,
      first_at: null, last_at: null, prompt_tokens: 10, completion_tokens: 5, cache_read_tokens: null, upper_bound_calls: 0,
    });
    expect(row.cache_read_tokens).toBeNull();
    expect(row.prompt_tokens).toBe(10);
  });

  it('цены нет ни у одной строки — null, а не ноль', () => {
    expect(toSpend({ agent_id: 'a', calls: '4', cost_usd: null, unpriced_calls: '4' }))
      .toEqual({ calls: 4, cost_usd: null, unpriced_calls: 4 });
  });
});

describe('GET /api/cron/agents-value-census', () => {
  const call = async (auth: string | null, qs = '') => {
    const { GET } = await import('@/app/api/cron/agents-value-census/route');
    const headers: Record<string, string> = auth ? { authorization: auth } : {};
    const { NextRequest } = await import('next/server');
    return GET(new NextRequest(`http://x/api/cron/agents-value-census${qs}`, { headers }));
  };

  beforeEach(() => {
    process.env.CRON_SECRET = 's3cret';
    query.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('без секрета — 401, журнал не читается', async () => {
    expect((await call(null)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('окно — из ?days с потолком 90; холостые первыми, полезные последними; в ответе нет текста прогонов', async () => {
    const [a, b] = CRON_REGISTRY.filter((e) => e.agentId).slice(0, 2);
    query.mockImplementation(async (sql: string) => (/GROUP BY agent_id, route/.test(sql)
      ? { rows: [
        { agent_id: 'evo-judge', model: 'anthropic/claude-opus-5.5', calls: 46, cost_usd: '3.1', unpriced_calls: 0, days_active: 1, first_at: null, last_at: null },
      ] }
      : /FROM llm_usage_log/.test(sql)
      ? { rows: [
        { agent_id: 'evo-judge', calls: 46, cost_usd: '3.1', unpriced_calls: 0 },
        { agent_id: null, calls: 7, cost_usd: '0.2', unpriced_calls: 1 },
      ] }
      : { rows: [
        { agent_id: a.agentId, runs: 5, ok: 5, partial: 0, failed: 0, measured_runs: 5, productive_runs: 0, items_processed: 0, items_created: 0, llm_calls: 0, cost_usd: 0, last_run: null, last_productive: null },
        { agent_id: b.agentId, runs: 5, ok: 5, partial: 0, failed: 0, measured_runs: 5, productive_runs: 5, items_processed: 9, items_created: 0, llm_calls: 2, cost_usd: '0.5', last_run: null, last_productive: null },
      ] }));
    const res = await call('Bearer s3cret', '?days=365');
    const json = await res.json();
    for (const c of query.mock.calls) expect(c[1]).toEqual([90]);
    expect(json.days).toBe(90);
    expect(json.agents).toBe(CRON_REGISTRY.length);
    expect(json.by_kind.idle).toBeGreaterThanOrEqual(1);
    expect(json.llm_cost_usd).toBe(0.5);
    expect(json.llm_books_registry_usd).toBe(3.1);
    expect(json.llm_unattributed).toEqual({ calls: 7, cost_usd: 0.2, unpriced_calls: 1 });
    expect(json.items.find((r: { key: string }) => r.key === 'evo-judge').llm.cost_usd).toBe(3.1);
    expect(json.probe).toBe('agents_value_census_v4');
    expect(json.llm_by_agent_model).toEqual([expect.objectContaining({ agent_id: 'evo-judge', model: 'anthropic/claude-opus-5.5', calls: 46, days_active: 1 })]);
    const kinds = json.items.map((r: { kind: string }) => r.kind);
    expect(kinds[0]).toBe('idle');
    expect(kinds[kinds.length - 1]).toBe('productive');
    expect(JSON.stringify(json)).not.toMatch(/error_msg|metadata/);
  });

  it('журнал не прочитался — 503 с названной причиной, а не пустой список', async () => {
    query.mockRejectedValue(Object.assign(new Error('x'), { code: '57P01' }));
    const res = await call('Bearer s3cret');
    expect(res.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('журнал прогонов не прочитан'), '57P01');
  });
});
