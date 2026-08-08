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

  it('touristType — массив: активность + локация, без выдуманных ярлыков', () => {
    const data = buildTourStructuredData(tour({}), [], OPTS) as unknown as Graph;
    const trip = data['@graph'][1]!;
    expect(trip.touristType).toEqual(['Сплав', 'Река Быстрая']);
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
