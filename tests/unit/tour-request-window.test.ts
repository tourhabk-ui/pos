/**
 * Сторож «только по сезону» (решения владельца 08.10, #2244, #2245).
 *
 * Дата без строки календаря принимается только внутри записанного сезона
 * тура, поездка должна в нём закончиться. Правило одно — lib/tours/request-window,
 * — и держится на всех дверях: бронь, запрос мест, MCP-заявка, get_tours,
 * get_tour_availability, форма карточки тура. Строка календаря сильнее
 * сезона, а прошедший сезон окна не даёт (следующего в данных нет).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) },
}));

import { requestWindow, dateInWindow, isoDay, windowLabel, outOfSeasonText, seasonWindowView } from '@/lib/tours/request-window';
import { getTourAvailabilityForKuzmich } from '@/lib/kuzmich/tour-availability-tool';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const ONE_DAY = { duration_type: null, multi_day_count: null, duration_hours: null };
const EIGHT_DAYS = { duration_type: 'multi_day', multi_day_count: 8, duration_hours: null };

describe('окно дат без календаря', () => {
  it('сезон не записан — окна нет, дата как раньше согласуется с оператором', () => {
    expect(requestWindow({ season_start: null, season_end: null, ...ONE_DAY }, '2026-10-08'))
      .toEqual({ kind: 'unbounded', why: 'not_recorded' });
    expect(requestWindow({ season_start: '2027-05-01', season_end: null, ...ONE_DAY }, '2026-10-08').kind).toBe('unbounded');
  });

  it('сезон прошёл — окна нет: следующего сезона в данных нет, и он не сочиняется', () => {
    expect(requestWindow({ season_start: '2026-08-25', season_end: '2026-09-30', ...ONE_DAY }, '2026-10-08'))
      .toEqual({ kind: 'unbounded', why: 'past' });
  });

  it('«Край Вулканов», 8 дней: сезон 01.05–01.10.2027, выезд не позже 24.09', () => {
    const w = requestWindow({ season_start: '2027-05-01', season_end: '2027-10-01', ...EIGHT_DAYS }, '2026-10-08');
    expect(w).toEqual({ kind: 'season', from: '2027-05-01', to: '2027-09-24', seasonStart: '2027-05-01', seasonEnd: '2027-10-01' });
    expect(dateInWindow(w, '2027-04-30')).toBe(false);
    expect(dateInWindow(w, '2027-05-01')).toBe(true);
    expect(dateInWindow(w, '2027-09-24')).toBe(true);
    expect(dateInWindow(w, '2027-09-25')).toBe(false);
    expect(dateInWindow(w, '2026-10-20')).toBe(false);
  });

  it('однодневный тур выезжает и в последний день сезона', () => {
    const w = requestWindow({ season_start: '2027-05-01', season_end: '2027-10-01', ...ONE_DAY }, '2026-10-08');
    expect(dateInWindow(w, '2027-10-01')).toBe(true);
  });

  it('идущий сезон начинается с сегодняшнего дня, а не с прошедшего начала', () => {
    const w = requestWindow({ season_start: '2026-08-25', season_end: '2026-10-30', ...ONE_DAY }, '2026-10-08');
    expect(w.kind === 'season' && w.from).toBe('2026-10-08');
  });

  it('сезон короче тура — окна нет, а не пустое окно, запрещающее всё', () => {
    expect(requestWindow({ season_start: '2027-05-01', season_end: '2027-05-03', ...EIGHT_DAYS }, '2026-10-08'))
      .toEqual({ kind: 'unbounded', why: 'too_short' });
  });

  it('DATE из драйвера — местные части, а не UTC (иначе день съезжает назад)', () => {
    expect(isoDay(new Date(2027, 4, 1))).toBe('2027-05-01');
    expect(isoDay('2027-10-01')).toBe('2027-10-01');
    expect(isoDay('мусор')).toBeNull();
  });

  it('подпись — с годом и с последним днём выезда', () => {
    const w = requestWindow({ season_start: '2027-05-01', season_end: '2027-10-01', ...EIGHT_DAYS }, '2026-10-08');
    if (w.kind !== 'season') throw new Error('ожидалось окно');
    expect(windowLabel(w)).toBe('сезон 1 мая 2027 — 1 октября 2027, выезд с 1 мая 2027 по 24 сентября 2027');
    expect(outOfSeasonText(w, '2027-09-25')).toContain('Дата 25 сентября 2027 вне сезона');
    expect(seasonWindowView(w)).toMatchObject({ from: '2027-05-01', to: '2027-09-24' });
    expect(seasonWindowView({ kind: 'unbounded', why: 'past' })).toBeNull();
  });
});

describe('get_tour_availability по сезону', () => {
  const TOUR = {
    id: 50, title: 'Плоский Толбачик', operator_id: 'op', slug: null,
    base_price: 60000, price_unit: 'per_person', multi_day_count: 4, duration_hours: null,
    duration_type: 'multi_day', season_start: '2099-05-01', season_end: '2099-10-01',
  };
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql: string) => {
      if (/FROM operator_tours/.test(sql) && /WHERE id = \$1/.test(sql)) return { rows: [TOUR] };
      if (/SELECT EXISTS/.test(sql)) return { rows: [{ has: false }] };
      return { rows: [] };
    });
  });
  afterEach(() => { spy.mockRestore(); query.mockReset(); });

  it('окно целиком до сезона — показано начало сезона, а не «дат нет»', async () => {
    const text = await getTourAvailabilityForKuzmich({ tour: '50', date_from: '2099-01-10', days: '3' });
    expect(text).toContain('показываю с начала сезона');
    expect(text).toContain('предварительная бронь только по сезону');
    expect(text).toMatch(/- 01\.05–03\.05(\.2099)?: свободно для заявки/);
    expect(text).not.toContain('10.01');
  });

  it('окно на краю сезона обрезается: выезд не позже 28.09 у тура на 4 дня', async () => {
    const text = await getTourAvailabilityForKuzmich({ tour: '50', date_from: '2099-09-26', days: '7' });
    expect(text).toContain('Окно обрезано по сезону');
    expect(text).toMatch(/- 26\.09–28\.09(\.2099)?: свободно для заявки/);
  });

  it('окно целиком после сезона — «не записан», без дат', async () => {
    const text = await getTourAvailabilityForKuzmich({ tour: '50', date_from: '2099-10-05', days: '7' });
    expect(text).toContain('Следующий сезон в системе не записан');
    expect(text).not.toContain('свободно для заявки');
  });
});

describe('одно правило на всех дверях', () => {
  it('бронь: дата без строки календаря проверяется сезоном, строка календаря сильнее', () => {
    const src = read('lib/bookings/reserve.ts');
    expect(src).toMatch(/startDay\.available_slots == null && startDay\.is_cancelled == null/);
    expect(src).toMatch(/requestWindow\(tour, kamchatkaToday\(\)\)/);
    expect(src).toMatch(/new ReserveError\('OUT_OF_SEASON', outOfSeasonText/);
    expect(src).toMatch(/season_start::text, ot\.season_end::text/);
  });

  it('запрос мест: дата вне сезона — отказ до оператора', () => {
    const src = read('lib/seat-requests/service.ts');
    expect(src).toMatch(/!dateInWindow\(requestWindow\(tour, kamchatkaToday\(\)\), input\.date\)/);
    expect(src.indexOf("reason: 'out_of_season'")).toBeLessThan(src.indexOf('reachForPartner(tour.operator_id)'));
    expect(read('lib/seat-requests/core.ts')).toMatch(/out_of_season:\s+\{ status: 422/);
  });

  it('get_tours и карточка тура читают то же окно', () => {
    expect(read('lib/kuzmich/core.ts')).toMatch(/предварительная бронь только по сезону \(\$\{windowLabel\(window\)\}\)/);
    const page = read('app/catalog/tours/[id]/page.tsx');
    expect(page).toMatch(/seasonWindowView\(requestWindow\(/);
    expect(read('components/marketplace/TourDateField.tsx')).toMatch(/max=\{seasonWindow\?\.to\}/);
    expect(read('components/planner/SeatRequestForm.tsx')).toMatch(/max=\{seasonWindow\?\.to\}/);
  });
});

describe('миграция 1183 — данные решений 08.10', () => {
  const sql = read('migrations/1183_tour_season_windows.sql');

  it('«Край Вулканов» — сезон 01.05–01.10.2027, только где сезона нет', () => {
    expect(sql).toMatch(/season_start = DATE '2027-05-01',\s+season_end\s+= DATE '2027-10-01'/);
    expect(sql).toMatch(/p\.slug = 'volcanoesland'/);
    expect(sql).toMatch(/t\.season_start IS NULL\s+AND t\.season_end IS NULL/);
  });

  it('рыбалка 6 и 9 — сезон 2027 до 30.09, гейт по прежнему значению', () => {
    expect(sql).toMatch(/season_start = DATE '2027-08-25',\s+season_end\s+= DATE '2027-09-30'/);
    expect(sql).toMatch(/ot\.season_start = DATE '2026-08-25'\s+AND ot\.season_end\s+= DATE '2026-10-30'/);
  });

  it('октябрьские даты закрываются, но не те, на которые есть бронь', () => {
    expect(sql).toMatch(/SET is_cancelled = TRUE/);
    expect(sql).toMatch(/NOT EXISTS \(\s+SELECT 1 FROM operator_bookings b/);
    expect(sql).toMatch(/booking_status NOT IN \('cancelled', 'rejected'\)/);
  });
});
