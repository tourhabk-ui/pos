/**
 * Крон health: отказ счёта «лидов без обработки > 6ч» не молчит (§4.0,
 * аудит 15.10, доводка волны 3). Прежний `catch { /* skip *\/ }` превращал
 * отказ запроса в «лидов нет» — без строки в логе. Судится вызовом checkDB
 * с подменённым пулом: запрос лидов падает, остальные отвечают пусто.
 */
import { describe, it, expect, vi } from 'vitest';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { checkDB } from '@/app/api/cron/health/route';

describe('health: счёт лидов > 6ч', () => {
  it('отказ запроса — строка в логе с кодом, тревоги «N лидов» нет', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (/FROM leads/.test(sql) && /6 hours/.test(sql)) {
        throw Object.assign(new Error('relation "leads" does not exist'), { code: '42P01' });
      }
      return { rows: [] };
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const issues = await checkDB();
    expect(issues.some((i) => i.text.includes('лидов без обработки'))).toBe(false);
    const line = log.mock.calls.find((c) => String(c[0]).includes('счёт лидов без обработки > 6ч'));
    expect(line, 'отказ счёта лидов не попал в лог').toBeTruthy();
    expect(line?.[0]).toMatch(/^\[health\]/);
    expect(line?.[1]).toMatchObject({ code: '42P01' });
    log.mockRestore();
  });
});
