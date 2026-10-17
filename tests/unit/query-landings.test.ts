// @vitest-environment node
/** Посадочные под запросы туристов: уникальность, hreflang взаимен, sitemap, SQL под гейтом, без зашитых цен. */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUERY_LANDINGS, landingAlternates, landingByKey } from '@/lib/seo/query-landings';
import { landingMetadata } from '@/lib/seo/query-landing-meta';
import { landingToursSql, matchesTopic, type LandingTourRow } from '@/lib/seo/query-landings-data';
import { landingDates, landingJsonLd, landingPrice, landingSeason } from '@/lib/seo/query-landing-view';
import { ZH_PAGE_PATHS } from '@/lib/zh/pages';

const SITE = 'https://vedarai.ru';
const HAN = /[一-鿿]/;
const row = (o: Partial<LandingTourRow> = {}): LandingTourRow => ({
  id: '1', slug: 'bears-1', title: 'Медведи Курильского озера', base_price: '45000', price_unit: 'per_person',
  duration_hours: '10', operator_name: 'Оператор', operator_slug: null, operator_public: true,
  season_start: '2026-06-01', season_end: '2026-09-30', next_open_date: null, ...o,
});

describe('реестр страниц', () => {
  it('у каждой страницы есть файл маршрута', () => {
    for (const l of QUERY_LANDINGS) expect(existsSync(join(process.cwd(), 'app', l.path, 'page.tsx')), l.path).toBe(true);
  });
  it('title, description, h1 и пути уникальны; описание ≤ 160', () => {
    for (const f of ['title', 'description', 'h1', 'path'] as const) {
      expect(new Set(QUERY_LANDINGS.map((l) => l[f])).size).toBe(QUERY_LANDINGS.length);
    }
    for (const l of QUERY_LANDINGS) expect(l.description.length, l.key).toBeLessThanOrEqual(160);
  });
  it('язык текста совпадает с языком страницы', () => {
    for (const l of QUERY_LANDINGS) {
      const text = l.title + l.h1 + l.faq.map((f) => f.q).join('');
      if (l.lang === 'zh-CN') expect(text).toMatch(HAN);
      else expect(text).not.toMatch(HAN);
      if (l.lang === 'en') expect(text).not.toMatch(/[а-яё]/i);
    }
  });
  it('в статичном тексте нет цифр цен', () => {
    for (const l of QUERY_LANDINGS) {
      expect(l.title + l.description + l.intro + JSON.stringify(l.faq)).not.toMatch(/\d[\d\s,]{2,}\s?(₽|руб|RUB|卢布)/);
    }
  });
  it('страница не дублирует существующие адреса каталога и /zh', () => {
    for (const l of QUERY_LANDINGS) expect(['/catalog', '/zh', '/faq', '/mcp']).not.toContain(l.path);
  });
});

describe('метаданные и hreflang', () => {
  it('canonical — свой адрес, title без шаблона', () => {
    for (const l of QUERY_LANDINGS) {
      const m = landingMetadata(l, SITE);
      expect(m.alternates?.canonical).toBe(`${SITE}${l.path}`);
      expect(m.title).toEqual({ absolute: l.title });
      expect(m.robots).toEqual({ index: true, follow: true });
    }
  });
  it('hreflang взаимен и ведёт только на страницы реестра', () => {
    const known = new Set(QUERY_LANDINGS.map((l) => `${SITE}${l.path}`));
    for (const l of QUERY_LANDINGS) {
      const alt = landingAlternates(l, SITE);
      for (const [lang, url] of Object.entries(alt)) {
        expect(known.has(url), url).toBe(true);
        if (lang === 'x-default') continue;
        const other = QUERY_LANDINGS.find((x) => `${SITE}${x.path}` === url)!;
        expect(other.lang).toBe(lang);
        expect(Object.values(landingAlternates(other, SITE))).toContain(`${SITE}${l.path}`);
      }
      if (Object.keys(alt).length) expect(alt[l.lang]).toBe(`${SITE}${l.path}`);
    }
  });
  it('страница без двойника hreflang не получает', () => {
    expect(landingMetadata(landingByKey('zh-volcano'), SITE).alternates).not.toHaveProperty('languages');
  });
});

describe('sitemap и хабы', () => {
  it('китайские — в ZH_PAGE_PATHS, остальные — в сборщике sitemap', () => {
    for (const l of QUERY_LANDINGS.filter((x) => x.lang === 'zh-CN')) expect(ZH_PAGE_PATHS).toContain(l.path);
    expect(readFileSync(join(process.cwd(), 'lib/seo/sitemap-entries.ts'), 'utf-8')).toContain('QUERY_LANDINGS');
  });
  it('/zh и реестр меню ссылаются на посадочные', () => {
    const zh = readFileSync(join(process.cwd(), 'app/zh/page.tsx'), 'utf-8');
    const nav = readFileSync(join(process.cwd(), 'lib/navigation/platform-links.ts'), 'utf-8');
    expect(zh).toContain('/zh/booking');
    expect(zh).toContain('/zh/volcano-tours');
    expect(nav).toContain('/bronirovanie-turov-kamchatka');
    expect(nav).toContain('/tury-medvedi-kamchatka');
    expect(nav).toContain('/en/kamchatka-tours');
  });
});

