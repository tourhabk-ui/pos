/** Тестовый стенд пилота рыбалки (24.10). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isTestStandPartner, TEST_STAND_PARTNER_IDS } from '@/lib/seat-requests/test-stand';
import { summaryEnabledFor } from '@/lib/seat-requests/summary';

const FISHING = '0aaa4f05-b479-418b-9d54-2b909783dfd7';

describe('тестовый стенд', () => {
  it('один тестовый оператор, не настоящий партнёр', () => {
    expect(TEST_STAND_PARTNER_IDS).toEqual(['0c595568-163b-4870-ab03-edf60d1d939e']);
    expect(isTestStandPartner(FISHING)).toBe(false);
    expect(isTestStandPartner(null)).toBe(false);
  });
  it('флаг пилота включает стенд и рыбалку', () => {
    expect(summaryEnabledFor(TEST_STAND_PARTNER_IDS[0]!)).toBe(true);
    expect(summaryEnabledFor(FISHING)).toBe(true);
  });
  it('неопубликованный тур проходит только у стенда, витрина не тронута', () => {
    for (const f of ['lib/seat-requests/service.ts', 'lib/bookings/reserve.ts']) {
      expect(readFileSync(f, 'utf8')).toMatch(/is_published = true OR (ot\.)?operator_id = ANY\(\$2::uuid\[\]\)/);
    }
    expect(readFileSync('lib/tours/public-visibility.ts', 'utf8')).not.toMatch(/TEST_STAND/);
    const page = readFileSync('app/seat-request/test/page.tsx', 'utf8');
    expect(page).toMatch(/operator_id = ANY\(\$2::uuid\[\]\)/);
    expect(page).toMatch(/index: false/);
  });
});
