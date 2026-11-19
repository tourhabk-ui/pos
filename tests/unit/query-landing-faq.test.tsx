// @vitest-environment node
/**
 * FAQ посадочных (разбор видимости в ответах ИИ, 19.11): «сколько стоит» и
 * «когда» отвечают сами туры страницы; правила заповедника и МЧС — с
 * источником; вопроса про MCP среди вопросов туриста нет.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryLandingView } from '@/components/seo/QueryLanding';
import { QUERY_LANDINGS, landingByKey } from '@/lib/seo/query-landings';
import { landingFaq, monthsWords, seasonMonths } from '@/lib/seo/query-landing-faq';
import { landingSummary } from '@/lib/seo/query-landing-view';
import type { LandingTourRow } from '@/lib/seo/query-landings-data';

const sp = (v: unknown): string => String(v).replace(/[  ]/g, ' ');

const base: LandingTourRow = {
  id: '1', slug: 'a', title: 'Тур', base_price: '45000', price_unit: 'per_person',
  duration_hours: '10', operator_name: 'Альфа', operator_slug: 'alfa', operator_public: true,
  season_start: '2026-06-01', season_end: '2026-09-30', next_open_date: null, title_zh: null, any_day_open: null,
};
const tours: LandingTourRow[] = [
  { ...base, id: '1', base_price: '45000' },
  { ...base, id: '2', base_price: '120000', season_start: '2026-08-01', season_end: '2026-10-31' },
  { ...base, id: '3', base_price: '300000', price_unit: 'per_tour', season_start: null, season_end: null },
  { ...base, id: '4', base_price: '9000', price_unit: 'per_hour', season_start: '2026-12-15', season_end: '2027-03-31' },
];

describe('месяцы сезона', () => {
  it('отрезок, отрезок через Новый год, один месяц, круглый год', () => {
    expect(seasonMonths({ season_start: '2026-06-01', season_end: '2026-09-30' })).toEqual([6, 7, 8, 9]);
    expect(seasonMonths({ season_start: '2026-12-01', season_end: '2027-02-28' })).toEqual([12, 1, 2]);
    expect(seasonMonths({ season_start: '2026-07-01', season_end: '2026-07-20' })).toEqual([7]);
    expect(seasonMonths({ season_start: null, season_end: '2026-07-20' })).toBeNull();
    expect(monthsWords([6, 7, 8, 9, 10], 'ru')).toBe('июнь–октябрь');
    expect(monthsWords([12, 1, 2, 3, 7], 'ru')).toBe('июль, декабрь–март');
    expect(monthsWords([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'ru')).toBe('круглый год');
    expect(monthsWords([6, 7], 'en')).toBe('June–July');
  });
});

describe('вопросы с ответом из туров', () => {
  it('цена: вилка за человека и отдельно за группу, незнакомая единица названа', () => {
    const faq = landingFaq(landingByKey('ru-geysers'), tours, null);
    expect(faq[0]!.q).toBe('Сколько стоят туры в Долину гейзеров?');
    expect(sp(faq[0]!.a)).toBe('По турам на этой странице — от 45 000 ₽ до 120 000 ₽ за человека (2 тура); 300 000 ₽ за группу (1 тур). Это цены, которые операторы указали на Ведаре; итог называет оператор при подтверждении заявки. У 1 тура цена записана иначе или не записана — она в карточке тура.');
  });
  it('сезон: месяцы по данным операторов, ближайшая дата, у скольких сезон не записан', () => {
    const faq = landingFaq(landingByKey('ru-kurile'), tours, '2026-12-05');
    expect(faq[1]!.q).toBe('Когда идут туры на Курильское озеро?');
    expect(faq[1]!.a).toBe('По данным операторов туры на этой странице идут: июнь–октябрь, декабрь–март. Ближайшая свободная дата — 05.12.2026. У 1 тура сезон не записан.');
  });
  it('без дат и без сезонов — так и сказано, а не выдуманный месяц', () => {
    const bare = [{ ...base, season_start: null, season_end: null, price_unit: null }];
    const [price, season] = landingFaq(landingByKey('ru-bears'), bare, null);
    expect(price!.a).toContain('цена с понятной единицей не записана');
    expect(season!.a).toBe('Сезон у туров на этой странице не записан. Свободных дат в расписании сейчас нет: даты — по заявке.');
  });
  it('пусто, отказ базы, китайская страница и трансфер — только постоянные вопросы', () => {
    for (const t of [null, []]) expect(landingFaq(landingByKey('ru-geysers'), t, null)).toBe(landingByKey('ru-geysers').faq);
    expect(landingFaq(landingByKey('zh-volcano'), tours, null)).toBe(landingByKey('zh-volcano').faq);
    expect(landingFaq(landingByKey('ru-transfer'), tours, null)).toBe(landingByKey('ru-transfer').faq);
  });
  it('английская страница — по-английски', () => {
    const faq = landingFaq(landingByKey('en-bears'), tours, '2026-12-05');
    expect(faq[0]!.q).toBe('How much do tours with bear watching cost?');
    expect(faq[1]!.a).toContain('According to operators, tours on this page run: June–October, December–March. Next open date: 2026-12-05. 1 tour has no season recorded.');
  });
});

describe('постоянные вопросы', () => {
  it('про MCP среди вопросов туриста нет — ни на русских, ни на английских турах', () => {
    for (const l of QUERY_LANDINGS.filter((x) => x.lang !== 'zh-CN' && x.topic !== 'transfer')) {
      for (const f of l.faq) expect(`${f.q} ${f.a}`, l.key).not.toMatch(/MCP|ИИ-ассистент|AI assistant/);
    }
  });
  it('Долина гейзеров и Курильское озеро: правило заповедника с приказом и адресом', () => {
    for (const key of ['ru-geysers', 'ru-kurile']) {
      const a = landingByKey(key).faq.map((f) => f.a).join(' ');
      expect(a, key).toContain('приказ № 24-П от 29.01.2026');
      expect(a, key).toContain('только в сопровождении сотрудника заповедника');
      expect(a, key).toContain('https://kronoki.ru/ru/visit/information-for-all/rules/447.html');
    }
  });
  it('МЧС: срок и памятка ведомства; «регистрацию делает оператор» не утверждается', () => {
    for (const key of ['ru-avacha', 'ru-tolbachik', 'ru-mutnovsky']) {
      const f = landingByKey(key).faq.find((x) => x.q === 'Нужна ли регистрация в МЧС?');
      expect(f, key).toBeDefined();
      expect(f!.a).toContain('за 10 рабочих дней');
      expect(f!.a).toContain('https://41.mchs.gov.ru/');
      expect(f!.a).toContain('уточните у оператора');
    }
    for (const l of QUERY_LANDINGS) for (const f of l.faq) expect(f.a, l.key).not.toContain('регистрацию группы делает оператор');
  });
});

describe('страница', () => {
  it('вопросы из туров — на экране и в разметке FAQPage одни и те же', () => {
    const l = landingByKey('ru-geysers');
    const html = sp(renderToStaticMarkup(<QueryLandingView landing={l} tours={tours} summary={landingSummary(tours, null)} />));
    expect(html).toContain('<dt class="font-semibold" style="color:var(--text-primary)">Сколько стоят туры в Долину гейзеров?</dt>');
    const ld = /<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/s.exec(html)?.[1] ?? '';
    expect(ld).toContain('"name":"Сколько стоят туры в Долину гейзеров?"');
    expect(ld).toContain('"name":"Когда идут туры в Долину гейзеров?"');
  });
});
