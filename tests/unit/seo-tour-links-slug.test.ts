// @vitest-environment node
/**
 * Ссылки на тур наружу — адресом по имени (ЧПУ), а не числом (сверка SEO 10.10).
 *
 * С 30.09 канон карточки тура — /catalog/tours/{slug}; число открывает её
 * только через 308. Sitemap, канонический адрес и пост канала уже брали адрес
 * через tourPath(), а ленты Яндекса и Авито, лента Meta и разметка ItemList
 * каталога по-прежнему писали число: площадке и поисковику отдавался редирект
 * вместо карточки, и в разметке значился не тот адрес, что страница считает
 * своим. Там же картинка тура уходила в ItemList относительным путём из базы
 * (аудит 29.09, Н14) — schema.org image это URL.
 *
 * Там же — H1 планера (был «Когда», название шага) и остаток старого бренда в
 * метаданных кабинетов.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateYandexYmlFeed } from '@/lib/channels/yandex';
import { generateAvitoXmlFeed } from '@/lib/channels/avito';
import { buildToursItemListJsonLd } from '@/lib/tours/marketplace-page';
import type { ChannelTour } from '@/lib/channels/types';
import type { MarketplaceTourRow } from '@/lib/search';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

const tour: ChannelTour = {
  id: 27,
  slug: 'splav-po-bystroy',
  title: 'Сплав по Быстрой',
  description: 'Однодневный сплав по реке Быстрой с обедом на берегу и рыбалкой. '.repeat(6),
  short_description: 'Сплав по Быстрой',
  activity_type: 'rafting',
  location_name: 'Мильковский район',
  latitude: 54.7,
  longitude: 158.6,
  base_price: 15000,
  max_participants: 8,
  duration_hours: 10,
  difficulty: 'easy',
  photos: ['/images/tours/rafting.jpg'],
  included: ['обед'],
  season_start: '2099-06-01',
  season_end: '2099-09-15',
  operator_name: 'Оператор',
  operator_phone: '+7 900 000-00-00',
  tripster_experience_id: null,
  avito_listing_id: null,
  sputnik8_product_id: null,
};

describe('ленты площадок ведут на адрес по имени', () => {
  it('Яндекс: <url> и ссылка в описании — /catalog/tours/{slug}, числа нет', () => {
    const xml = generateYandexYmlFeed([tour]);
    expect(xml).toContain('<url>https://vedarai.ru/catalog/tours/splav-po-bystroy</url>');
    expect(xml).toMatch(/Подробнее и бронирование: https:\/\/vedarai\.ru\/catalog\/tours\/splav-po-bystroy/);
    expect(xml).not.toContain('/catalog/tours/27');
  });

  it('Яндекс: тур без адреса — числом, а не пустым адресом', () => {
    const xml = generateYandexYmlFeed([{ ...tour, slug: null }]);
    expect(xml).toContain('<url>https://vedarai.ru/catalog/tours/27</url>');
  });

  it('Авито: ссылка в объявлении — по имени', () => {
    const { xml } = generateAvitoXmlFeed([tour]);
    expect(xml).toContain('/catalog/tours/splav-po-bystroy');
    expect(xml).not.toContain('/catalog/tours/27');
  });

  it('отбор лент приносит адрес из базы, лента Meta — тоже', () => {
    expect(read('lib/channels/ready-tours.ts')).toMatch(/ot\.id, ot\.slug, ot\.title/);
    expect(read('lib/channels/ready-tours.ts')).toMatch(/slug: r\.slug,/);
    const meta = read('app/api/meta/catalog/route.ts');
    expect(meta).toMatch(/ot\.id, ot\.slug, ot\.title/);
    expect(meta).toMatch(/link: `\$\{APP_URL\}\$\{tourPath\(tour\)\}`/);
  });

  it('ни одна лента не собирает адрес тура числом вручную', () => {
    for (const f of ['lib/channels/yandex.ts', 'lib/channels/avito.ts', 'app/api/meta/catalog/route.ts', 'lib/tours/marketplace-page.ts']) {
      expect(read(f), f).not.toMatch(/\/tours\/\$\{(tour\.id|t\.id|id)\}/);
    }
  });
});

describe('ItemList каталога', () => {
  const row = (over: Partial<MarketplaceTourRow>) => ({
    id: '27', slug: 'splav-po-bystroy', title: 'Сплав', description: 'Сплав по Быстрой',
    tour_image: '/images/tours/rafting.jpg', operator_name: 'Оператор', base_price: '15000',
    ...over,
  }) as unknown as MarketplaceTourRow;

  it('@id и url предложения — адрес по имени; картинка — абсолютным URL', () => {
    const ld = buildToursItemListJsonLd([row({})], 'https://vedarai.ru', '/catalog') as {
      itemListElement: Array<{ item: { '@id': string; image?: string; offers: { url: string } } }>;
    };
    const item = ld.itemListElement[0].item;
    expect(item['@id']).toBe('https://vedarai.ru/catalog/tours/splav-po-bystroy');
    expect(item.offers.url).toBe('https://vedarai.ru/catalog/tours/splav-po-bystroy');
    expect(item.image).toBe('https://vedarai.ru/images/tours/rafting.jpg');
  });

  it('абсолютная картинка не склеивается с доменом второй раз', () => {
    const ld = buildToursItemListJsonLd([row({ tour_image: 'https://s3.example/x.jpg' })], 'https://vedarai.ru', '/catalog') as {
      itemListElement: Array<{ item: { image?: string } }>;
    };
    expect(ld.itemListElement[0].item.image).toBe('https://s3.example/x.jpg');
  });
});

describe('мелочи метаданных (аудит 29.09, Н14)', () => {
  it('у планера H1 — что за страница, название шага — H2', () => {
    const c = read('app/planner/_PlannerClient.tsx');
    const header = c.slice(c.indexOf('const stepHeader = ('), c.indexOf('{PLANNER_STEPS[step - 1].lead}'));
    expect(header).toMatch(/<h1[^>]*>\s*Конструктор маршрута по Камчатке/);
    expect(header).toMatch(/<h2[^>]*>\s*\{PLANNER_STEPS\[step - 1\]\.title\}\s*<\/h2>/);
    expect(header.match(/<h1/g)).toHaveLength(1);
  });

  it('старого бренда в метаданных страниц нет', () => {
    for (const f of ['app/hub/admin/finance/page.tsx', 'app/profile/page.tsx', 'app/hub/guide/page.tsx']) {
      expect(read(f), f).not.toMatch(/Tourhab/i);
    }
  });
});
