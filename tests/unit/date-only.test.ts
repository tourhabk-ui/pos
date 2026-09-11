/**
 * Дата без времени на границе API и в кабинете оператора (#1795).
 *
 * DATE из node-pg уезжает в JSON как `2026-09-20T00:00:00.000Z`; клиенты,
 * дописывавшие `'T00:00'`, показывали `Invalid Date` в списке броней, на
 * карточке брони и в расписании тура. Здесь держится: разборщик принимает
 * обе формы и не выдаёт мусор за дату; API отдаёт DATE строкой `::text`;
 * в кабинете оператора ручной конкатенации больше нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { parseDateOnly, formatDateOnly, toDateOnlyString, DATE_MISSING_LABEL } from '@/lib/dates/date-only';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('parseDateOnly: три исхода — дата / нет / мусор', () => {
  it('принимает YYYY-MM-DD и ISO-timestamp одинаково', () => {
    const a = parseDateOnly('2026-09-20');
    const b = parseDateOnly('2026-09-20T00:00:00.000Z');
    expect(a).not.toBeNull();
    expect(toDateOnlyString(a)).toBe('2026-09-20');
    expect(toDateOnlyString(b)).toBe('2026-09-20');
  });

  it('полночь UTC не сдвигает сутки в любой зоне (полдень локально)', () => {
    const d = parseDateOnly('2026-09-20T00:00:00.000Z');
    expect(d?.getDate()).toBe(20);
    expect(d?.getHours()).toBe(12);
  });

  it('пустое, null, мусор и несуществующая дата — null, а не Invalid Date', () => {
    for (const v of [null, undefined, '', 'вчера', '2026-02-31', 20260920, {}]) {
      expect(parseDateOnly(v)).toBeNull();
    }
  });

  it('formatDateOnly при отсутствии — подпись словами', () => {
    expect(formatDateOnly(null)).toBe(DATE_MISSING_LABEL);
    expect(formatDateOnly('2026-09-20T00:00:00.000Z', { day: 'numeric', month: 'numeric', year: 'numeric' })).toBe('20.09.2026');
    expect(formatDateOnly('2026-09-20')).not.toContain('Invalid');
  });
});

describe('граница API: DATE отдаётся строкой', () => {
  it('список и карточка броней, RETURNING брони, расписание тура — ::text', () => {
    const list = read('app/api/hub/operator/bookings/route.ts');
    expect(list).toMatch(/b\.booking_date::text AS booking_date/);
    expect(list).toMatch(/RETURNING id, booking_date::text AS booking_date/);
    expect(read('app/api/hub/operator/bookings/[id]/route.ts')).toMatch(/b\.booking_date::text AS booking_date/);
    expect(read('lib/api/operator-tours.ts')).toMatch(/a\.date::text AS date/);
  });
});

describe('кабинет оператора: ручной конкатенации даты нет', () => {
  it("ни одного `+ 'T00:00'` / `+ 'T12:00:00'` под app/hub/operator", () => {
    const out = execSync(
      `grep -rnE "\\+ 'T(00:00|12:00:00)'" app/hub/operator --include=*.tsx || true`,
      { cwd: process.cwd(), encoding: 'utf-8' },
    ).trim();
    expect(out, `ручная сборка даты:\n${out}`).toBe('');
  });

  it('экраны с датой брони и расписанием тура зовут общий formatDateOnly', () => {
    for (const p of [
      'app/hub/operator/bookings/_BookingsManagementClient.tsx',
      'app/hub/operator/bookings/[id]/_BookingDetailClient.tsx',
      'app/hub/operator/tours/[id]/_EditTourClient.tsx',
    ]) {
      expect(read(p), p).toMatch(/formatDateOnly\(/);
    }
  });

  it('«Обновлено:» на карточке брони печатается только при наличии значения', () => {
    expect(read('app/hub/operator/bookings/[id]/_BookingDetailClient.tsx'))
      .toMatch(/booking\.updated_at && ` · Обновлено:/);
  });
});
