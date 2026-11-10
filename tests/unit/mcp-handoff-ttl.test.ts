// @vitest-environment node
/**
 * Срок ссылки «Продолжить в Ведаре» (#3199, M11в): на страницу сохранённого
 * плана /trip/<id> — 7 дней, как сам черновик; на остальные цели — 48 часов.
 * Прежде ссылка на живой план гасла на третий день, а ответ обещал 7 дней.
 * Судится вызовом issueMcpHandoff с подменённой базой: какой срок уходит в
 * INSERT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { issueMcpHandoff } from '@/lib/mcp/handoff';

const DAY = 24 * 60 * 60 * 1000;

function expiresOfInsert(): number {
  const call = query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO mcp_handoffs'));
  const params = call?.[1] as unknown[];
  return (params[6] as Date).getTime();
}

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql: string) =>
    String(sql).includes('RETURNING id') ? { rows: [{ id: 'h-1' }] } : { rows: [] });
});

describe('срок ссылки по цели', () => {
  it('страница плана /trip/<id> — 7 дней', async () => {
    const before = Date.now();
    const r = await issueMcpHandoff({
      toolName: 'make_trip_plan',
      target: { targetType: 'plan', targetPath: '/trip/2f0c1a9e-1111-4222-8333-444455556666' },
    });
    expect(r?.handoffId).toBe('h-1');
    const ttl = expiresOfInsert() - before;
    expect(ttl).toBeGreaterThan(7 * DAY - 60_000);
    expect(ttl).toBeLessThanOrEqual(7 * DAY + 60_000);
  });

  it('тур и образец /plans/ — 48 часов, как было', async () => {
    for (const target of [
      { targetType: 'tour' as const, targetPath: '/catalog/tours/51' },
      { targetType: 'plan' as const, targetPath: '/plans/pervaya-poezdka-na-kamchatku' },
    ]) {
      query.mockClear();
      const before = Date.now();
      await issueMcpHandoff({ toolName: 'get_tour_details', target });
      const ttl = expiresOfInsert() - before;
      expect(ttl).toBeGreaterThan(2 * DAY - 60_000);
      expect(ttl).toBeLessThanOrEqual(2 * DAY + 60_000);
    }
  });
});
