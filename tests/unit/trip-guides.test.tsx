// @vitest-environment node
/**
 * Страницы-ответы «Сколько стоит поездка на Камчатку» и «Когда ехать на
 * Камчатку» (разбор видимости в ответах ИИ, 19.11, слово владельца «Делай
 * оба»). Сторож держит правило поведением:
 *   - цены — только из туров и жилья базы, единицы не смешиваются, итога
 *     поездки и цены перелёта нет (§24);
 *   - месяцы — из сезонов, записанных операторами; рыба — из справочника;
 *   - отказ базы — «не загрузились», а не «туров нет» (§4.0);
 *   - страницы в карте сайта, в ссылках платформы и в подвале посадочных,
 *     canonical — свой адрес, разметка FAQPage — те же вопросы, что на экране.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TripCostView, TripSeasonView, guideJsonLd } from '@/components/seo/TripGuides';
import { QueryLandingView } from '@/components/seo/QueryLanding';
import { landingByKey } from '@/lib/seo/query-landings';
import type { LandingTourRow } from '@/lib/seo/query-landings-data';
import { PLATFORM_LINKS } from '@/lib/navigation/platform-links';
import {
  TRIP_COST, TRIP_GUIDES, TRIP_SEASON, costByActivity, costByTopic, costFaq, costLead, costTitle,
  priceSpans, seasonFaq, seasonLead, seasonTable, seasonTitle, stayPriceWords, unpricedCount,
} from '@/lib/seo/trip-guides';
import { FISH_SPECIES } from '@/lib/fish-species';
import { TITLE_LIMIT } from '@/lib/seo/title-fit';

const data = vi.hoisted(() => ({ tours: null as unknown, stay: null as unknown }));
vi.mock('@/lib/seo/trip-guides-data', () => ({
  loadGuideTours: async () => data.tours,
  loadStayPrices: async () => data.stay,
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

const sp = (v: unknown): string => String(v).replace(/[  ]/g, ' ');

const base: LandingTourRow = {
  id: '1', slug: 'a', title: 'Тур', base_price: '45000', price_unit: 'per_person',
  duration_hours: '10', operator_name: 'Альфа', operator_slug: 'alfa', operator_public: true,
  season_start: null, season_end: null, next_open_date: null, title_zh: null, any_day_open: null,
  activity_type: null, location_name: null,
};
const tours: LandingTourRow[] = [
  { ...base, id: '1', title: 'Наблюдение за медведями', activity_type: 'bears', base_price: '97000', season_start: '2026-07-01', season_end: '2026-09-30' },
  { ...base, id: '2', title: 'Медведи Курильского озера', activity_type: 'bears', base_price: '45000', operator_slug: 'beta', operator_name: 'Бета', season_start: '2026-07-15', season_end: '2026-08-31' },
  { ...base, id: '3', title: 'Снегоходы', activity_type: 'snowmobile', base_price: '30000', price_unit: 'per_tour', season_start: '2026-12-01', season_end: '2027-03-31' },
  { ...base, id: '4', title: 'Рыбалка на реке', activity_type: 'fishing', base_price: null },
  { ...base, id: '5', title: 'Конная прогулка', activity_type: 'horse_magic', base_price: '8000', price_unit: null },
];
const stay = { total: 5, priced: 3, min: 3500, max: 12000 };

beforeEach(() => { data.tours = tours; data.stay = stay; });

describe('цены поездки — из туров базы', () => {
  it('вилки по единицам: за человека и за группу не смешиваются; без цены и без единицы — вне вилок', () => {
    expect(priceSpans(tours)).toEqual([
      { unit: 'per_person', min: 45000, max: 97000, n: 2 },
      { unit: 'per_tour', min: 30000, max: 30000, n: 1 },
    ]);
    expect(unpricedCount(tours)).toBe(2);
  });
  it('по видам: вид из словаря, незнакомый вид — «Другие туры», а не служебное слово', () => {
    const groups = costByActivity(tours);
    expect(groups[0]).toMatchObject({ activity: 'bears', count: 2 });
    const labels = groups.map((g) => g.label);
    expect(labels).toContain('Другие туры');
    expect(labels.join(' ')).not.toContain('horse_magic');
    expect(groups.find((g) => g.activity === 'fishing')).toMatchObject({ spans: [], unpriced: 1 });
  });
  it('по направлениям — ссылкой на посадочную той же темы; тема без туров не названа', () => {
    const topics = costByTopic(tours).map((x) => x.landing.path);
    expect(topics).toContain('/tury-medvedi-kamchatka');
    expect(topics).toContain('/snegohodnye-tury-kamchatka');
    expect(topics).not.toContain('/dolina-gejzerov-ekskursiya');
  });
  it('заголовок и первая строка с числами; нет туров и отказ — без чисел', () => {
    expect(sp(costTitle(tours))).toBe('Сколько стоит поездка на Камчатку: туры от 45 000 ₽ за человека');
    expect(costTitle(tours).length).toBeLessThanOrEqual(TITLE_LIMIT);
    expect(costTitle(null)).toBe(TRIP_COST.h1);
    expect(costTitle([])).toBe(TRIP_COST.h1);
    expect(sp(costLead(tours))).toBe('Сейчас на Ведаре 5 туров от 2 компаний: от 45 000 ₽ до 97 000 ₽ за человека (2 тура); 30 000 ₽ за группу (1 тур).');
    expect(costLead(null)).toBeNull();
  });
  it('жильё: вилка хозяев и сколько без цены; цен нет — так и сказано', () => {
    expect(sp(stayPriceWords(stay))).toContain('от 3 500 ₽ до 12 000 ₽ (3 объекта на Ведаре)');
    expect(stayPriceWords(stay)).toContain('У 2 объектов цена не записана.');
    expect(sp(stayPriceWords({ total: 1, priced: 1, min: 4000, max: 4000 }))).toContain('4 000 ₽ (1 объект на Ведаре)');
    expect(stayPriceWords({ total: 2, priced: 0, min: null, max: null })).toContain('не записали');
  });
  it('итога поездки и цены перелёта нет; вопросы — без выдуманных сумм', () => {
    const faq = costFaq(tours, stay);
    const flight = faq.find((f) => f.q.includes('перелёт'))!;
    const total = faq.find((f) => f.q.includes('денег'))!;
    expect(flight.a).not.toMatch(/\d/);
    expect(total.a).not.toMatch(/\d/);
    expect(costFaq(null, null).some((f) => f.q === 'Сколько стоит тур на Камчатку?')).toBe(false);
  });
  it('экран: вилки и ссылки; разметка FAQPage — те же вопросы, что на экране', () => {
    const html = sp(renderToStaticMarkup(<TripCostView tours={tours} stay={stay} />));
    expect(html).toContain('от 45 000 ₽ до 97 000 ₽ за человека (2 тура)');
    expect(html).toContain('href="/tury-medvedi-kamchatka"');
    expect(html).toContain('href="/flights"');
    expect(html).toContain('href="/transfers"');
    expect(html).toContain('href="/kogda-ehat-na-kamchatku"');
    const ld = guideJsonLd(TRIP_COST, costFaq(tours, stay)) as { '@graph': Array<{ mainEntity: Array<{ name: string }> }> };
    for (const q of ld['@graph'][0]!.mainEntity) expect(html).toContain(q.name);
  });
  it('база не ответила — «не загрузились», а не «туров нет»; жильё не прочиталось — так и сказано', () => {
    const html = renderToStaticMarkup(<TripCostView tours={null} stay={null} />);
    expect(html).toContain('data-guide-unavailable');
    expect(html).not.toContain('нет опубликованных туров');
    expect(html).toContain('Цены жилья не загрузились');
    expect(renderToStaticMarkup(<TripCostView tours={[]} stay={stay} />)).toContain('нет опубликованных туров');
  });
});

describe('когда ехать — по сезонам туров', () => {
  it('месяц тура — месяц его записанного сезона, через Новый год — по кругу; без сезона — вне таблицы', () => {
    const t = seasonTable(tours);
    expect(t.withSeason).toBe(3);
    expect(t.withoutSeason).toBe(2);
    const by = (m: number) => t.months[m - 1]!;
    expect(by(8).tours).toBe(2);
    expect(by(1).tours).toBe(1);
    expect(by(5).tours).toBe(0);
    expect(by(8).topics.map((x) => x.landing.path)).toContain('/tury-medvedi-kamchatka');
    expect(by(1).topics.map((x) => x.landing.path)).toContain('/snegohodnye-tury-kamchatka');
  });
  it('рыба месяца — из справочника рыб', () => {
    const t = seasonTable(tours);
    for (const m of t.months) {
      const expected = FISH_SPECIES.filter((f) => f.seasonMonths.includes(m.month)).map((f) => f.id);
      expect(m.fish.map((f) => f.id)).toEqual(expected);
    }
  });
  it('первая строка и вопросы — по таблице; медведи и снегоходы — их месяцы', () => {
    const t = seasonTable(tours);
    expect(seasonLead(t)).toContain('Больше всего туров');
    const faq = seasonFaq(t);
    expect(faq.find((f) => f.q.includes('медвед'))!.a).toContain('июль');
    expect(faq.some((f) => f.q.includes('зимой'))).toBe(true);
    expect(seasonTitle(t).length).toBeLessThanOrEqual(TITLE_LIMIT);
  });
  it('без туров к медведям заголовок медведей не обещает', () => {
    const t = seasonTable([tours[2]!]);
    expect(seasonTitle(t)).not.toContain('медвед');
    expect(seasonTitle(null)).toBe(TRIP_SEASON.h1);
    expect(seasonLead(null)).toBeNull();
  });
  it('экран: месяцы, ссылки на посадочные и на рыбу; отказ — «не загрузились»', () => {
    const html = renderToStaticMarkup(<TripSeasonView tours={tours} />);
    expect(html).toContain('data-season-month="8"');
    expect(html).toContain('href="/tury-medvedi-kamchatka"');
    expect(html).toMatch(/href="\/fish\/[a-z_-]+"/);
    expect(html).toContain('У 2 из 5 туров сезон не записан');
    expect(renderToStaticMarkup(<TripSeasonView tours={null} />)).toContain('data-guide-unavailable');
  });
});

describe('страницы, ссылки, карта сайта', () => {
  it('метаданные: canonical — свой адрес, заголовок с числом из базы', async () => {
    const cost = await import('@/app/skolko-stoit-poezdka-na-kamchatku/page');
    const m = await cost.generateMetadata();
    expect(m.alternates?.canonical).toBe('https://vedarai.ru/skolko-stoit-poezdka-na-kamchatku');
    expect(sp((m.title as { absolute: string }).absolute)).toContain('от 45 000 ₽');
    const season = await import('@/app/kogda-ehat-na-kamchatku/page');
    const s = await season.generateMetadata();
    expect(s.alternates?.canonical).toBe('https://vedarai.ru/kogda-ehat-na-kamchatku');
    data.tours = null;
    const down = await cost.generateMetadata();
    expect((down.title as { absolute: string }).absolute).toBe(TRIP_COST.h1);
  });
  it('страница рендерится из загрузчиков', async () => {
    const cost = await import('@/app/skolko-stoit-poezdka-na-kamchatku/page');
    const html = sp(renderToStaticMarkup(await cost.default()));
    expect(html).toContain('data-guide="cost"');
    expect(html).toContain('от 3 500 ₽ до 12 000 ₽');
  });
  it('обе страницы — в ссылках платформы и в подвале русской посадочной', () => {
    const hrefs = PLATFORM_LINKS.map((l) => l.href);
    for (const g of TRIP_GUIDES) expect(hrefs).toContain(g.path);
    const html = renderToStaticMarkup(<QueryLandingView landing={landingByKey('ru-geysers')} tours={[]} />);
    for (const g of TRIP_GUIDES) expect(html).toContain(`href="${g.path}"`);
    const en = renderToStaticMarkup(<QueryLandingView landing={landingByKey('en-bears')} tours={[]} />);
    for (const g of TRIP_GUIDES) expect(en).not.toContain(`href="${g.path}"`);
  });
});
