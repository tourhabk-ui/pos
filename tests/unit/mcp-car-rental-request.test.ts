/**
 * create_car_rental_request — заявка прокатчику через MCP (решение владельца 23.10).
 * Путь тот же, что у формы на странице прокатчика (saveRentalLead); в журнал
 * crm_events пишется событие. Пробная заявка (test: true) с 08.11 — общее
 * правило шести заявок: не записывается вовсе (вызовом —
 * tests/unit/mcp-write-contract.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAR_RENTAL_REQUEST_TOOL, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';

const ROUTE = readFileSync('app/api/mcp/route.ts', 'utf-8');

describe('create_car_rental_request', () => {
  it('пишущий, требует согласия, машины и контакта; даты — названные или из плана', () => {
    expect(WRITE_TOOL_NAMES.has(CAR_RENTAL_REQUEST_TOOL.name)).toBe(true);
    expect([...CAR_RENTAL_REQUEST_TOOL.inputSchema.required].sort()).toEqual(['car', 'consent', 'name', 'phone']);
    expect(CAR_RENTAL_REQUEST_TOOL.inputSchema.properties).toHaveProperty('plan_id');
    expect(CAR_RENTAL_REQUEST_TOOL.inputSchema.properties).toHaveProperty('test');
  });

  it('идёт через сервис формы проката, событие в журнал', () => {
    expect(ROUTE).toMatch(/saveRentalLeadDetailed\(/);
    expect(ROUTE).toMatch(/recordSourceEventQuietly\(/);
    expect(ROUTE).toMatch(/admitWrite\([^)]*'rental'[,)]/);
  });

  it('пробная заявка больше не пишется лидом «своей пробы» (до 08.11 менеджер её видел)', () => {
    expect(ROUTE).not.toMatch(/TEST_MARK/);
    expect(ROUTE).not.toMatch(/isSelf: ctx\.self \|\| isTest/);
  });
});
