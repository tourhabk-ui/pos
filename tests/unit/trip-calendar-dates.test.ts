// @vitest-environment node
/**
 * Путь человека 07.11 через планировщик (проверен один сценарий на проде).
 *
 * 1. В конструкторе 10–14 июля, на странице сохранённого маршрута — «9 июля —
 *    13 июля», а заголовок «Маршрут 2027-07-10». node-pg отдаёт колонку DATE
 *    как Date на полночь пояса сервера, JSON — как UTC-момент, а страница
 *    переводила его в пояс браузера.
 * 2. Ссылка «оставить заявку» из дня плана открывала форму тура с одним
 *    участником и без даты, хотя план был на двоих и на 11 июля.
 *
 * Сторож держит поведение: роут отдаёт календарный день строкой, страница
 * показывает тот же день в любом поясе, ссылка несёт дату дня и всю группу.
 * Страница по ссылке «поделиться», её GPX и режим поездки читают даты тем же
 * правилом (там DATE печатался UTC-моментом «2027-07-10T00:00:00.000Z»).
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// DATE из node-pg — Date на местной полуночи процесса.
const ROW = {
  id: 'trip-1', user_id: 'u1', title: 'Маршрут 2027-07-10',
  arrival_date: new Date(2027, 6, 10), departure_date: new Date(2027, 6, 14),
  places: [], activities: [], days: [], days_count: 0,
};
vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn(async () => ({ rows: [ROW] })) },
}));
vi.mock('@/lib/auth/middleware', () => ({ requireAuth: async () => ({ userId: 'u1' }) }));
vi.mock('@/lib/mcp/handoff', () => ({ attachMcpAttribution: async () => {}, MCP_ATTRIBUTION: { cookieName: 'x' } }));

import type { Mock } from 'vitest';
import { pool } from '@/lib/db-pool';
import { GET as getTrip } from '@/app/api/trips/[id]/route';
import { GET as listTrips } from '@/app/api/trips/route';
import { GET as tripGpx } from '@/app/api/trips/[id]/gpx/route';
import { GET as activeTrip } from '@/app/api/trips/active/route';
import { readSharedPlan } from '@/lib/trips/shared-plan';
import { calendarDay, ruCalendarDate, withCalendarDates } from '@/lib/trips/trip-dates';
import { planDayDate, planDayTourHref } from '@/lib/planner/day-tour-link';

const TRIP_ID = '11111111-1111-4111-8111-111111111111';

describe('даты сохранённой поездки — календарные дни (07.11)', () => {
  it('роут поездки отдаёт день строкой, а не UTC-момент полуночи сервера', async () => {
    const res = await getTrip(new NextRequest(`https://vedarai.ru/api/trips/${TRIP_ID}`), { params: Promise.resolve({ id: TRIP_ID }) });
    const body = await res.json() as { data: { arrival_date: string; departure_date: string } };
    expect(body.data.arrival_date).toBe('2027-07-10');
    expect(body.data.departure_date).toBe('2027-07-14');
  });

  it('список поездок — тоже', async () => {
    const res = await listTrips(new NextRequest('https://vedarai.ru/api/trips'));
    const body = await res.json() as { data: Array<{ arrival_date: string }> };
    expect(body.data[0]?.arrival_date).toBe('2027-07-10');
  });

  it('страница показывает тот же день в любом поясе браузера', () => {
    expect(ruCalendarDate('2027-07-10')).toBe('10 июля 2027 г.');
    expect(ruCalendarDate('2027-07-14', 'short')).toMatch(/^14 июл/);
    expect(ruCalendarDate(null)).toBe('');
  });

  it('страница по ссылке «поделиться» получает день строкой, а не UTC-момент', async () => {
    const read = await readSharedPlan(TRIP_ID);
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') return;
    expect(read.plan.arrival_date).toBe('2027-07-10');
    expect(read.plan.departure_date).toBe('2027-07-14');
  });

  it('GPX своей поездки датирует день 2 11 июля', async () => {
    (pool.query as unknown as Mock).mockResolvedValueOnce({ rows: [{
      ...ROW,
      days: [
        { day: 1, title: 'Прилёт', coords: [53.02, 158.65] },
        { day: 2, title: 'Вулкан Горелый', coords: [52.56, 158.03] },
      ],
    }] });
    const res = await tripGpx(new NextRequest(`https://vedarai.ru/api/trips/${TRIP_ID}/gpx`), { params: Promise.resolve({ id: TRIP_ID }) });
    const gpx = await res.text();
    expect(gpx).toContain('<desc>2027-07-10</desc>');
    expect(gpx).toContain('<desc>2027-07-11</desc>');
  });

  it('режим поездки считает от того же календарного дня', async () => {
    const res = await activeTrip(new NextRequest('https://vedarai.ru/api/trips/active'));
    const body = await res.json() as { data: { arrivalDate: string; departureDate: string } };
    expect(body.data.arrivalDate).toBe('2027-07-10');
    expect(body.data.departureDate).toBe('2027-07-14');
  });

  it('день из Date — по местным частям, строка — первые десять знаков, иное — null', () => {
    expect(calendarDay(new Date(2027, 6, 10))).toBe('2027-07-10');
    expect(calendarDay('2027-07-10T00:00:00.000Z')).toBe('2027-07-10');
    expect(calendarDay(42)).toBeNull();
    expect(withCalendarDates({ arrival_date: null, departure_date: undefined })).toEqual({ arrival_date: null, departure_date: null });
  });
});

describe('из дня плана в форму тура — дата дня и вся группа (07.11)', () => {
  const GORELY = { id: 7, slug: 'zaporozhets-vulkan-gorelyy' };

  it('день 2 поездки с 10 июля на двоих — форма с 11 июля и двумя участниками', () => {
    expect(planDayTourHref(GORELY, '2027-07-10', 1, 2))
      .toBe('/catalog/tours/zaporozhets-vulkan-gorelyy?date=2027-07-11&guests=2#booking');
  });

  it('чего не знаем, не подставляем: без прилёта — без даты, без группы — без числа', () => {
    expect(planDayTourHref(GORELY, '', 1, 2)).toBe('/catalog/tours/zaporozhets-vulkan-gorelyy?guests=2#booking');
    expect(planDayTourHref(GORELY, '2027-07-10', 0, 0)).toBe('/catalog/tours/zaporozhets-vulkan-gorelyy?date=2027-07-10#booking');
  });

  it('дата дня считается по календарю, а не по поясу: конец месяца и года', () => {
    expect(planDayDate('2027-07-31', 1)).toBe('2027-08-01');
    expect(planDayDate('2027-12-31', 1)).toBe('2028-01-01');
    expect(planDayDate('не дата', 1)).toBe('');
  });
});
