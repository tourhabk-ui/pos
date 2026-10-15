/**
 * Сторож единого словаря статусов брони (аудит 15.10, A11).
 *
 * Словарей `operator_bookings.booking_status` было два, и они расходились:
 * `lib/types/statuses.ts` знал `rejected` без `no_show` (по нему фильтровала
 * админка), `types/booking.types.ts` — `no_show` без `rejected` (по нему
 * строились переходы статусов). Теперь источник один, а второй модуль его
 * только отдаёт дальше. Сторож держит именно это: оба модуля отдают ОДИН
 * объект, переходы определены ровно на нём, и своего перечня во втором модуле
 * не появилось.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as statuses from '@/lib/types/statuses';
import * as bookingTypes from '@/types/booking.types';
import { FREEING_BOOKING_STATUSES } from '@/lib/bookings/occupancy';

const DICTIONARY: readonly string[] = statuses.BOOKING_STATUSES;

describe('один источник', () => {
  it('оба модуля отдают один и тот же список, а не два совпавших', () => {
    expect(bookingTypes.BOOKING_STATUSES).toBe(statuses.BOOKING_STATUSES);
  });

  it('состав — решение A11: шесть статусов с производителем, без rejected', () => {
    expect([...DICTIONARY].sort()).toEqual(
      ['cancelled', 'completed', 'confirmed', 'new', 'no_show', 'pending_payment'],
    );
    expect(DICTIONARY).not.toContain('rejected');
  });

  it('переходы статусов определены ровно на словаре', () => {
    expect(Object.keys(bookingTypes.ALLOWED_TRANSITIONS).sort()).toEqual([...DICTIONARY].sort());
    for (const [from, targets] of Object.entries(bookingTypes.ALLOWED_TRANSITIONS)) {
      for (const to of targets) expect(DICTIONARY, `${from} → ${to}`).toContain(to);
    }
    for (const s of bookingTypes.TERMINAL_STATUSES) expect(DICTIONARY).toContain(s);
    for (const s of bookingTypes.CANCELLED_STATUSES) expect(DICTIONARY).toContain(s);
  });

  it('rejected остаётся в защитном WHERE занятости: читать лишнее значение безвредно', () => {
    expect([...FREEING_BOOKING_STATUSES]).toContain('rejected');
  });

  it('во втором модуле нет своего перечня статусов (запрет)', () => {
    const src = readFileSync(join(process.cwd(), 'types/booking.types.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/type\s+BookingStatus\s*=/);
    expect(src).not.toMatch(/BOOKING_STATUSES\s*=/);
  });
});
