/**
 * Подпись длины тура и бронь называют одно число дней (20.11, слово владельца
 * «Исправить»).
 *
 * До этого дня подпись (`cardDuration`) начинала с типа тура: у тура с
 * `duration_type = 'day'`, которому записано пять дней, карточка, get_tours,
 * get_tour_details и сравнение говорили «1 день», MCP fetch — часы или
 * ничего, а бронь (`tourDurationDays`, lib/bookings/duration) держала пять
 * дней. Часы от суток подпись округляла вниз (30 ч — «1 день»), бронь —
 * вверх (2 дня).
 *
 * Судится вызовом: правило на сетке значений и три двери агента на
 * подложенной строке базы.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query }, transaction: vi.fn() }));

import { cardDuration } from '@/lib/tours/card-facts';
import { plateDuration } from '@/lib/home/plate-facts';
import { tourDurationDays } from '@/lib/bookings/duration';
import { fetchDocument } from '@/lib/mcp/connector-tools';
import { getTourDetails } from '@/lib/kuzmich/core';

beforeEach(() => query.mockReset());

const TYPES = [null, 'day', 'half_day', 'multi_day'] as const;
const COUNTS = [null, 0, 1, 2, 5] as const;
const HOURS = [null, 3, 10.5, 23, 24, 30, 48, 72] as const;

/** Число дней в подписи «N дней»; часы, «Полдня» и молчание — один день или null. */
function daysSaid(label: string | null): number | null {
  const m = label?.match(/^(\d+) (?:день|дня|дней)$/);
  return m ? Number(m[1]) : null;
}

describe('подпись длины и правило брони', () => {
  it('многодневный по брони — подпись называет то же число дней при любом типе', () => {
    for (const duration_type of TYPES) for (const multi_day_count of COUNTS) for (const duration_hours of HOURS) {
      const booking = tourDurationDays({ multi_day_count, duration_hours });
      const label = cardDuration({ duration_type, multi_day_count, duration_hours });
      const ctx = JSON.stringify({ duration_type, multi_day_count, duration_hours, label, booking });
      if (booking > 1) {
        expect(daysSaid(label), ctx).toBe(booking);
      } else {
        // Бронь держит один день — подпись не обещает нескольких.
        const said = daysSaid(label);
        expect(said === null || said === 1, ctx).toBe(true);
      }
    }
  });

  it('случаи, которые расходились до 20.11', () => {
    expect(cardDuration({ duration_type: 'day', multi_day_count: 5 })).toBe('5 дней');
    expect(cardDuration({ duration_type: 'day', multi_day_count: 5, duration_hours: 8 })).toBe('5 дней');
    expect(cardDuration({ duration_type: 'half_day', multi_day_count: 2 })).toBe('2 дня');
    expect(cardDuration({ duration_hours: 30 })).toBe('2 дня');
    expect(cardDuration({ duration_type: 'multi_day', multi_day_count: 1, duration_hours: 30 })).toBe('2 дня');
  });

  it('однодневные подписи не изменились', () => {
    expect(cardDuration({ duration_type: 'day', duration_hours: 3 })).toBe('3 ч');
    expect(cardDuration({ duration_type: 'day' })).toBe('1 день');
    expect(cardDuration({ duration_type: 'half_day' })).toBe('Полдня');
    expect(cardDuration({ duration_type: 'multi_day', multi_day_count: 1 })).toBe('1 день');
    expect(cardDuration({ duration_hours: 24 })).toBe('1 день');
    expect(cardDuration({ duration_hours: '10.5' })).toBe('10,5 ч');
    expect(cardDuration({})).toBeNull();
  });

  it('сравнение туров (plateDuration) — то же правило', () => {
    expect(plateDuration({ durationType: 'day', multiDayCount: 5, durationHours: null })).toBe('5 дней');
    expect(plateDuration({ durationType: null, multiDayCount: null, durationHours: 30 })).toBe('2 дня');
  });
});

const FETCH_ROW = {
  id: '91', title: 'Тур на пять дней с типом «на день»', slug: null, short_description: null, description: null,
  base_price: '50000.00', currency: 'RUB', price_unit: 'per_person', duration_hours: '8', duration_type: 'day', multi_day_count: 5,
  difficulty: null, season_start: null, season_end: null, location_name: null, included: null, not_included: null,
  what_to_bring: null, safety_notes: null, program: null, price_note: null, cancellation_policy: null, max_participants: 10,
  group_size_unlimited: false, operator_name: 'Оператор',
};

describe('двери агента', () => {
  it('MCP fetch tour: — «5 дней», как бронь, а не «8 ч»', async () => {
    query.mockResolvedValueOnce({ rows: [FETCH_ROW] });
    const doc = await fetchDocument('tour:91', 'https://vedarai.ru');
    expect(doc.text).toContain('Длительность: 5 дней');
    expect(doc.text).not.toContain('8 ч');
    expect((doc.metadata as { duration?: unknown }).duration).toBe('5 дней');
  });

  it('get_tour_details — «Длительность: 5 дней», а не «1 день»', async () => {
    query.mockResolvedValue({ rows: [{
      id: 91, title: 'Тур на пять дней с типом «на день»', base_price: 50000, price_unit: 'per_person',
      short_description: null, description: null, meeting_point: null, included: null, not_included: null,
      what_to_bring: null, cancellation_policy: null, location_name: null, activity_type: 'jeep',
      program: null, safety_notes: null, pickup_type: null, pickup_details: null, max_participants: 10,
      operator_name: 'Оператор', operator_legal_name: null, operator_inn: null, operator_ogrn: null,
      duration_type: 'day', multi_day_count: 5, duration_hours: null,
    }] });
    const out = await getTourDetails('Тур на пять дней');
    expect(out).toContain('Длительность: 5 дней');
    expect(out).not.toContain('Длительность: 1 день');
  });
});
