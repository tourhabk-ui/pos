/**
 * tests/unit/evo-report-source-fetch.test.ts
 *
 * 404 (файла на main нет) и сеть/таймаут раньше давали одну и ту же реакцию
 * в GET /api/cron/evo-report — публикацию находки без сверки («не судим,
 * иначе при недоступном GitHub отбросим всё»). Разница дорогая: issue #1852
 * (заглушка `createCloudPaymentsRefund`) завели ПОВТОРНО 13.09 на файл,
 * удалённый в #1842 ещё 12.09 — fetchSource получил 404, и находка ушла в
 * трекер как живая, хотя файла, о котором она говорит, больше нет.
 *
 * Проверено выполнением: мокаем githubFetch на три статуса ответа и смотрим,
 * что fetchSource различает их, а не схлопывает в один null.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/agents/evo/github-fetch', () => ({
  githubFetch: vi.fn(),
}));

import { githubFetch } from '@/lib/agents/evo/github-fetch';
import { fetchSource } from '@/app/api/cron/evo-report/route';

const mockedFetch = vi.mocked(githubFetch);

describe('fetchSource различает «файла нет» и «не знаем»', () => {
  it('404 — файл удалён с main, статус not_found', async () => {
    mockedFetch.mockResolvedValueOnce({ status: 404, ok: false } as Response);
    const result = await fetchSource('lib/payments/transfer-payments.ts');
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('200 — тело файла возвращается статусом ok', async () => {
    mockedFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => 'export const x = 1;',
    } as unknown as Response);
    const result = await fetchSource('lib/notifications/sms.ts');
    expect(result).toEqual({ kind: 'ok', text: 'export const x = 1;' });
  });

  it('500 — не 404, не 200: настоящее «не знаем», не not_found', async () => {
    mockedFetch.mockResolvedValueOnce({ status: 500, ok: false } as Response);
    const result = await fetchSource('lib/notifications/sms.ts');
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('сетевой сбой/таймаут (throw) — тоже «не знаем», не not_found', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('timeout'));
    const result = await fetchSource('lib/notifications/sms.ts');
    expect(result).toEqual({ kind: 'unknown' });
  });
});
