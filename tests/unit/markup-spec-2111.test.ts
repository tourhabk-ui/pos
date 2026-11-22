/**
 * Разметка по спецификации Сыщика 21.11: ItemList мест по слагам с
 * numberOfItems, разметка китайских туров без выдуманного наличия, хлебные,
 * поля Article у рыб, llms.txt в head и заголовке, x-default у пар языков,
 * черновые адреса хабов не отдают 404.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placesItemListJsonLd } from '@/lib/seo/places-item-list';
import { zhTourJsonLd, zhCatalogItemListJsonLd } from '@/lib/zh/zh-jsonld';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const SITE = 'https://vedarai.ru';

describe('ItemList мест', () => {
  it('канонические слаги, name, numberOfItems = длине массива; без слага — не в списке', () => {
    const ld = placesItemListJsonLd([
      { name: 'Вулкан Авачинский', slug: 'vulkan-avachinskij', ark_id: '3a98a68d-76c8-4835-8d6d-24f7dd867cb8' },
      { name: 'Без слага', slug: null, ark_id: 'x' },
    ], SITE) as { numberOfItems: number; name: string; itemListElement: { url: string; position: number }[] };
    expect(ld.name).toBe('Места Камчатки');
    expect(ld.numberOfItems).toBe(ld.itemListElement.length);
    expect(ld.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Вулкан Авачинский', url: `${SITE}/places/vulkan-avachinskij` },
    ]);
    expect(JSON.stringify(ld)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('китайские туры и каталог', () => {
  const tour = { title: 'Долина гейзеров', base_price: '97000', season_start: '2027-05-01', season_end: '2027-10-01', operator_name: 'Оператор' };

  it('TouristTrip + Offer с ценой страницы, без наличия; хлебные на китайском', () => {
    const [trip, crumbs] = zhTourJsonLd(SITE, tour, '/zh/tours/t', '间歇泉谷');
    expect(trip['@type']).toBe('TouristTrip');
    expect(trip.inLanguage).toBe('zh-CN');
    expect(trip.offers).toEqual({ '@type': 'Offer', url: `${SITE}/zh/tours/t`, price: '97000', priceCurrency: 'RUB', validFrom: '2027-05-01', validThrough: '2027-10-01' });
    expect(JSON.stringify(trip)).not.toMatch(/availability|InStock/);
    expect(JSON.stringify(crumbs)).toContain('首页');
    expect(JSON.stringify(crumbs)).toContain(`${SITE}/zh/catalog`);
  });

  it('цены нет — оффера нет', () => {
    const [trip] = zhTourJsonLd(SITE, { ...tour, base_price: null }, '/zh/tours/t', 'x');
    expect(trip.offers).toBeUndefined();
  });

  it('ItemList каталога', () => {
    const ld = zhCatalogItemListJsonLd(SITE, [{ path: '/zh/tours/a', name: 'A' }]) as { numberOfItems: number };
    expect(ld.numberOfItems).toBe(1);
  });
});

describe('шаблоны', () => {
  it('рыбы: Article с датами, автором, издателем и картинкой; хлебные у вида; ItemList у индекса', () => {
    const detail = code('app/fish/[id]/page.tsx');
    for (const k of ['datePublished', 'dateModified', "author: { '@id': 'https://vedarai.ru/#organization' }", 'image:', 'BreadcrumbJsonLd']) expect(detail).toContain(k);
    const index = code('app/fish/page.tsx');
    expect(index).toContain("'@type': 'ItemList'");
    expect(index).toContain('fishArticleJsonLd');
    const article = code('lib/seo/fish-page.ts');
    expect(article).toContain('datePublished');
    expect(article).toContain('dateModified');
    expect(article).toContain("name: FISH_AUTHOR");
  });

  it('хлебные на /catalog, /places, /articles/*; место — второй шаг «Места»', () => {
    expect(code('app/catalog/(list)/page.tsx')).toContain("name: 'Туры', item:");
    expect(code('app/places/page.tsx')).toContain("name: 'Места', item:");
    expect(code('app/articles/[slug]/page.tsx')).toContain("'Статьи о Камчатке'");
    const place = code('app/places/[id]/page.tsx');
    expect(place).toContain("{ name: 'Места', url: `${BASE}/places` }");
    expect(place).not.toContain("'Карта мест'");
    expect(place).toContain("locale: 'ru_RU'");
    expect(place).toContain("siteName: 'Ведар'");
    expect(place).toContain("'x-default'");
  });

  it('меню места — в серверном HTML', () => {
    const client = code('app/places/[id]/_PlaceDetailClient.tsx');
    const line = client.split('\n').find((l) => l.startsWith('const Header'));
    expect(line).toBeDefined();
    expect(line).not.toContain('ssr: false');
  });

  it('llms.txt: ссылка в head и заголовок Link на всех страницах', () => {
    expect(code('app/layout.tsx')).toContain('rel="llms" href="/llms.txt"');
    const cfg = code('next.config.js');
    expect(cfg).toContain("source: '/:path+'");
    expect(cfg).toContain('rel="llms"; type="text/plain"');
  });

  it('черновые адреса хабов — постоянный редирект на страницы с их текстом', () => {
    const cfg = code('next.config.js');
    expect(cfg).toContain("{ source: '/kakie-tury-vybrat-na-kamchatke', destination: '/catalog', permanent: true }");
    expect(cfg).toContain("{ source: '/rybalka-na-kamchatke-gde-i-kogda-lovit', destination: '/rybalka-na-kamchatke-tury', permanent: true }");
  });
});
