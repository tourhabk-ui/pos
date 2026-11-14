/**
 * @vitest-environment jsdom
 *
 * Записанный сезон тура кончился, следующего в данных нет (#3347, 14.11).
 *
 * По правилу 08.10 тур без календаря с прошедшим сезоном принимает заявку на
 * любую дату: сезон следующего года знает только оператор. Запрет был бы
 * выдумкой, молчание — тоже: человек выбирает дату, о которой в данных нет ни
 * слова. Здесь держится связка целиком:
 *
 *   - правило строки (`pastSeasonNote`, `formSeasonNote`) — вызовом;
 *   - форма заявки рисует строку в обоих своих видах — рендером;
 *   - страница тура передаёт карточке строку только у тура без календаря —
 *     вызовом страницы;
 *   - перепись `GET /api/cron/tour-season-census` называет такие туры и не
 *     выдаёт «не смог» и «туров нет» за «всё хорошо» — вызовом роута.
 *
 * День плана в планере — tests/unit/planner-season-past.test.ts.
 * Даты — относительно сегодняшнего дня: тест с зашитым годом — бомба.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/62',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('notFound'); },
  permanentRedirect: () => { throw new Error('redirect'); },
}));

import BookingFormClient from '@/components/marketplace/BookingFormClient';
import { formSeasonNote, pastSeasonNote, requestWindow, dateInWindow, longDay } from '@/lib/tours/request-window';
import { buildSeasonCensus, seasonStateOf, type SeasonCensusRow } from '@/lib/tours/season-census';

const YEAR = new Date().getUTCFullYear();
const TODAY = `${YEAR}-11-14`;
const ONE_DAY = { duration_type: null, multi_day_count: null, duration_hours: null };
const WEEK = { duration_type: 'multi_day', multi_day_count: 7, duration_hours: null };
const PAST = { season_start: `${YEAR}-06-01`, season_end: `${YEAR}-09-15` };
const AHEAD = { season_start: `${YEAR + 1}-06-01`, season_end: `${YEAR + 1}-09-15` };
const NOTE = /^Записанный сезон этого тура закончился 15 сентября \d{4}\. Сезон следующего года оператор не объявил — возьмёт ли он на вашу дату, скажет он сам\.$/;

afterEach(() => { cleanup(); });

describe('правило строки', () => {
  it('сезон прошёл — названо, когда он кончился и что следующего в данных нет', () => {
    const note = pastSeasonNote({ ...PAST, ...ONE_DAY }, TODAY);
    expect(note).toMatch(NOTE);
    expect(note).toContain(longDay(PAST.season_end));
    // Запрета при этом нет: правило 08.10 не менялось, дату примут любую.
    expect(dateInWindow(requestWindow({ ...PAST, ...ONE_DAY }, TODAY), `${YEAR + 1}-02-10`)).toBe(true);
  });

  it('сезон идёт, записан вперёд или не записан — строки нет', () => {
    expect(pastSeasonNote({ season_start: `${YEAR}-06-01`, season_end: `${YEAR}-12-31`, ...ONE_DAY }, TODAY)).toBeNull();
    expect(pastSeasonNote({ ...AHEAD, ...ONE_DAY }, TODAY)).toBeNull();
    expect(pastSeasonNote({ season_start: null, season_end: null, ...ONE_DAY }, TODAY)).toBeNull();
  });

  it('сезон ещё идёт, но недельный тур в него уже не помещается — «закончился» не говорим', () => {
    const t = { season_start: `${YEAR}-06-01`, season_end: `${YEAR}-11-16`, ...WEEK };
    const note = pastSeasonNote(t, TODAY)!;
    expect(note).toContain(`До конца записанного сезона этого тура (16 ноября ${YEAR}) поездка уже не успевает.`);
    expect(note).not.toContain('закончился');
    // Однодневный тур в тот же сезон ещё успевает: окно действует, строки нет.
    expect(pastSeasonNote({ ...t, ...ONE_DAY }, TODAY)).toBeNull();
  });

  it('сезон записан короче самого тура — запись сезона неверна, «закончился» по ней не говорим', () => {
    const t = { season_start: `${YEAR - 1}-07-01`, season_end: `${YEAR - 1}-07-03`, ...WEEK };
    expect(requestWindow(t, TODAY)).toEqual({ kind: 'unbounded', why: 'too_short' });
    expect(pastSeasonNote(t, TODAY)).toBeNull();
  });

  it('форма: строка только у тура без календаря; счёт дат не прочитался — молчим', () => {
    expect(formSeasonNote({ ...PAST, ...ONE_DAY }, 0, TODAY)).toMatch(NOTE);
    expect(formSeasonNote({ ...PAST, ...ONE_DAY }, 3, TODAY)).toBeNull();
    expect(formSeasonNote({ ...PAST, ...ONE_DAY }, null, TODAY)).toBeNull();
    expect(formSeasonNote({ ...AHEAD, ...ONE_DAY }, 0, TODAY)).toBeNull();
  });
});

describe('форма заявки рисует строку', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/slots')) return { ok: true, json: async () => ({ success: true, slots: [] }) };
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const TEXT = 'Записанный сезон этого тура закончился 15 сентября 2026. Сезон следующего года оператор не объявил — возьмёт ли он на вашу дату, скажет он сам.';

  it('обычная форма — строка у поля даты', async () => {
    const { container } = render(<BookingFormClient tourId={27} basePrice={13000} seasonNote={TEXT} />);
    await waitFor(() => expect(container.querySelector('[data-season-note]')).not.toBeNull());
    const note = container.querySelector('[data-season-note]')!;
    expect(note.textContent).toBe(TEXT);
    const dateLabel = container.querySelector('label[for="booking-date"]')!;
    expect(dateLabel.parentElement!.contains(note)).toBe(true);
  });

  it('вид «спросить места у оператора» — строка тоже есть', () => {
    const { container } = render(<BookingFormClient tourId={27} basePrice={13000} askSeatsFirst seasonNote={TEXT} />);
    expect(container.querySelector('[data-season-note]')!.textContent).toBe(TEXT);
  });

  it('строки нет — в форме о сезоне ни слова', async () => {
    const { container } = render(<BookingFormClient tourId={27} basePrice={13000} />);
    await waitFor(() => expect(container.querySelector('label[for="booking-date"]')).not.toBeNull());
    expect(container.querySelector('[data-season-note]')).toBeNull();
    expect(container.textContent).not.toContain('оператор не объявил');
  });
});

describe('страница тура передаёт строку карточке', () => {
  const TOUR = {
    id: 62, slug: null, title: 'Восхождение', description: 'Подъём с гидом.', short_description: null,
    base_price: '11000', price_old: null, price_unit: 'person', activity_type: 'volcano', location_type: 'volcano',
    location_name: 'Вулкан', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
    pickup_details: null, cancellation_policy: null, tour_image: null, photos: [], max_participants: 15,
    min_participants: null, duration_hours: '10', duration_type: 'day', multi_day_count: null, difficulty: 'medium',
    included: null, not_included: null, what_to_bring: null,
    seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Оператор',
    operator_id: 'p-1', operator_contacts: null, main_place_id: null,
  };

  async function cardProps(season: { season_start: string | null; season_end: string | null }, dates: { recorded: number; open: number } | null) {
    vi.resetModules();
    vi.doMock('@/lib/tours/tour-detail-query', () => ({
      loadTourCard: async () => ({ tour: { ...TOUR, ...season }, byId: false }),
      getTourReviews: async () => [],
    }));
    vi.doMock('@/lib/tours/open-dates', () => ({ countTourDates: async () => dates, availabilityFromDates: () => undefined }));
    vi.doMock('@/lib/partners/reach', () => ({ reachForTour: async () => null }));
    vi.doMock('@/lib/places/place-tours', () => ({ loadPlaceOffersForTour: async () => null }));
    vi.doMock('@/lib/seo/tour-structured-data', () => ({ buildTourStructuredData: () => ({}) }));
    vi.doMock('@/lib/zh/content', () => ({ zhTourAlternatePath: async () => null }));
    const Card = vi.fn(() => null);
    vi.doMock('@/app/catalog/tours/[id]/_TourDetailClient', () => ({ default: Card }));
    const { default: Page } = await import('@/app/catalog/tours/[id]/page');
    render(await Page({ params: Promise.resolve({ id: '62' }) }));
    expect(Card).toHaveBeenCalled();
    return (Card.mock.calls[0] as unknown as [{ seasonNote: string | null; seasonWindow: unknown }])[0];
  }
  const LAST_YEAR = { season_start: `${YEAR - 1}-06-01`, season_end: `${YEAR - 1}-09-15` };

  it('сезон прошёл, календаря нет — карточка получает строку, окна сезона нет', async () => {
    const props = await cardProps(LAST_YEAR, { recorded: 0, open: 0 });
    expect(props.seasonNote).toBe(`Записанный сезон этого тура закончился 15 сентября ${YEAR - 1}. Сезон следующего года оператор не объявил — возьмёт ли он на вашу дату, скажет он сам.`);
    expect(props.seasonWindow).toBeNull();
  });

  it('у тура есть календарь или счёт дат не прочитался — строки нет', async () => {
    expect((await cardProps(LAST_YEAR, { recorded: 4, open: 2 })).seasonNote).toBeNull();
    expect((await cardProps(LAST_YEAR, null)).seasonNote).toBeNull();
  });

  it('сезон записан на следующий год — действует окно, строки нет', async () => {
    const props = await cardProps({ season_start: `${YEAR + 1}-06-01`, season_end: `${YEAR + 1}-09-15` }, { recorded: 0, open: 0 });
    expect(props.seasonNote).toBeNull();
    expect(props.seasonWindow).not.toBeNull();
  });
});

describe('перепись сезонов', () => {
  const row = (id: string, over: Partial<SeasonCensusRow>): SeasonCensusRow => ({
    id, title: `Тур ${id}`, activity_type: 'volcano', partner_name: 'Компания',
    season_start: null, season_end: null, duration_type: null, multi_day_count: null, duration_hours: null,
    keeps_schedule: false, ...over,
  });
  const ROWS: SeasonCensusRow[] = [
    row('1', { ...PAST }),
    row('2', { ...PAST, keeps_schedule: true }),
    row('3', { ...AHEAD }),
    row('4', {}),
    row('5', { season_start: `${YEAR}-06-01`, season_end: `${YEAR}-12-31` }),
    row('6', { season_start: `${YEAR + 1}-07-01`, season_end: `${YEAR + 1}-07-03`, duration_type: 'multi_day', multi_day_count: '7' }),
  ];

  it('состояние сезона — пять разных ответов', () => {
    const state = (t: Parameters<typeof requestWindow>[0]) => seasonStateOf(requestWindow(t, TODAY), TODAY);
    expect(state({ ...PAST, ...ONE_DAY })).toBe('past');
    expect(state({ ...AHEAD, ...ONE_DAY })).toBe('ahead');
    expect(state({ season_start: `${YEAR}-06-01`, season_end: `${YEAR}-12-31`, ...ONE_DAY })).toBe('running');
    expect(state({ season_start: null, season_end: null, ...ONE_DAY })).toBe('not_recorded');
    expect(state({ season_start: `${YEAR + 1}-07-01`, season_end: `${YEAR + 1}-07-03`, ...WEEK })).toBe('too_short');
  });

  it('называет туры без календаря, которые принимают любую дату; тур с календарём в них не идёт', () => {
    const c = buildSeasonCensus(ROWS, TODAY);
    expect(c.tours_total).toBe(6);
    expect(c.with_calendar).toBe(1);
    expect(c.without_calendar).toBe(5);
    expect(c.without_calendar_by_state).toEqual({ running: 1, ahead: 1, past: 1, not_recorded: 1, too_short: 1 });
    expect(c.accepts_any_date_total).toBe(3);
    expect(c.accepts_any_date.map((t) => [t.id, t.state])).toEqual([['1', 'past'], ['4', 'not_recorded'], ['6', 'too_short']]);
    expect(c.verdict).toContain('Заявку на любую дату принимают 3: сезон прошёл — 1, сезон не записан — 1, сезон короче тура — 1.');
    expect(c.verdict).toContain('перепись его не выводит');
  });

  it('нет таких туров — сказано прямо; нет туров вовсе — это не «всё хорошо»', () => {
    const fine = buildSeasonCensus([ROWS[1]!, ROWS[2]!, ROWS[4]!], TODAY);
    expect(fine.accepts_any_date_total).toBe(0);
    expect(fine.verdict).toContain('не принимает ни один');
    const empty = buildSeasonCensus([], TODAY);
    expect(empty.tours_total).toBe(0);
    expect(empty.verdict).toContain('судить не о чем');
  });

  describe('роут', () => {
    const SECRET = 'probe-secret-for-test';
    const get = (secret?: string) => new NextRequest('http://localhost/api/cron/tour-season-census', {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
    let saved: string | undefined;
    beforeEach(() => { saved = process.env.CRON_SECRET; process.env.CRON_SECRET = SECRET; query.mockReset(); });
    afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });
    const route = async () => (await import('@/app/api/cron/tour-season-census/route')).GET;

    it('без секрета и с чужим — 401, база не спрошена', async () => {
      const GET = await route();
      expect((await GET(get())).status).toBe(401);
      expect((await GET(get('wrong-secret'))).status).toBe(401);
      expect(query).not.toHaveBeenCalled();
    });

    it('читает одним запросом и ничего не пишет; в ответе туры и вывод словами', async () => {
      query.mockResolvedValueOnce({ rows: [
        row('1', { season_start: `${YEAR - 1}-06-01`, season_end: `${YEAR - 1}-09-15` }),
        row('2', { season_start: `${YEAR - 1}-06-01`, season_end: `${YEAR - 1}-09-15`, keeps_schedule: true }),
      ] });
      const res = await (await route())(get(SECRET));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.accepts_any_date_total).toBe(1);
      expect(body.accepts_any_date[0]).toMatchObject({ id: '1', state: 'past', partner: 'Компания' });
      expect(query).toHaveBeenCalledTimes(1);
      const sql = String(query.mock.calls[0]![0]);
      expect(sql).toMatch(/^\s*SELECT/);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    });

    it('живых туров нет — отказ, а не «таких туров нет»', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      const res = await (await route())(get(SECRET));
      expect(res.status).toBe(500);
      expect((await res.json()).ok).toBe(false);
    });

    it('база не ответила — 500 с SQLSTATE, не пустая перепись', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      query.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '42703' }));
      const res = await (await route())(get(SECRET));
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ ok: false, sqlstate: '42703' });
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });
  });
});
