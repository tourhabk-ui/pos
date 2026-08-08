/**
 * MCP-бронирование (Эволюция 3.0, п.4; план согласован владельцем 08.08:
 * «делай»).
 *
 * Витрина в мир агентов: внешний AI ищет туры, проверяет РЕАЛЬНУЮ занятость
 * и оставляет заявку на бронь. Границы согласованного плана:
 *   - занятость — только движок планера (fetchAvailabilityForTour), тот же
 *     расчёт, что у гейта брони; свой SQL — разойдётся и агент пообещает
 *     места, по которым бронь отклонят;
 *   - запись — ЗАЯВКА через общий createLead (скоринг, дедуп), не бронь и
 *     не оплата: никакого INSERT в operator_bookings (§7 — брони живут по
 *     правилам комиссий) и ничего из app/api/payments;
 *   - анонимный вход тормозится rate-limit по IP: чтение щедрое, запись
 *     жёсткая (заявка создаёт работу живому менеджеру).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOL_NAMES, BOOKING_REQUEST_TOOL, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/api/mcp/route.ts'), 'utf-8');
const AVAIL_TOOL = readFileSync(join(ROOT, 'lib/kuzmich/tour-availability-tool.ts'), 'utf-8');
const CORE = readFileSync(join(ROOT, 'lib/kuzmich/core.ts'), 'utf-8');

describe('п.4: занятость тура — инструмент одного мозга', () => {
  it('get_tour_availability в реестре Кузьмича и в диспетчере', () => {
    expect(TOOL_REGISTRY.get_tour_availability).toBeDefined();
    expect(TOOL_REGISTRY.get_tour_availability!.definition.function.parameters.required).toEqual(['tour']);
    expect(CORE).toMatch(/getTourAvailabilityForKuzmich/);
  });

  it('наружу в MCP инструмент виден автоматически (реестр — один список)', () => {
    expect(PUBLIC_MCP_TOOL_NAMES.has('get_tour_availability')).toBe(true);
  });

  it('занятость — только движок планера, без своего SQL по tour_availability', () => {
    expect(AVAIL_TOOL).toMatch(/fetchAvailabilityForTour/);
    expect(AVAIL_TOOL).not.toMatch(/FROM tour_availability/);
  });
});

describe('п.4: заявка на бронь — не бронь и не оплата', () => {
  it('create_booking_request объявлен и требует тур, дату, имя и телефон', () => {
    expect(PUBLIC_MCP_TOOL_NAMES.has('create_booking_request')).toBe(true);
    expect([...BOOKING_REQUEST_TOOL.inputSchema.required]).toEqual(['tour', 'date', 'name', 'phone']);
  });

  it('перед заявкой — реальная занятость; нет мест → отказ с ближайшими датами', () => {
    expect(ROUTE).toMatch(/fetchAvailabilityForTour\(String\(tour\.id\), date, date, cache\)/);
    expect(ROUTE).toMatch(/remaining < participants/);
    expect(ROUTE).toMatch(/заявка не создана/);
  });

  it('запись — только createLead: ни броней, ни платежей из MCP', () => {
    expect(ROUTE).toMatch(/createLead\(\{/);
    expect(ROUTE).not.toMatch(/INSERT INTO operator_bookings/i);
    expect(ROUTE).not.toMatch(/from '@\/lib\/payments/);
    expect(ROUTE).not.toMatch(/recordCommissionFromBooking/);
  });

  it('в ответе агенту прямо сказано, что это заявка, а не оплата', () => {
    expect(ROUTE).toMatch(/Это заявка, не оплата/);
  });
});

describe('п.4: rate-limit по IP', () => {
  it('чтение и запись тормозятся раздельно, запись жёстче', () => {
    expect(ROUTE).toMatch(/readLimiter = createRateLimiter\(\{ windowMs: 60_000, max: 30 \}\)/);
    expect(ROUTE).toMatch(/writeLimiter = createRateLimiter\(\{ windowMs: 600_000, max: 5 \}\)/);
    expect(ROUTE).toMatch(/WRITE_TOOLS = new Set<string>\(\[CREATE_LEAD_TOOL\.name, BOOKING_REQUEST_TOOL\.name\]\)/);
  });

  it('лимит проверяется ДО исполнения инструмента', () => {
    expect(ROUTE.indexOf('limiter.check')).toBeLessThan(ROUTE.indexOf('await executeTool(toolName'));
  });
});

describe('п.4: манифест не отстаёт', () => {
  it('версия сервера поднята и описание упоминает заявку на бронь', () => {
    expect(MCP_SERVER_INFO.version).not.toBe('2.1.0');
    expect(MCP_SERVER_INFO.description).toContain('create_booking_request');
  });
});
