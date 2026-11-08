/**
 * Сезон тура: настоящие даты из базы, подпись с днями и годом (08.11).
 *
 * Обход прода 08.11 (SEO, пункт 2 плана владельца): у всех 29 туров с сезоном
 * разметка поисковиков несла ТЕКУЩИЙ год и дни 1 и 28 вместо дат из базы.
 * Тур с сезоном 19.07–29.09.2027 уходил как «01.07–28.09.2026» — для
 * поисковика предложение кончилось; у зимней рыбалки 15.11.2026–15.01.2027
 * конец стоял раньше начала. Карточка писала «Июл — Сен» без года, и три
 * тура с прошедшим сезоном 2026 выглядели как туры сезона 2027.
 *
 * Правило одно — lib/tours/season; судится вызовом: функции, разметка тура
 * (buildTourStructuredData) и строка фида Яндекса.
 */
import { describe, it, expect } from 'vitest';
import { seasonDates, seasonLabel, seasonAhead } from '@/lib/tours/season';
import { buildTourStructuredData } from '@/lib/seo/tour-structured-data';
import { generateYandexYmlFeed } from '@/lib/channels/yandex';
import type { ChannelTour } from '@/lib/channels/types';

describe('seasonDates: даты как в базе', () => {
  it('строка DATE и ISO с временем дают день без сдвига', () => {
    expect(seasonDates('2027-07-19', '2027-09-29')).toEqual({ start: '2027-07-19', end: '2027-09-29' });
    expect(seasonDates('2026-11-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z'))
      .toEqual({ start: '2026-11-15', end: '2027-01-15' });
  });

  it('Date из node-postgres (локальная полночь) читается локальными полями', () => {
    expect(seasonDates(new Date(2027, 6, 19), new Date(2027, 8, 29)))
      .toEqual({ start: '2027-07-19', end: '2027-09-29' });
  });

  it('чего нет в данных, того нет: месяц без года, битая дата, конец раньше начала', () => {
    for (const [a, b] of [
      [6, 9], ['6', '9'], [null, '2027-09-29'], ['2027-07-19', null], ['', ''],
      ['не дата', 'не дата'], ['2027-02-30', '2027-03-10'], [new Date('нет'), new Date('нет')],
      ['2027-09-29', '2027-07-19'], [{}, []],
    ] as Array<[unknown, unknown]>) {
      expect(seasonDates(a, b), `${String(a)} — ${String(b)}`).toBeNull();
      expect(seasonLabel(a, b)).toBeNull();
    }
  });

  it('seasonAhead: сезон идёт или впереди — да; кончился — нет; последний день — ещё да', () => {
    const s = { start: '2027-07-19', end: '2027-09-29' };
    expect(seasonAhead(s, '2026-11-08')).toBe(true);
    expect(seasonAhead(s, '2027-09-29')).toBe(true);
    expect(seasonAhead(s, '2027-09-30')).toBe(false);
  });
});

describe('seasonLabel: день, месяц и год', () => {
  it('в пределах года — год один раз в конце', () => {
    expect(seasonLabel('2027-07-19', '2027-09-29')).toBe('19 июл — 29 сен 2027');
  });

  it('через новый год — год у каждой границы', () => {
    expect(seasonLabel('2026-11-15', '2027-01-15')).toBe('15 ноя 2026 — 15 янв 2027');
  });

  it('прошедший сезон называет свой год, а не выглядит как будущий', () => {
    expect(seasonLabel('2026-06-01', '2026-09-15')).toBe('1 июн — 15 сен 2026');
  });
});

describe('разметка поисковиков (buildTourStructuredData): сезон датами из базы', () => {
  const base = {
    id: 79, title: 'Курильское озеро на внедорожнике, 3 дня', description: 'Три дня к Курильскому озеру.',
    base_price: 95000, operator_name: 'Андрей Запорожец',
  };
  const opts = {
    canonicalUrl: 'https://vedarai.ru/catalog/tours/zaporozhets-kurilskoe-ozero-3-dnya',
    siteUrl: 'https://vedarai.ru', activityLabel: 'Джип-тур', availability: null, today: '2026-11-08',
  };
  const offerOf = (season_start: unknown, season_end: unknown, today = '2026-11-08') => {
    const g = buildTourStructuredData(
      { ...base, season_start: season_start as never, season_end: season_end as never }, [], { ...opts, today },
    ) as { '@graph': Array<Record<string, unknown>> };
    const product = g['@graph'].find((n) => n['@type'] === 'Product')!;
    return product.offers as Record<string, string>;
  };

  it('сезон 2027 уходит датами 2027, а не текущим годом с днями 1 и 28', () => {
    const offer = offerOf('2027-07-19', '2027-09-29');
    expect(offer.availabilityStarts).toBe('2027-07-19');
    expect(offer.availabilityEnds).toBe('2027-09-29');
  });

  it('сезон через новый год: конец позже начала', () => {
    const offer = offerOf(new Date(2026, 10, 15), new Date(2027, 0, 15));
    expect(offer.availabilityStarts).toBe('2026-11-15');
    expect(offer.availabilityEnds).toBe('2027-01-15');
  });

  it('сезон кончился — дат нет: прошедшие объявлять незачем, будущих мы не знаем', () => {
    const offer = offerOf('2026-06-01', '2026-09-15');
    expect(offer.availabilityStarts).toBeUndefined();
    expect(offer.availabilityEnds).toBeUndefined();
  });

  it('месяц без года и мусор — без дат, страница не падает', () => {
    for (const bad of [6, '', 'не дата', new Date('нет'), {}, [], true]) {
      expect(() => offerOf(bad, bad)).not.toThrow();
      expect(offerOf(bad, bad).availabilityStarts).toBeUndefined();
    }
  });
});

describe('фид Яндекса: одна граница сезона — не «круглый год»', () => {
  const tour: ChannelTour = {
    id: 36, title: 'Зимняя рыбалка', description: 'Подлёдная рыбалка.', short_description: null,
    activity_type: 'fishing', location_name: null, latitude: null, longitude: null, base_price: 22000,
    max_participants: 10, duration_hours: 24, difficulty: 'easy', photos: [], included: [],
    season_start: '2026-11-15', season_end: null, operator_name: 'Тест', operator_phone: '+70000000000',
    tripster_experience_id: null, avito_listing_id: null, sputnik8_product_id: null,
  };

  it('конец сезона не записан — сезона в фиде нет вовсе', () => {
    const xml = generateYandexYmlFeed([tour]);
    expect(xml).not.toMatch(/круглый год/);
    expect(xml).not.toMatch(/name="Сезон"/);
  });

  it('обе границы записаны — сезон датами', () => {
    const xml = generateYandexYmlFeed([{ ...tour, season_end: '2027-01-15' }]);
    expect(xml).toContain('<param name="Сезон">15 ноября 2026 — 15 января 2027</param>');
  });
});
