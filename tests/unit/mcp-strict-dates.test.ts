/**
 * Явная недата не становится другим днём (аудит MCP 25.10).
 *
 * get_tour_availability с date_from «not-a-date» отвечал успехом на сегодня
 * по Камчатке. Пустое поле по-прежнему может значить «сегодня». 2026-02-30 и
 * 2026-13-01 — не даты и не переносятся. То же у плана, заявки на тур,
 * чартера и жилья. Прокат сюда не входит: его даты закрыты до 26.10.
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
    throw new Error('план на недату собираться не должен');
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
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.25.1.${ipSeq}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const json = await res.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
  return json.result ?? { isError: false, content: [] };
}

function lastJournal(): unknown[] {
  const rows = query.mock.calls.filter(([sql]) => typeof sql === 'string' && /INSERT INTO mcp_tool_calls/.test(sql));
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1][1] as unknown[];
}

const BOOKING = {
  tour: '67', date: '2027-07-15', participants: 2, name: 'Иван Петров', phone: '+79001234567', consent: true,
};

describe('readCalendarDate', () => {
  it('пустое — отсутствие, мусор и несуществующий день — отказ, прошедший день назван', () => {
    expect(readCalendarDate(undefined, TODAY)).toEqual({ kind: 'absent' });
    expect(readCalendarDate('  ', TODAY)).toEqual({ kind: 'absent' });
    expect(readCalendarDate('not-a-date', TODAY)).toMatchObject({ kind: 'invalid' });
    expect(readCalendarDate('2026-02-30', TODAY)).toMatchObject({ kind: 'invalid' });
    expect(readCalendarDate('2026-13-01', TODAY)).toMatchObject({ kind: 'invalid' });
    expect(readCalendarDate('2026-10-20', TODAY)).toEqual({ kind: 'date', date: '2026-10-20', past: true });
    expect(readCalendarDate('2027-07-15', TODAY)).toEqual({ kind: 'date', date: '2027-07-15', past: false });
  });
});

describe('get_tour_availability: явная недата — isError, не сегодня', () => {
  it.each(['not-a-date', '2026-02-30', '2026-13-01'])('%s', async (date_from) => {
    const result = await call('get_tour_availability', { tour: '67', date_from, days: '3', people: '2' });
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toMatch(/не принята/);
    expect(text).not.toMatch(/2026-10-25|2026-10-26|2026-10-27|25\.10|свободно/);
    expect(text).not.toMatch(/Собрал|Окно:/);
    const j = lastJournal();
    expect(j[2]).toBe('refused');
    expect(j[7]).toBe('invalid_date');
  });

  it('в чате та же фраза, на MCP исключение для isError', async () => {
    const chat = await executeKuzmichTool('get_tour_availability', { tour: '67', date_from: 'not-a-date', days: '3' });
    expect(chat).toMatch(/не принята/);
    expect(chat).not.toMatch(/Ошибка при выполнении запроса/);
    await expect(executeKuzmichTool(
      'get_tour_availability',
      { tour: '67', date_from: '2026-02-30' },
      { surface: 'mcp' },
    )).rejects.toBeInstanceOf(McpUserError);
  });
});

describe('make_trip_plan: явная недата не собирает план', () => {
  it.each(['not-a-date', '2026-02-30', 'когда-нибудь потом'])('%s', async (when) => {
    const result = await call('make_trip_plan', { when, days: '7' });
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toMatch(/не принято как дата поездки/);
    expect(text).not.toMatch(/Собрал план/);
    expect(lastJournal()[7]).toBe('invalid_date');
  });
});

describe('заявки: недата — isError до записи', () => {
  it('create_booking_request: форма и календарь', async () => {
    const garbage = await call('create_booking_request', { ...BOOKING, date: 'not-a-date' });
    expect(garbage.isError).toBe(true);
    expect(garbage.content?.[0]?.text).toMatch(/YYYY-MM-DD/);
    const rolled = await call('create_booking_request', { ...BOOKING, date: '2026-02-30' });
    expect(rolled.isError).toBe(true);
    expect(rolled.content?.[0]?.text).toMatch(/нет в календаре/);
    const month = await call('create_booking_request', { ...BOOKING, date: '2026-13-01' });
    expect(month.isError).toBe(true);
    expect(month.content?.[0]?.text).toMatch(/нет в календаре/);
  });
});
