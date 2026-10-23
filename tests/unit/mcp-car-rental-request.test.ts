/**
 * create_car_rental_request — заявка прокатчику через MCP (решение владельца 23.10).
 * Путь тот же, что у формы на странице прокатчика (saveRentalLead); пробная
 * заявка (test: true) не уходит прокатчику; в журнал crm_events пишется событие.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAR_RENTAL_REQUEST_TOOL, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';

const ROUTE = readFileSync('app/api/mcp/route.ts', 'utf-8');

describe('create_car_rental_request', () => {
  it('пишущий, требует согласия, машины, дат и контакта', () => {
    expect(WRITE_TOOL_NAMES.has(CAR_RENTAL_REQUEST_TOOL.name)).toBe(true);
    expect([...CAR_RENTAL_REQUEST_TOOL.inputSchema.required].sort()).toEqual(['car', 'consent', 'date_from', 'date_to', 'name', 'phone']);
    expect(CAR_RENTAL_REQUEST_TOOL.inputSchema.properties).toHaveProperty('test');
  });

  it('идёт через сервис формы проката, пробная не доставляется прокатчику, событие в журнал', () => {
    expect(ROUTE).toMatch(/saveRentalLead\(/);
    expect(ROUTE).toMatch(/isSelf: ctx\.self \|\| isTest/);
    expect(ROUTE).toMatch(/recordSourceEventQuietly\(/);
    expect(ROUTE).toMatch(/admitWrite\([^)]*'rental'\)/);
  });
});
