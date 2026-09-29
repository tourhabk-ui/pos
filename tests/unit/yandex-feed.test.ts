/**
 * Фид Яндекса: картинки — абсолютные URL.
 *
 * prod-check run 12 (05.09): первый открытый ответ фида нёс
 * <picture>/images/fishingkam/...</picture>. Яндекс скачивает картинку сам, и
 * относительный путь для него — ничего: у всех восьми туров ни одного снимка,
 * который витрина смогла бы забрать. У Авито то же правило стояло с самого
 * начала (absoluteUrl) — теперь оно одно на оба фида.
 */
import { describe, it, expect } from 'vitest';
import { generateYandexYmlFeed, formatSeason, seasonEnded } from '@/lib/channels/yandex';
import type { ChannelTour } from '@/lib/channels/types';

const tour: ChannelTour = {
  id: 27,
  title: 'Сплав по реке Быстрая',
  description: 'Спокойный семейный маршрут.',
  short_description: 'Однодневный сплав с ухой из лосося.',
  activity_type: 'rafting',
  location_name: 'Река Быстрая',
  latitude: 53.1,
  longitude: 157.9,
  base_price: 13000,
  max_participants: 12,
  duration_hours: 10,
  difficulty: 'easy',
  photos: ['/images/tours/bystraya-rafting/01.jpg', 'https://cdn.example.org/02.jpg'],
  included: ['Удочки и снасти для рыбалки'],
  season_start: null,
  season_end: null,
  operator_name: 'Камчатка Рафтинг',
  operator_phone: '+7 900 000-00-00',
  tripster_experience_id: null,
  avito_listing_id: null,
  sputnik8_product_id: null,
};

describe('YML-фид Яндекса', () => {
  const xml = generateYandexYmlFeed([tour]);

  it('относительный путь картинки становится абсолютным', () => {
    expect(xml).toMatch(/<picture>https:\/\/[^<]+\/images\/tours\/bystraya-rafting\/01\.jpg<\/picture>/);
    expect(xml).not.toMatch(/<picture>\/images/);
  });

  it('уже абсолютная ссылка не переписывается', () => {
    expect(xml).toContain('<picture>https://cdn.example.org/02.jpg</picture>');
  });

  it('ссылка на карточку — публичный каталог', () => {
    expect(xml).toMatch(/<url>https:\/\/[^<]+\/catalog\/tours\/27<\/url>/);
  });
});

/**
 * Сезон — колонки DATE, а не номер месяца (аудит SEO 29.09, Н8): до починки в
 * ленту уходило «Сезон: 2026-06-01 — 2026-09-15», а тур с прошедшим сезоном
 * стоял с available="true".
 */
describe('YML-фид Яндекса: сезон', () => {
  it('ISO-даты становятся словами', () => {
    expect(formatSeason('2026-06-01', '2026-09-15')).toBe('1 июня — 15 сентября 2026');
    expect(formatSeason('2026-11-15', '2027-01-15')).toBe('15 ноября 2026 — 15 января 2027');
  });
  it('номер месяца старых импортов по-прежнему понимается', () => {
    expect(formatSeason('6', '9')).toBe('июнь — сентябрь');
  });
  it('нет сезона — круглый год', () => {
    expect(formatSeason(null, null)).toBe('круглый год');
  });
  it('сырой ISO-даты в ленте нет', () => {
    const xml = generateYandexYmlFeed([{ ...tour, season_start: '2099-06-01', season_end: '2099-09-15' }]);
    expect(xml).not.toMatch(/Сезон[^<]*\d{4}-\d{2}-\d{2}/);
    expect(xml).toContain('<param name="Сезон">1 июня — 15 сентября 2099</param>');
    expect(xml).toContain('available="true"');
  });
  it('прошедший сезон — предложение недоступно', () => {
    expect(seasonEnded('2026-09-15', '2026-09-29')).toBe(true);
    expect(seasonEnded('2026-09-29', '2026-09-29')).toBe(false);
    expect(seasonEnded(null, '2026-09-29')).toBe(false);
    const xml = generateYandexYmlFeed([{ ...tour, season_start: '2020-06-01', season_end: '2020-09-15' }]);
    expect(xml).toContain('available="false"');
  });
  it('производитель — оператор, магазин — Ведар, а не старый бренд', () => {
    const xml = generateYandexYmlFeed([tour]);
    expect(xml).toContain('<vendor>Камчатка Рафтинг</vendor>');
    expect(xml).toContain('<company>Ведар</company>');
    expect(xml).not.toContain('KamchatourHub');
  });
});
