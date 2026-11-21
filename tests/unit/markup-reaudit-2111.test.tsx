/**
 * Повторный аудит Сыщика 21.11 (reaudit-2026-11-21.md): ItemList подборок и
 * хабов, Article на хабе рыбалки, TouristAttraction на китайских местах,
 * файл-ключ IndexNow в корне, без истории про снятый набор там, где очерк есть.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup } from '@testing-library/react';

import { landingItemListJsonLd } from '@/components/landings/LandingPage';
import { landingBySlug } from '@/lib/landings/landings';
import type { LandingBlockTour } from '@/lib/landings/tours';
import { zhPlaceJsonLd } from '@/lib/zh/zh-jsonld';
import PlaceHazardsUnknown from '@/components/places/PlaceHazardsUnknown';
import { INDEXNOW_KEY } from '@/lib/seo/indexnow';

afterEach(cleanup);

const tour = (o: Partial<LandingBlockTour>): LandingBlockTour => ({
  id: '1', slug: 'tur', title: 'Тур', base_price: '10000', price_unit: 'per_person', duration_hours: '8',
  operator_name: 'Оператор', operator_slug: null, operator_public: null,
  season_start: null, season_end: null, next_open_date: null, any_day_open: null, ...o,
});

type List = { '@type': string; numberOfItems: number; itemListElement: Array<{ position: number; name: string; url: string }> };

describe('ItemList подборок и хабов', () => {
  it('хаб «Когда ехать» — двенадцать месяцев с адресами месячных страниц', () => {
    const l = landingItemListJsonLd(landingBySlug('kogda-ehat-na-kamchatku'), null) as unknown as List;
    expect(l['@type']).toBe('ItemList');
    expect(l.numberOfItems).toBe(12);
    expect(l.itemListElement[0].url).toBe('https://vedarai.ru/kamchatka-v-yanvare');
    expect(l.itemListElement[11].position).toBe(12);
  });

  it('подборка с блоком туров — те же туры, что на экране, по порядку', () => {
    for (const slug of ['chto-posmotret-na-kamchatke', 'voshozhdenie-na-avachinskij-vulkan', 'voshozhdeniya-na-vulkany-kamchatki']) {
      const l = landingItemListJsonLd(landingBySlug(slug), [tour({ id: 'a', slug: 'a', title: 'Первый' }), tour({ id: 'b', slug: 'b', title: 'Второй' })]) as unknown as List;
      expect(l.numberOfItems, slug).toBe(2);
      expect(l.itemListElement.map((i) => i.name), slug).toEqual(['Первый', 'Второй']);
      expect(l.itemListElement[0].url, slug).toMatch(/^https:\/\/vedarai\.ru\/catalog\/tours\//);
    }
  });

  it('пустой или не загрузившийся блок и страница без блока — узла нет', () => {
    expect(landingItemListJsonLd(landingBySlug('chto-posmotret-na-kamchatke'), [])).toBeNull();
    expect(landingItemListJsonLd(landingBySlug('chto-posmotret-na-kamchatke'), null)).toBeNull();
    expect(landingItemListJsonLd(landingBySlug('raznica-vo-vremeni-kamchatka-moskva'), [tour({})])).toBeNull();
  });
});

describe('хаб рыбалки', () => {
  it('Article и хлебные крошки; FAQPage одна — у витрины', () => {
    const src = readFileSync(join(process.cwd(), 'app/rybalka-na-kamchatke-tury/page.tsx'), 'utf8');
    expect(src).toContain('articleJsonLd(');
    expect(src).toContain('faq: []');
    expect(src).toContain("'@type': 'BreadcrumbList'");
  });
});

describe('китайские места', () => {
  it('TouristAttraction: имя, координаты, ссылка на русскую карточку; описание — только свежий перевод', () => {
    const ld = zhPlaceJsonLd('https://vedarai.ru', { name: 'Вулкан', lat: '53.25', lng: '158.83' }, '/zh/places/x', '/places/x', '火山', null);
    expect(ld['@type']).toBe('TouristAttraction');
    expect(ld.sameAs).toBe('https://vedarai.ru/places/x');
    expect(ld.geo).toEqual({ '@type': 'GeoCoordinates', latitude: 53.25, longitude: 158.83 });
    expect(ld).not.toHaveProperty('description');
    const noGeo = zhPlaceJsonLd('https://vedarai.ru', { name: 'В', lat: null, lng: null }, '/zh/places/y', '/places/y', 'В', '描述');
    expect(noGeo).not.toHaveProperty('geo');
    expect(noGeo.description).toBe('描述');
  });
});

describe('IndexNow: ключ и в корне по своему имени', () => {
  it('файл /{key}.txt есть и отдаёт тот же ключ, что /indexnow.txt', async () => {
    const dir = join(process.cwd(), 'app', `${INDEXNOW_KEY}.txt`);
    expect(existsSync(join(dir, 'route.ts'))).toBe(true);
    const mod = await import(`@/app/${INDEXNOW_KEY}.txt/route`);
    expect(await (mod.GET() as Response).text()).toBe(INDEXNOW_KEY);
  });
});

describe('карточка места: история про снятый набор', () => {
  it('без очерка — история остаётся; с очерком — только общая строка', () => {
    const a = render(createElement(PlaceHazardsUnknown, { hazards: [], source: 'type_template' }));
    expect(a.container.textContent).toContain('мы его убрали');
    cleanup();
    const b = render(createElement(PlaceHazardsUnknown, { hazards: [], source: 'type_template', hasEssay: true }));
    expect(b.container.textContent).not.toContain('убрали');
    expect(b.container.textContent).toContain('это не значит, что их нет');
  });
});
