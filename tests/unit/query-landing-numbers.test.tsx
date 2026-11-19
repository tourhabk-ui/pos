// @vitest-environment node
/**
 * Числа посадочной из её же туров (разбор видимости в ответах ИИ, 19.11):
 * заголовок и первая строка называют сколько туров, цену «от», компании,
 * ближайшую дату и годы. Числа берутся только из списка туров страницы; нет
 * туров или база не ответила — чисел нет, прежние слова.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryLandingView } from '@/components/seo/QueryLanding';
import { QUERY_LANDINGS, landingByKey } from '@/lib/seo/query-landings';
import { landingMetadata } from '@/lib/seo/query-landing-meta';
import { landingLead, landingSummary, landingTitle } from '@/lib/seo/query-landing-view';
import type { LandingTourRow } from '@/lib/seo/query-landings-data';
import { TITLE_LIMIT } from '@/lib/seo/title-fit';

const base: LandingTourRow = {
  id: '1', slug: 'a', title: 'Тур', base_price: '45000', price_unit: 'per_person',
  duration_hours: '10', operator_name: 'Альфа', operator_slug: 'alfa', operator_public: true,
  season_start: null, season_end: null, next_open_date: null, title_zh: null, any_day_open: null,
};
const tours: LandingTourRow[] = [
  { ...base, id: '1', base_price: '45000', next_open_date: '2027-01-12' },
  { ...base, id: '2', base_price: '30000', price_unit: 'per_tour', operator_name: 'Бета', operator_slug: 'beta', next_open_date: '2026-12-05' },
  { ...base, id: '3', base_price: '52000', operator_name: 'Бета', operator_slug: 'beta' },
];
const SITE = 'https://vedarai.ru';
/** Локаль печатает число с неразрывным пробелом; сравниваем по смыслу. */
const sp = (v: unknown): string => String(v).replace(/[\u00a0\u202f]/g, ' ');

describe('числа посадочной', () => {
  it('сводка: число туров и компаний, цена «от» за человека, ближайшая дата, годы из базы', () => {
    const s = landingSummary(tours, [2026, 2027]);
    expect(s).toEqual({ count: 3, operators: 2, cheapest: { price: 45000, unit: 'per_person' }, nearest: '2026-12-05', years: '2026–2027' });
  });
  it('цена за группу не считается дешевле цены за человека; только за группу — так и сказано', () => {
    expect(landingSummary(tours, null)!.cheapest).toEqual({ price: 45000, unit: 'per_person' });
    const group = landingSummary([tours[1]!], null)!;
    expect(group.cheapest).toEqual({ price: 30000, unit: 'per_tour' });
    expect(sp(landingLead(landingByKey('ru-geysers'), group))).toContain('от 30 000 ₽ за группу');
    expect(landingSummary([{ ...base, price_unit: null }], null)!.cheapest).toBeNull();
  });
  it('годы не прочитались — года в заголовке нет', () => {
    const t = landingTitle(landingByKey('ru-geysers'), landingSummary(tours, null));
    expect(sp(t)).toBe('Экскурсия в Долину гейзеров: 3 тура от 45 000 ₽');
  });
  it('заголовок и первая строка страницы', () => {
    const l = landingByKey('ru-geysers');
    const s = landingSummary(tours, [2026, 2027]);
    expect(sp(landingTitle(l, s))).toBe('Экскурсия в Долину гейзеров: 3 тура от 45 000 ₽, 2026–2027');
    const html = sp(renderToStaticMarkup(<QueryLandingView landing={l} tours={tours} summary={s} />));
    expect(html).toContain('Сейчас на Ведаре 3 тура в Долину гейзеров от 2 компаний, цены от 45 000 ₽ за человека, ближайшая свободная дата — 05.12.2026.');
    expect(html.indexOf('data-landing-lead')).toBeLessThan(html.indexOf(l.intro));
  });
  it('без свободных дат — «по запросу», а не выдуманная дата', () => {
    const lead = landingLead(landingByKey('ru-bears'), landingSummary([base], null));
    expect(sp(lead)).toBe('Сейчас на Ведаре 1 тур с наблюдением медведей от 1 компании, цены от 45 000 ₽ за человека, свободных дат в расписании нет, даты — по запросу.');
  });
  it('пусто и отказ базы: чисел нет, прежний заголовок и описание', () => {
    const l = landingByKey('ru-fishing');
    for (const t of [null, []]) {
      const s = landingSummary(t, [2027]);
      expect(s).toBeNull();
      const m = landingMetadata(l, SITE, s);
      expect(m.title).toEqual({ absolute: l.title });
      expect(m.description).toBe(l.description);
      expect(renderToStaticMarkup(<QueryLandingView landing={l} tours={t} summary={s} />)).not.toContain('data-landing-lead');
    }
  });
  it('метаданные с числами: title, description и og из сводки', () => {
    const l = landingByKey('ru-kurile');
    const s = landingSummary(tours, [2027]);
    const m = landingMetadata(l, SITE, s);
    expect(sp((m.title as { absolute: string }).absolute)).toBe(`${l.h1}: 3 тура от 45 000 ₽, 2027`);
    expect(m.description).toBe(landingLead(l, s));
    expect(m.openGraph?.title).toBe(landingTitle(l, s));
  });
  it('английская страница — английскими словами', () => {
    const l = landingByKey('en-bears');
    const s = landingSummary(tours, [2026, 2027]);
    expect(landingTitle(l, s)).toBe('Kamchatka bear watching tours: 3 tours from 45,000 RUB | Vedar');
    expect(landingLead(l, s)).toBe('Vedar currently lists 3 tours with bear watching from 2 local operators, prices from 45,000 RUB per person, next open date 2026-12-05.');
  });
  it('у каждой посадочной с турами своя первая строка; китайские и трансфер — без неё', () => {
    const s = landingSummary(tours, [2027]);
    const leads = QUERY_LANDINGS.filter((l) => l.subject).map((l) => landingLead(l, s));
    expect(new Set(leads).size).toBe(leads.length);
    expect(leads.length).toBeGreaterThanOrEqual(13);
    for (const key of ['zh-volcano', 'zh-booking', 'ru-transfer']) {
      const l = landingByKey(key);
      expect(landingLead(l, s), key).toBeNull();
      expect(landingTitle(l, s), key).toBe(l.title);
    }
  });
  it('заголовок помещается в выдачу: длинный — сперва без годов, потом без цены, число туров остаётся', () => {
    const many = Array.from({ length: 128 }, (_, i) => ({ ...base, id: String(i), base_price: '1250000' }));
    const s = landingSummary(many, [2026, 2027]);
    for (const l of QUERY_LANDINGS.filter((x) => x.subject)) {
      const t = landingTitle(l, s);
      expect(t.length, l.key).toBeLessThanOrEqual(TITLE_LIMIT);
      expect(t, l.key).toContain(l.lang === 'ru' ? '128 туров' : '128 tours');
    }
    const avacha = sp(landingTitle(landingByKey('ru-avacha'), s));
    expect(avacha).toBe('Восхождение на Авачинский вулкан: 128 туров от 1 250 000 ₽');
  });
});
