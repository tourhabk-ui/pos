/**
 * Отказ базы на турах — «не смог проверить», а не «туров нет» (проверка MCP
 * 29.09, §4.0).
 *
 * До этого дня get_tours при отказе отвечал «Туры не найдены.», get_tour_details
 * и get_tour_availability — «тур не найден», create_booking_request — «тур не
 * найден среди активных — заявка не создана». Все четыре — обычным
 * результатом: внешний агент пересказывал человеку ложный факт о каталоге.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) },
}));

import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { TOOL_EXECUTION_FAILED } from '@/lib/kuzmich/tool-failure';
import { POST } from '@/app/api/mcp/route';

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  query.mockImplementation(async () => { throw Object.assign(new Error('connection terminated'), { code: '57P01' }); });
});
afterEach(() => spy.mockRestore());

describe('исполнитель Кузьмича: отказ базы — ошибка выполнения', () => {
  it('get_tours', async () => {
    expect(await executeKuzmichTool('get_tours', {})).toBe(TOOL_EXECUTION_FAILED);
  });

  it('get_tour_details', async () => {
    expect(await executeKuzmichTool('get_tour_details', { name: 'Сплав' })).toBe(TOOL_EXECUTION_FAILED);
  });

  it('get_tour_availability', async () => {
    expect(await executeKuzmichTool('get_tour_availability', { tour: 'Сплав' })).toBe(TOOL_EXECUTION_FAILED);
  });
});

describe('туров действительно нет — прежний ответ', () => {
  it('get_tour_details: «не найден» только когда база ответила пустотой', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    expect(await executeKuzmichTool('get_tour_details', { name: 'Сплав' })).toMatch(/Тур на платформе не найден/);
  });
});

describe('create_booking_request: отказ базы — не «тур не найден»', () => {
  it('isError и текст о сбое', async () => {
    const res = await POST(new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '10.8.0.1' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'create_booking_request', arguments: { tour: 'Сплав', date: '2027-07-10', name: 'Иван', phone: '+79001234567', consent: true } },
      }),
    }));
    const json = await res.json();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/Не удалось проверить тур/);
    expect(json.result.content[0].text).not.toMatch(/не найден/);
  });
});

// Проверка MCP 29.09 (T6): «расписания нет» ≠ «мест нет».
describe('get_tour_availability: тур без расписания — не «мест нет»', () => {
  it('нет календаря — места уточняются у оператора, путь через create_booking_request', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/FROM operator_tours/.test(sql)) return { rows: [{ id: 7, title: 'Тур без календаря', operator_id: 'op', base_price: 5000, price_unit: 'person' }] };
      if (/SELECT EXISTS/.test(sql)) return { rows: [{ has: false }] };
      return { rows: [] };
    });
    const text = await executeKuzmichTool('get_tour_availability', { tour: '7' });
    expect(text).toMatch(/расписания в системе нет/);
    expect(text).toMatch(/create_booking_request/);
    expect(text).not.toMatch(/реальная занятость мест/);
  });
});
