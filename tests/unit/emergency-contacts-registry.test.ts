/**
 * tests/unit/emergency-contacts-registry.test.ts
 *
 * Справочник телефонов + сверка (issue #366, миграция 722):
 * - normalizePhone: код страны и форматирование не мешают сравнению;
 * - computePhoneDiscrepancies: конфликт внутри назначения ловится,
 *   совпадающие номера из разных источников — нет;
 * - similarPairs: 41-03-03 (код) vs 41-03-95 (портал) помечается как
 *   вероятная опечатка;
 * - health-эндпоинт: без админа не отдаёт данные, форма ответа.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

import {
  normalizePhone,
  computePhoneDiscrepancies,
  HARDCODED_PHONE_SITES,
} from '@/lib/services/safety/emergency-contacts';
import { GET as getHealth } from '@/app/api/admin/health/emergency-contacts/route';

beforeEach(() => {
  poolQueryMock.mockReset();
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
});

describe('normalizePhone', () => {
  it('снимает форматирование и код страны 7/8', () => {
    expect(normalizePhone('+7 (4152) 41-03-03')).toBe('4152410303');
    expect(normalizePhone('8 (4152) 41-03-03')).toBe('4152410303');
    expect(normalizePhone('112')).toBe('112');
  });
});

describe('computePhoneDiscrepancies', () => {
  it('разные номера в одном назначении у разных источников → расхождение', () => {
    const { discrepancies } = computePhoneDiscrepancies([
      { phone: '+7 (4152) 30-10-81', name: 'ЦУКС', purpose: 'registration', source: 'visitkamchatka' },
      { phone: '+7 (4152) 29-99-99', name: 'МЧС', purpose: 'registration', source: 'code' },
    ]);
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0].purpose).toBe('registration');
    expect(discrepancies[0].phones).toHaveLength(2);
  });

  it('одинаковый номер в разном форматировании → НЕ расхождение', () => {
    const { discrepancies } = computePhoneDiscrepancies([
      { phone: '+7 (4152) 30-10-81', name: 'ЦУКС', purpose: 'registration', source: 'visitkamchatka' },
      { phone: '8 (4152) 301-08-1', name: 'ЦУКС у нас', purpose: 'registration', source: 'code' },
    ]);
    expect(discrepancies).toHaveLength(0);
  });

  it('конфликт внутри ОДНОГО источника расхождением не считается', () => {
    const { discrepancies } = computePhoneDiscrepancies([
      { phone: '+7 (4152) 23-53-62', name: 'МЧС', purpose: 'emergency', source: 'code' },
      { phone: '+7 (4152) 29-99-99', name: 'МЧС дежурный', purpose: 'emergency', source: 'code' },
    ]);
    expect(discrepancies).toHaveLength(0);
  });

  it('похожие номера код/портал (41-03-03 vs 41-03-95) → similarPairs', () => {
    const { similarPairs } = computePhoneDiscrepancies([
      { phone: '+7 (4152) 41-03-03', name: 'ПАСС', purpose: 'emergency', source: 'code' },
      { phone: '+7 (4152) 41-03-95', name: 'ПСО края', purpose: 'consultation', source: 'visitkamchatka' },
    ]);
    expect(similarPairs).toHaveLength(1);
    expect(similarPairs[0].digitDiff).toBe(2);
    expect(similarPairs[0].codePhone).toContain('41-03-03');
    expect(similarPairs[0].portalPhone).toContain('41-03-95');
  });

  it('непохожие номера в similarPairs не попадают', () => {
    const { similarPairs } = computePhoneDiscrepancies([
      { phone: '+7 (4152) 23-53-62', name: 'МЧС', purpose: 'emergency', source: 'code' },
      { phone: '+7 (4152) 30-10-81', name: 'ЦУКС', purpose: 'registration', source: 'visitkamchatka' },
    ]);
    expect(similarPairs).toHaveLength(0);
  });
});

describe('GET /api/admin/health/emergency-contacts', () => {
  it('без админа → ответ requireAdmin, БД не трогается', async () => {
    requireAdminMock.mockResolvedValue(
      NextResponse.json({ error: 'Требуются права администратора' }, { status: 403 })
    );

    const res = await getHealth(new Request('http://localhost/api/admin/health/emergency-contacts') as unknown as NextRequest);
    expect(res.status).toBe(403);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('форма ответа: totals, расхождения, инвентаризация хардкода', async () => {
    poolQueryMock.mockResolvedValue({
      rows: [
        { phone: '+7 (4152) 41-03-03', name: 'ПАСС', purpose: 'emergency', source: 'code' },
        { phone: '+7 (4152) 41-03-95', name: 'ПСО края', purpose: 'consultation', source: 'visitkamchatka' },
        { phone: '+7 (415) 223-00-11', name: 'МЧС Авачинский', purpose: null, source: 'seed' },
      ],
    });

    const res = await getHealth(new Request('http://localhost/api/admin/health/emergency-contacts') as unknown as NextRequest);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.total).toBe(3);
    expect(body.data.bySource).toEqual({ code: 1, visitkamchatka: 1, seed: 1 });
    expect(body.data.similarPairs).toHaveLength(1);
    expect(body.data.hardcodedSites.length).toBe(HARDCODED_PHONE_SITES.length);
  });
});
