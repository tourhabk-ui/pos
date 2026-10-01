/**
 * Бронь на сайте самого объекта жилья (решение владельца 29.09, миграция
 * 1109). Бесплатная замена подключению к TravelLine, пока спрос не виден:
 * карточка ведёт туда, где объект сам держит цены и свободные даты.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.hoisted(() => vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>());
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) } }));
vi.mock('@/lib/stay/demand-record', () => ({ recordAgentStaySearch: async () => {} }));

import { searchAccommodationsForKuzmich } from '@/lib/kuzmich/accommodation-search';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const MIG = 'migrations/1109_accommodation_external_booking.sql';

beforeEach(() => { poolQueryMock.mockReset(); });

describe('схема', () => {
  it('ссылка только https — проверкой в базе, а не только формой', () => {
    const sql = read(MIG);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS external_booking_url TEXT/);
    expect(sql).toMatch(/external_booking_url ~ '\^https:\/\//);
  });

  it('«Голубая лагуна»: цена не выдумана, зона планера не угадана (1031)', () => {
    const sql = read(MIG);
    const insert = sql.slice(sql.indexOf('INSERT INTO accommodations'));
    expect(insert).toMatch(/'https:\/\/bluelagoon\.su\/booking'/);
    expect(insert).not.toMatch(/price_per_night_from/);
    expect(insert).not.toMatch(/planner_zone/);
    // Повтор не плодит строк.
    expect(insert).toMatch(/WHERE NOT EXISTS/);
  });
});

describe('API и карточка', () => {
  it('ответ карточки несёт ссылку, цена без числа — null, а не NaN', () => {
    // Карточку собирает общий загрузчик страницы и API (аудит 01.10).
    const src = read('lib/stay/accommodation-detail.ts');
    expect(src).toMatch(/externalBookingUrl: accommodation\.external_booking_url \?\? null/);
    expect(src).toMatch(/from: accommodation\.price_per_night_from != null \? parseFloat/);
  });

  it('правка ссылки — только https, пустое снимает', () => {
    const src = read('app/api/accommodations/[id]/route.ts');
    expect(src).toMatch(/externalBookingUrl: z\.union\(\[/);
    expect(src).toMatch(/externalBookingUrl: \{ column: 'external_booking_url' \}/);
  });

  it('кнопка на карточке ведёт наружу без передачи окна и считается', () => {
    const ui = read('app/accommodations/[id]/_AccommodationDetailClient.tsx');
    expect(ui).toMatch(/href=\{data\.externalBookingUrl\}/);
    expect(ui).toMatch(/rel="noopener noreferrer nofollow"/);
    expect(ui).toMatch(/funnelBeacon\('stay_external_booking', data\.id\)/);
  });

  it('есть ссылка на сайт объекта — она единственный путь брони: ни списка номеров, ни нашей формы', () => {
    const ui = read('app/accommodations/[id]/_AccommodationDetailClient.tsx');
    expect(ui).toMatch(/\{data\.externalBookingUrl \? null : data\.rooms\.length === 0 \?/);
    expect(ui).toMatch(/\{!data\.externalBookingUrl && data\.rooms\.length > 0 && \(/);
    expect(ui).toMatch(/\{!data\.externalBookingUrl && \(\s*<h2 className="ds-h2 mb-4">Номера и цены<\/h2>/);
  });

  it('снятие ссылки не уводит объект на повторную модерацию — только замена одной ссылки на другую', () => {
    const src = read('app/api/accommodations/[id]/route.ts');
    expect(src).toMatch(/moderation_status = 'approved' AND \$\$\{externalUrlIdx\}::text IS NOT NULL AND external_booking_url IS DISTINCT FROM/);
  });

  it('поиск на витрине считается поиском, только если фильтр реально уходит в запрос (пробелы — не фильтр)', () => {
    const ui = read('app/accommodations/_AccommodationsClient.tsx');
    expect(ui).toMatch(/f\.search\.trim\(\) !== ''/);
  });

  it('владелец может указать ссылку в кабинете', () => {
    expect(read('app/hub/stay/accommodations/_AccommodationsClient.tsx')).toMatch(/payload\.externalBookingUrl = form\.externalBookingUrl\.trim\(\)/);
  });
});

describe('Кузьмич и MCP', () => {
  it('объект без цены с бронью на сайте — «цены на сайте объекта» и сама ссылка', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{
      id: 'a1', name: 'Голубая лагуна', type: 'resort', address: 'Озеро Микижа, Паратунка',
      location_zone: 'Паратунка', price_per_night_from: null, rating: null,
      external_booking_url: 'https://bluelagoon.su/booking',
    }] });
    const out = await searchAccommodationsForKuzmich({ zone: 'Паратунка' });
    expect(out).toMatch(/цены и свободные даты — на сайте объекта/);
    expect(out).toMatch(/Бронь на сайте объекта: https:\/\/bluelagoon\.su\/booking/);
    expect(out).not.toMatch(/цена по запросу/);
    expect(poolQueryMock.mock.calls[0]![0]).toMatch(/external_booking_url/);
  });
});
