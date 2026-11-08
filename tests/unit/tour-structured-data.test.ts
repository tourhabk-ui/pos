/**
 * JSON-LD туров: @graph с Product (под rich-сниппет Google) + TouristTrip.
 * Продукт обязан нести offers, а rating/review — только когда они есть
 * (иначе Google ругается на пустой AggregateRating).
 */
import { describe, it, expect } from 'vitest';
import { buildTourStructuredData, type TourSeoInput } from '@/lib/seo/tour-structured-data';

const base: TourSeoInput = {
  id: 7,
  title: 'Восхождение на Горелый',
  description: '<p>Однодневный трек к кратеру.</p>',
  base_price: '12500',
  operator_name: 'Камчатка-Тур',
  activity_type: 'trekking',
  tour_image: '/img/gorely.jpg',
  location_name: 'Мутновский район',
  latitude: 52.5, longitude: 158.0,
};
const opts = { canonicalUrl: 'https://vedarai.ru/catalog/tours/7', siteUrl: 'https://vedarai.ru', activityLabel: 'Треккинг', availability: null };

function nodes(g: Record<string, unknown>) {
  return (g['@graph'] as Array<Record<string, unknown>>);
}

describe('buildTourStructuredData', () => {
  it('@graph содержит Product и TouristTrip', () => {
    const g = buildTourStructuredData(base, [], opts);
    const types = nodes(g).map(n => n['@type']);
    expect(types).toContain('Product');
    expect(types).toContain('TouristTrip');
  });

  it('@graph содержит BreadcrumbList (Главная → Туры → активность → тур)', () => {
    const bc = nodes(buildTourStructuredData(base, [], opts)).find(n => n['@type'] === 'BreadcrumbList');
    expect(bc).toBeTruthy();
    const items = bc!.itemListElement as Array<Record<string, unknown>>;
    expect(items[0].name).toBe('Главная');
    expect(items[items.length - 1].name).toBe(base.title);
    expect(items[items.length - 1].item).toBe(opts.canonicalUrl);
  });

  it('Product несёт offers с ценой и валютой', () => {
    const product = nodes(buildTourStructuredData(base, [], opts)).find(n => n['@type'] === 'Product')!;
    const offer = product.offers as Record<string, unknown>;
    expect(offer.price).toBe(12500);
    expect(offer.priceCurrency).toBe('RUB');
    expect(offer.url).toBe(opts.canonicalUrl);
  });

  it('без рейтинга — нет aggregateRating (не шлём пустой)', () => {
    const product = nodes(buildTourStructuredData(base, [], opts)).find(n => n['@type'] === 'Product')!;
    expect(product.aggregateRating).toBeUndefined();
  });

  it('с рейтингом и отзывами — aggregateRating + review в Product', () => {
    const g = buildTourStructuredData(
      { ...base, rating: 4.8, review_count: 12 },
      [{ author_name: 'Иван', author_city: 'Москва', rating: 5, comment: 'Топ', trip_date: '2026-07-01' }],
      opts,
    );
    const product = nodes(g).find(n => n['@type'] === 'Product')!;
    const ar = product.aggregateRating as Record<string, unknown>;
    expect(ar.ratingValue).toBe(4.8);
    expect(ar.reviewCount).toBe(12);
    expect((product.review as unknown[]).length).toBe(1);
  });

  it('описание в Product без HTML-тегов', () => {
    const product = nodes(buildTourStructuredData(base, [], opts)).find(n => n['@type'] === 'Product')!;
    expect(String(product.description)).not.toMatch(/<[^>]+>/);
  });

  it('сезон → availabilityStarts/Ends в offer — датами из базы (08.11)', () => {
    const g = buildTourStructuredData(
      { ...base, season_start: '2027-06-01', season_end: '2027-09-15' }, [], { ...opts, today: '2026-11-08' },
    );
    const product = nodes(g).find(n => n['@type'] === 'Product')!;
    const offer = product.offers as Record<string, string>;
    expect(offer.availabilityStarts).toBe('2027-06-01');
    expect(offer.availabilityEnds).toBe('2027-09-15');
  });
});

/**
 * Регрессия 2026-08-04: карточка тура отдавала «Ошибка загрузки тура».
 *
 * `operator_tours.season_start` — колонка типа DATE, а node-postgres отдаёт DATE
 * ОБЪЕКТОМ `Date`, не строкой. Разбор сезона звал на нём `.trim()` и бросал
 * TypeError — падала вся страница тура, а не один блок разметки.
 *
 * Отдельно проверяем сам смысл: раньше тип обещал номер месяца, строка-дата
 * приезжала молча, и в разметку для поисковиков уходило «2026-2026-06-01-01».
 */
describe('сезон из базы не роняет страницу', () => {
  const seasonOffer = (start: unknown, end: unknown) => {
    const g = buildTourStructuredData(
      { ...base, season_start: start as never, season_end: end as never },
      [],
      { ...opts, today: '2026-11-08' },
    );
    const product = nodes(g).find(n => n['@type'] === 'Product')!;
    return product.offers as Record<string, string>;
  };

  it('Date из pg (локальная полночь) разбирается, а не бросает исключение', () => {
    const offer = seasonOffer(new Date(2027, 5, 1), new Date(2027, 8, 30));
    expect(offer.availabilityStarts).toBe('2027-06-01');
    expect(offer.availabilityEnds).toBe('2027-09-30');
  });

  it('строка-дата уходит датой, а не мусором вида 2026-2026-06-01-01 и не днями 1 и 28', () => {
    const offer = seasonOffer('2027-06-01', '2027-09-30');
    expect(offer.availabilityStarts).toBe('2027-06-01');
    expect(offer.availabilityEnds).toBe('2027-09-30');
  });

  it('мусор и битая дата просто убирают блок сезона, не роняя разметку', () => {
    for (const bad of ['', '   ', 'не дата', new Date('нет'), {}, [], true]) {
      expect(() => seasonOffer(bad, bad)).not.toThrow();
      expect(seasonOffer(bad, bad).availabilityStarts).toBeUndefined();
    }
  });
});