describe('данные', () => {
  it('SQL под гейтом витрины', () => {
    const sql = landingToursSql();
    expect(sql).toContain('is_published = true');
    expect(sql).toContain('tour_availability');
    expect(sql).toContain('activity_type');
  });
  const t = (title: string, activity_type: string | null = 'jeep_safari', location_name: string | null = null) => ({ title, activity_type, location_name });
  it('медведи: тип и слово целиком; «Медвежья чаша» и сплав — нет', () => {
    expect(matchesTopic(t('Медведи Камчатки', 'bears'), 'bears')).toBe(true); // ID47
    expect(matchesTopic(t('Курильское озеро на вертолёте', 'helicopter'), 'bears')).toBe(true); // ID67
    expect(matchesTopic(t('Озеро Толмачёва', 'jeep_safari', 'маар Медвежья чаша'), 'bears')).toBe(false); // ID60
    expect(matchesTopic(t('Сплав по реке Быстрая', 'rafting'), 'bears')).toBe(false); // ID27
    expect(matchesTopic(t('Тур к медведю'), 'bears')).toBe(true);
  });
  it('вулканы: тип, слово «вулкан», именованный вулкан; «вулканический песок» — нет', () => {
    expect(matchesTopic(t('Восхождение', 'volcano'), 'volcano')).toBe(true); // ID46
    expect(matchesTopic(t('Вулкан Горелый'), 'volcano')).toBe(true); // ID61
    expect(matchesTopic(t('Авачинский перевал'), 'volcano')).toBe(true); // ID62
    expect(matchesTopic(t('Халактырский пляж', 'jeep_safari', 'чёрный вулканический песок'), 'volcano')).toBe(false); // ID53
    expect(matchesTopic(t('Снегоходный тур по лесу', 'snowmobile'), 'volcano')).toBe(false);
    // ID52: то же место, что ID62, — правило одно для обоих (у подножия Авачинского и Корякского).
    expect(matchesTopic(t('Авачинский перевал (снегоход)', 'snowmobile', 'Авачинский перевал'), 'volcano')).toBe(true);
    expect(matchesTopic(t('Дачные источники (Малая Долина гейзеров)', 'jeep_safari', 'Дачные горячие источники, вулкан Мутновский'), 'volcano')).toBe(true); // ID57
    expect(matchesTopic(t('Долина гейзеров', 'helicopter'), 'all')).toBe(true);
  });
  it('цены из базы; нет цены — null, а не 0', () => {
    expect(landingPrice(row(), 'ru')).toMatch(/^от 45\s000 ₽\/чел\.$/);
    expect(landingPrice(row(), 'en')).toBe('from 45,000 RUB per person');
    expect(landingPrice(row(), 'zh-CN')).toContain('45,000 卢布');
    expect(landingPrice(row({ base_price: null }), 'en')).toBeNull();
    expect(landingPrice(row({ price_unit: null }), 'en')).toContain('not specified');
  });
  it('нет открытой даты — «по запросу», есть — дата', () => {
    expect(landingDates(row(), 'ru')).toBe('даты по запросу');
    expect(landingDates(row({ next_open_date: '2027-06-15' }), 'ru')).toBe('ближайшая открытая дата: 15.06.2027');
    expect(landingDates(row({ next_open_date: '2027-06-15' }), 'en')).toBe('next open date: 2027-06-15');
    expect(landingSeason(row(), 'en')).toBe('season: Jun–Sep');
  });
  it('JSON-LD: FAQPage всегда, ItemList из TouristTrip только с турами; без цены — без Offer', () => {
    const l = landingByKey('ru-bears');
    const none = landingJsonLd(l, null, SITE)['@graph'] as Array<Record<string, unknown>>;
    expect(none.map((g) => g['@type'])).toEqual(['FAQPage']);
    const g = landingJsonLd(l, [row(), row({ id: '2', slug: null, base_price: null })], SITE)['@graph'] as Array<Record<string, any>>;
    const list = g.find((x) => x['@type'] === 'ItemList')!;
    expect(list.numberOfItems).toBe(2);
    expect(list.itemListElement[0].item['@type']).toBe('TouristTrip');
    expect(list.itemListElement[0].item.url).toBe(`${SITE}/catalog/tours/bears-1`);
    expect(list.itemListElement[0].item.offers.price).toBe('45000');
    expect(list.itemListElement[1].item).not.toHaveProperty('offers');
  });
});
