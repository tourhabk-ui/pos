/**
 * create_car_rental_request в два шага: согласие даёт человек, не агент.
 * Шаг 1 без кода — черновик, заявка не создаётся; шаг 2 — код к тем же полям.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CAR_RENTAL_REQUEST_TOOL } from '@/lib/mcp/public-tools';
import { issueRentalConfirmation, checkRentalConfirmation, RENTAL_CONFIRM_TTL_MIN } from '@/lib/mcp/rental-confirmation';

const ROUTE = readFileSync('app/api/mcp/route.ts', 'utf-8');
const F = { company: 'laguna', car: 'Suzuki Jimny', dateFrom: '2026-11-10', dateTo: '2026-11-14', name: 'Иван', phone: '+79001234567', pickup: '', comment: '', test: false };

describe('create_car_rental_request: два шага', () => {
  const saved = process.env.MCP_HASH_SALT;
  beforeEach(() => { process.env.MCP_HASH_SALT = 'test-salt'; });
  afterEach(() => { process.env.MCP_HASH_SALT = saved; });

  it('описание велит спросить человека и не ставить consent самому', () => {
    expect(CAR_RENTAL_REQUEST_TOOL.description).toMatch(/спроси у человека имя и телефон/);
    expect(CAR_RENTAL_REQUEST_TOOL.description).toMatch(/Никогда не ставь consent: true сам/);
    expect(CAR_RENTAL_REQUEST_TOOL.inputSchema.properties).toHaveProperty('confirmation');
  });

  it('код подходит к тем же полям и не подходит к изменённым', () => {
    const code = issueRentalConfirmation(F)!;
    expect(checkRentalConfirmation(code, F)).toBe('ok');
    expect(checkRentalConfirmation(code, { ...F, phone: '+79001234568' })).toBe('mismatch');
    expect(checkRentalConfirmation(code, { ...F, test: true })).toBe('mismatch');
    expect(checkRentalConfirmation('garbage', F)).toBe('mismatch');
  });

  it('код истекает', () => {
    const now = Date.now();
    const code = issueRentalConfirmation(F, now)!;
    expect(checkRentalConfirmation(code, F, now + (RENTAL_CONFIRM_TTL_MIN + 2) * 60000)).toBe('expired');
  });

  it('без секрета — отказ, а не пропуск', () => {
    delete process.env.MCP_HASH_SALT; const c = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
    expect(issueRentalConfirmation(F)).toBeNull();
    expect(checkRentalConfirmation('x.y', F)).toBe('unavailable');
    if (c !== undefined) process.env.CRON_SECRET = c;
  });

  it('без кода заявка не пишется: черновик возвращается до admitWrite и saveRentalLead', () => {
    const draft = ROUTE.indexOf('if (!parsed.data.confirmation)');
    expect(draft).toBeGreaterThan(0);
    expect(draft).toBeLessThan(ROUTE.indexOf("admitWrite(ctx, CAR_RENTAL_REQUEST_TOOL.name"));
    expect(ROUTE).toMatch(/заявка ещё НЕ создана/);
  });
});
