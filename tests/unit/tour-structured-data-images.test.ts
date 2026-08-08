/**
 * Абсолютные URL и чистый текст в JSON-LD туров (проверка прода владельцем
 * 08.08, /catalog/tours/27): в @graph уходили относительные пути картинок
 * («/images/...») — Google требует абсолютные, без них rich results
 * (звёзды + цена) могут не появиться.
 */
import { describe, it, expect } from 'vitest';
import { buildTourStructuredData } from '@/lib/seo/tour-structured-data';

const OPTS = { canonicalUrl: 'https://vedarai.ru/catalog/tours/27', siteUrl: 'https://vedarai.ru', activityLabel: 'Сплав' };

const tour = (over: Record<string, unknown>) => ({
  id: 27,
  title: 'Сплав по реке Быстрая',
  description: '<p>Однодневный <b>семейный</b> сплав.</p>',
  base_price: '13000',
  operator_name: 'Камчатка Семейный Рафтинг',
  location_name: 'Река Быстрая',
  ...over,
});

type Graph = { '@graph': Array<Record<string, unknown>> };

describe('buildTourStructuredData: находки аудита прода 08.08', () => {
  it('относительные пути картинок становятся абсолютными', () => {
    const data = buildTourStructuredData(
      tour({ tour_image: '/images/marketplace/rafting.jpg', photos: ['/images/tours/01.jpg', 'https://cdn.example/x.jpg'] }),
      [], OPTS,
    ) as unknown as Graph;
    const product = data['@graph'][0]!;
    expect(product.image).toEqual([
      'https://vedarai.ru/images/marketplace/rafting.jpg',
      'https://vedarai.ru/images/tours/01.jpg',
      'https://cdn.example/x.jpg',
    ]);
  });

  it('touristType — теги аудитории, локация здесь не живёт (патч 08.08)', () => {
    const data = buildTourStructuredData(tour({ activity_type: 'rafting' }), [], OPTS) as unknown as Graph;
    const trip = data['@graph'][1]!;
    expect(trip.touristType).toEqual(['Сплав', 'Семья', 'Рыбалка']);
    expect(trip.touristType).not.toContain('Река Быстрая');
  });

  it('категорийный сплав семейным не объявляется — «Семья» гейтится сложностью', () => {
    const data = buildTourStructuredData(
      tour({ activity_type: 'rafting', difficulty: 'hard' }), [], OPTS,
    ) as unknown as Graph;
    expect(data['@graph'][1]!.touristType).toEqual(['Сплав', 'Рыбалка']);
  });

  it('описание TouristTrip — чистый текст без HTML, не длиннее 500', () => {
    const data = buildTourStructuredData(
      tour({ description: '<p>' + 'Длинный текст. '.repeat(60) + '</p>' }),
      [], OPTS,
    ) as unknown as Graph;
    const desc = data['@graph'][1]!.description as string;
    expect(desc).not.toContain('<');
    expect(desc.length).toBeLessThanOrEqual(500);
  });
});

describe('itinerary тура — из реальной программы, без выдуманных этапов', () => {
  interface ItineraryNode {
    itinerary?: {
      numberOfItems: number;
      itemListElement: Array<{ position: number; name: string; item: { '@type': string; name: string; description?: string } }>;
    };
  }

  it('точка сбора + этапы программы, по порядку, чистый текст', () => {
    const data = buildTourStructuredData(
      tour({
        meeting_point: 'Парковка у визит-центра, 08:00',
        program: [
          { title: 'Сплав', text: '<b>Три часа</b> по реке с рыбалкой.' },
          { title: 'Обед на берегу', text: 'Уха из свежего улова.' },
        ],
      }),
      [], OPTS,
    ) as unknown as Graph;
    const trip = data['@graph'][1] as ItineraryNode;
    const items = trip.itinerary!.itemListElement;
    expect(trip.itinerary!.numberOfItems).toBe(3);
    expect(items[0]!).toMatchObject({ position: 1, name: 'Место сбора' });
    expect(items[0]!.item['@type']).toBe('Place');
    expect(items[1]!).toMatchObject({ position: 2, name: 'Сплав' });
    expect(items[1]!.item.description).toBe('Три часа по реке с рыбалкой.');
    expect(items[1]!.item['@type']).toBe('TouristAttraction');
  });

  it('нет программы и точки сбора — нет itinerary (заглушек не строим)', () => {
    const data = buildTourStructuredData(tour({}), [], OPTS) as unknown as Graph;
    expect((data['@graph'][1] as ItineraryNode).itinerary).toBeUndefined();
  });

  it('мусор в program не роняет билдер', () => {
    const data = buildTourStructuredData(
      tour({ program: [null, 42, { нет: 'полей' }, { title: '', text: '' }] }),
      [], OPTS,
    ) as unknown as Graph;
    expect((data['@graph'][1] as ItineraryNode).itinerary).toBeUndefined();
  });

  it('geo тура — на ключевых точках (старт/середина/финиш), не на всех (патч 08.08)', () => {
    const program = Array.from({ length: 6 }, (_, i) => ({ title: `Этап ${i + 1}`, text: 'Описание этапа.' }));
    const data = buildTourStructuredData(
      tour({ meeting_point: 'Парковка', program, latitude: '52.87', longitude: '158.7' }),
      [], OPTS,
    ) as unknown as Graph;
    const items = (data['@graph'][1] as ItineraryNode).itinerary!.itemListElement as Array<{ item: { geo?: { latitude: number } } }>;
    // 7 позиций: geo на 1-й (сбор), средней и последней — район тура, реальные координаты
    const withGeo = items.map((x, i) => (x.item.geo ? i : -1)).filter((i) => i >= 0);
    expect(withGeo).toEqual([0, 3, 6]);
    expect(items[0]!.item.geo!.latitude).toBe(52.87);
  });

  it('нет координат тура — нет geo в itinerary (не выдумываем)', () => {
    const data = buildTourStructuredData(
      tour({ meeting_point: 'Парковка', program: [{ title: 'Сплав', text: 'По реке.' }] }),
      [], OPTS,
    ) as unknown as Graph;
    const items = (data['@graph'][1] as ItineraryNode).itinerary!.itemListElement as Array<{ item: { geo?: unknown } }>;
    expect(items.every((x) => x.item.geo === undefined)).toBe(true);
  });
});

describe('itinerary планов — сущности с координатами', () => {
  it('/trip/[token] и /plans/[slug]: item — TouristAttraction с geo дня', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    for (const p of ['app/trip/[token]/page.tsx', 'app/plans/[slug]/page.tsx']) {
      const src = readFileSync(join(process.cwd(), p), 'utf-8');
      expect(src, p).toMatch(/'@type': 'TouristAttraction',\s*\n\s*name: d\.title/);
      expect(src, p).toMatch(/GeoCoordinates', latitude: d\.coords\[0\], longitude: d\.coords\[1\]/);
    }
  });
});
