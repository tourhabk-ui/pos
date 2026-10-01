/**
 * Карточка жилья отдаётся сервером (аудит vedarai.ru 01.10).
 *
 * Прежде /accommodations/[id] была оболочкой: всё содержимое клиент тянул из
 * API в браузере, и поисковик видел 19 слов без заголовка — единственная
 * опубликованная карточка жилья стояла в карте сайта пустой. Теперь страница
 * и GET читают один загрузчик lib/stay/accommodation-detail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

import { loadAccommodationDetail } from '@/lib/stay/accommodation-detail';

const ROOT = process.cwd();
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ID = '0b5a2c1e-1111-4222-8333-944455556666';

beforeEach(() => {
  queryMock.mockReset();
});

describe('страница и API читают один загрузчик', () => {
  it('страница: данные с сервера, нет объекта — 404', () => {
    const page = code('app/accommodations/[id]/page.tsx');
    expect(page).toMatch(/initialData = await loadAccommodationDetail\(id\)/);
    expect(page).toMatch(/if \(!initialData\) notFound\(\)/);
    expect(page).toMatch(/initialData=\{initialData\}/);
  });

  it('клиент с данными сервера за ними не ходит', () => {
    const client = code('app/accommodations/[id]/_AccommodationDetailClient.tsx');
    expect(client).toMatch(/useState<AccommodationDetail \| null>\(initialData \?\? null\)/);
    expect(client).toMatch(/if \(initialData\) return;/);
  });

  it('GET отдаёт загрузчик, отказ — в лог', () => {
    const route = code('app/api/accommodations/[id]/route.ts');
    expect(route).toMatch(/const data = await loadAccommodationDetail\(id\)/);
    expect(route).toMatch(/console\.error\('\[api\/accommodations\/\[id\]\] карточка не прочитана:'/);
    expect(route).not.toMatch(/details: error instanceof Error \? error\.message/);
  });
});

describe('загрузчик карточки', () => {
  it('не uuid — null без запроса в базу', async () => {
    expect(await loadAccommodationDetail('not-a-uuid')).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('нет объекта на витрине — null', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await loadAccommodationDetail(ID)).toBeNull();
    expect(String(queryMock.mock.calls[0][0])).toContain("a.moderation_status = 'approved'");
  });

  it('карточка: оценки без отзывов нет, цена без числа — null, даты строкой', async () => {
    const created = new Date('2026-09-01T10:00:00Z');
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodations a\n    LEFT JOIN partners')) {
        return Promise.resolve({ rows: [{
          id: ID, name: 'Голубая лагуна', type: 'resort', description: 'СПА-отель', short_description: 'СПА',
          address: 'Паратунка', coordinates: null, location_zone: 'paratunka', star_rating: null,
          total_rooms: null, check_in_time: '14:00:00', check_out_time: '12:00:00',
          price_per_night_from: null, price_per_night_to: null, currency: 'RUB',
          external_booking_url: 'https://example.ru/book', amenities: null, languages: null,
          rating: '0.0', review_count: 0, is_verified: true, partner_name: null, partner_email: null,
          partner_phone: null, images: null, created_at: created, updated_at: created,
        }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const d = await loadAccommodationDetail(ID);
    expect(d).not.toBeNull();
    expect(d!.name).toBe('Голубая лагуна');
    expect(d!.rating).toBeNull();
    expect(d!.pricePerNight.from).toBeNull();
    expect(d!.externalBookingUrl).toBe('https://example.ru/book');
    expect(d!.amenities).toEqual([]);
    expect(d!.images).toEqual([]);
    expect(d!.createdAt).toBe('2026-09-01T10:00:00.000Z');
  });
});
