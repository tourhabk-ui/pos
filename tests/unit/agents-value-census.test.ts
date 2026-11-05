// @vitest-environment node
/**
 * Перепись пользы агентов (05.11, владелец: «нужно ли такое количество
 * агентов?»). Сторож держит: род записи — пять исходов, «не меряли» не
 * равно «ноль»; каждая запись реестра — одна строка; роут закрыт секретом,
 * отдаёт числа без ПД, холостых — первыми; отказ журнала — 503, а не пусто.
 * SQL исполняется на настоящей схеме — tests/integration/agents-value-census.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { classifyAgentValue, joinWithRegistry, toStats, type AgentRunStats } from '@/lib/agents/agents-value-census';
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
    query.mockResolvedValue({ rows: [
      { agent_id: a.agentId, runs: 5, ok: 5, partial: 0, failed: 0, measured_runs: 5, productive_runs: 0, items_processed: 0, items_created: 0, llm_calls: 0, cost_usd: 0, last_run: null, last_productive: null },
      { agent_id: b.agentId, runs: 5, ok: 5, partial: 0, failed: 0, measured_runs: 5, productive_runs: 5, items_processed: 9, items_created: 0, llm_calls: 2, cost_usd: '0.5', last_run: null, last_productive: null },
    ] });
    const res = await call('Bearer s3cret', '?days=365');
    const json = await res.json();
    expect(query.mock.calls[0][1]).toEqual([90]);
    expect(json.days).toBe(90);
    expect(json.agents).toBe(CRON_REGISTRY.length);
    expect(json.by_kind.idle).toBeGreaterThanOrEqual(1);
    expect(json.llm_cost_usd).toBe(0.5);
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
