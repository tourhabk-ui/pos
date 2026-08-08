/**
 * Фид Авито ведёт на живую страницу и в верную категорию.
 *
 * Решение владельца 05.08: из площадок начинаем с Авито — там порог ниже всего,
 * договор с площадкой не нужен, автозагрузка идёт по URL.
 *
 * Разбор перед подачей нашёл три вещи, каждая из которых обнулила бы затею:
 *  · ссылка в описании вела на `/hub/tour/{id}` — такого маршрута нет, а
 *    `/hub/*` вдобавок под авторизацией и закрыт в robots. Весь трафик с
 *    площадки терялся бы на входе, ради этого перехода объявление и даётся;
 *  · фотографии шли относительными путями — Авито скачивает картинку сам и
 *    такой путь не понимает: объявления ушли бы без единого снимка;
 *  · категория «Охота и рыбалка» была зашита для ВСЕХ туров. Сплав по Быстрой —
 *    не рыбалка, а объявление не в своей категории Авито снимает с публикации.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateAvitoXmlFeed,
  avitoCategory,
  absoluteUrl,
  tourPublicUrl,
  durationLabel,
  AVITO_CATEGORY_BY_ACTIVITY,
} from '@/lib/channels/avito';
import type { ChannelTour } from '@/lib/channels/types';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const ROUTE = read('app/api/channels/avito/feed/route.ts');

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
  photos: ['/images/tours/bystraya-rafting/01.jpg'],
  included: ['Удочки и снасти для рыбалки'],
  season_start: null,
  season_end: null,
  operator_name: 'Камчатка Рафтинг',
  operator_phone: '+7 900 000-00-00',
  tripster_experience_id: null,
  avito_listing_id: null,
  sputnik8_product_id: null,
};

describe('ссылка ведёт на живую публичную карточку', () => {
  it('это канонический /catalog/tours/{id}, а не несуществующий /hub/tour', () => {
    expect(tourPublicUrl(27)).toMatch(/\/catalog\/tours\/27$/);
    expect(tourPublicUrl(27)).not.toMatch(/\/hub\//);
  });

  it('в описании объявления стоит именно она', () => {
    const xml = generateAvitoXmlFeed([tour]);
    expect(xml).toContain('/catalog/tours/27');
    expect(xml).not.toContain('/hub/tour/');
  });
});

describe('фотографии абсолютные — иначе Авито их не скачает', () => {
  it('относительный путь превращается в полный URL', () => {
    expect(absoluteUrl('/images/a.jpg')).toMatch(/^https?:\/\/.+\/images\/a\.jpg$/);
  });

  it('внешние ссылки не переписываются', () => {
    expect(absoluteUrl('https://cdn.example/a.jpg')).toBe('https://cdn.example/a.jpg');
  });

  it('в фиде картинка идёт абсолютной', () => {
    const xml = generateAvitoXmlFeed([tour]);
    expect(xml).toMatch(/<Image url="https?:\/\/[^"]+\/images\//);
  });
});

describe('категория — по типу активности, а не одна на всех', () => {
  it('сплав не выдаётся за рыбалку', () => {
    expect(avitoCategory('rafting')?.kind).not.toBe('Рыбалка');
    expect(avitoCategory('fishing')?.kind).toBe('Рыбалка');
  });

  it('неизвестный тип не выгружается вовсе', () => {
    // Лучше не подать тур, чем подать не туда: за чужую категорию Авито
    // снимает объявление, а при повторах — режет аккаунт.
    expect(avitoCategory('helicopter')).toBeNull();
    const xml = generateAvitoXmlFeed([{ ...tour, activity_type: 'helicopter' }]);
    expect(xml).not.toContain('<Ad>');
  });

  it('карта категорий — одно место, а не строки по коду', () => {
    expect(Object.keys(AVITO_CATEGORY_BY_ACTIVITY).length).toBeGreaterThan(0);
  });
});

describe('объявление несёт то, что нужно площадке и человеку', () => {
  const xml = generateAvitoXmlFeed([tour]);

  it('цена, адрес и координаты', () => {
    expect(xml).toContain('<Price>13000</Price>');
    expect(xml).toContain('Камчатский край');
    expect(xml).toContain('<Latitude>53.1</Latitude>');
  });

  it('контакт оператора, а не платформы', () => {
    // Звонок «в платформу» без человека на конце убивает лид.
    expect(xml).toContain('<ContactPhone>+7 900 000-00-00</ContactPhone>');
    expect(xml).toContain('<ManagerName>Камчатка Рафтинг</ManagerName>');
    expect(ROUTE).toMatch(/LEFT JOIN partners p ON p\.id = ot\.operator_id/);
  });

  it('длительность честная: часы не делятся на 8 вслепую', () => {
    // Прежняя формула давала четырёхчасовому туру «0 дн.».
    expect(durationLabel(4)).toBe('4 ч.');
    expect(durationLabel(10)).toBe('1 день');
    expect(durationLabel(48)).toBe('2 дн.');
    expect(durationLabel(null)).toBe('по договорённости');
  });

  it('заголовок укладывается в лимит Авито', () => {
    const long = generateAvitoXmlFeed([{ ...tour, title: 'о'.repeat(120) }]);
    const title = long.match(/<Title>([^<]*)<\/Title>/)?.[1] ?? '';
    expect(title.length).toBeLessThanOrEqual(50);
  });
});

describe('контакты читаются из существующей колонки', () => {
  it('partners.contacts, а не несуществующая partners.contact', () => {
    // /api/tours-feed годами читал p.contact — такой колонки нет, запрос падал
    // и фид отдавал 500. Живой код везде использует contacts.
    expect(ROUTE).toMatch(/p\.contacts->>'phone'/);
    expect(ROUTE).not.toMatch(/p\.contact->>/);
    const toursFeed = read('app/api/tours-feed/route.ts');
    expect(toursFeed).not.toMatch(/p\.contact->>/);
  });
});
