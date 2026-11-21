/**
 * Явная недата не становится другим днём (аудит MCP 25.10, перенесено из #2793).
 *
 * get_tour_availability с date_from «not-a-date» и «2026-02-30» отвечал
 * свободными местами с сегодняшнего дня по Камчатке, а с «2026-13-01» —
 * «внутренней ошибкой сервера»: дата проходила проверку формы, и окно падало
 * на toISOString. Агент, получивший места на другой день, продолжает подбор,
 * будто его дата принята. Пустое поле по-прежнему значит «с сегодня».
 *
 * Сторож — вызов настоящего роута /api/mcp и чата Кузьмича.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readCalendarDate } from '@/lib/analytics/kamchatka-day';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => query(...a), connect: vi.fn(async () => ({ query, release: vi.fn() })) },
}));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: vi.fn(async () => [{ date: '2026-10-25', remaining: 4, priceOverride: null }]),
  recommendTrip: vi.fn(async () => {
    throw new Error('план в этом тесте не собирается');
  }),
}));

import { POST } from '@/app/api/mcp/route';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { McpUserError } from '@/lib/mcp/jsonrpc';

const TODAY = '2026-10-25';

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql: unknown) => {
    if (typeof sql === 'string' && /FROM operator_tours/.test(sql)) {
      return { rows: [{ id: 67, title: 'Восхождение', base_price: 210000, price_unit: 'person', slug: null }] };
    }
    return { rows: [] };
  });
});

let ipSeq = 0;
async function call(name: string, args: Record<string, unknown>) {
  ipSeq += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.25.3.${ipSeq}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const json = await res.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  return json.result ?? { isError: false, content: [] };
}

/** Параметры последней записи журнала: (tool, ok, error_kind, …, error_code, …). */
function lastJournal(): unknown[] {
  const rows = query.mock.calls.filter(([sql]) => typeof sql === 'string' && /INSERT INTO mcp_tool_calls/.test(sql));
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1][1] as unknown[];
}

describe('readCalendarDate', () => {
  it('пустое — отсутствие, мусор и несуществующий день — отказ, прошедший день назван', () => {
    expect(readCalendarDate(undefined, TODAY)).toEqual({ kind: 'absent' });
    expect(readCalendarDate('  ', TODAY)).toEqual({ kind: 'absent' });
    expect(readCalendarDate('not-a-date', TODAY)).toMatchObject({ kind: 'invalid', raw: 'not-a-date' });
    expect(readCalendarDate('2026-02-30', TODAY)).toMatchObject({ kind: 'invalid' });
    expect(readCalendarDate('2026-13-01', TODAY)).toMatchObject({ kind: 'invalid' });
    expect(readCalendarDate('2026-10-20', TODAY)).toEqual({ kind: 'date', date: '2026-10-20', past: true });
    expect(readCalendarDate('2027-07-15', TODAY)).toEqual({ kind: 'date', date: '2027-07-15', past: false });
  });
});

describe('get_tour_availability: явная недата — isError, не сегодняшнее окно', () => {
  it.each(['not-a-date', '2026-02-30', '2026-13-01'])('%s', async (date_from) => {
    const result = await call('get_tour_availability', { tour: '67', date_from, days: '3', people: '2' });
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain(`Дата «${date_from}» не принята`);
    expect(text).toMatch(/Свободные места не проверены/);
    expect(text).not.toMatch(/свободно|Внутренняя ошибка/);
    const j = lastJournal();
    expect(j[1]).toBe(false);
    expect(j[7]).toBe('invalid_date');
  });

  it('в чате та же фраза, на MCP — исключение для isError', async () => {
    const chat = await executeKuzmichTool('get_tour_availability', { tour: '67', date_from: 'not-a-date', days: '3' });
    expect(chat).toContain('Дата «not-a-date» не принята');
    await expect(executeKuzmichTool(
      'get_tour_availability',
      { tour: '67', date_from: '2026-02-30' },
      { surface: 'mcp' },
    )).rejects.toBeInstanceOf(McpUserError);
  });

  it('пустая дата — окно с сегодняшнего дня, без отказа', async () => {
    const result = await call('get_tour_availability', { tour: '67', days: '3' });
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text ?? '').not.toMatch(/не принята/);
  });
});
