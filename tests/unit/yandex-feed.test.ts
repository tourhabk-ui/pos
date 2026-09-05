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
import { generateYandexYmlFeed } from '@/lib/channels/yandex';
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
