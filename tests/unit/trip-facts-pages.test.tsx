// @vitest-environment node
/**
 * «Сколько стоит поездка на Камчатку» и «Когда ехать на Камчатку» (разбор
 * видимости в ответах ИИ, 19.11): числа только из базы, единицы цены не
 * смешиваются, сумм «за неделю» нет, отказ базы — «не загрузилось», а не «нет».
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TripCostView, WhenToGoView } from '@/components/seo/TripFactsPages';
import { charterCostWords, costByKind, fishByMonth, stayCostWords, toursByMonth, whenFaq } from '@/lib/seo/trip-cost';
import type { CostTourRow } from '@/lib/seo/trip-cost';

const sp = (v: unknown): string => String(v).replace(/[  ]/g, ' ');
const t = (o: Partial<CostTourRow>): CostTourRow => ({
  base_price: '45000', price_unit: 'per_person', activity_type: 'fishing', season_start: '2026-06-01', season_end: '2026-09-30', ...o,
});
const tours = [
  t({}),
  t({ base_price: '90000' }),
  t({ activity_type: 'helicopter', base_price: '120000', season_start: '2026-07-01', season_end: '2026-08-31' }),
  t({ activity_type: 'snowmobile', base_price: '300000', price_unit: 'per_tour', season_start: '2026-12-01', season_end: '2027-03-31' }),
  t({ activity_type: null, season_start: null, season_end: null }),
];
const carriers = [{ destinations: [{ from: 'А', to: 'Б', priceRub: 3500, note: null, conditions: null, validYear: null, place: null }, { from: 'А', to: 'В', priceRub: 60000, note: null, conditions: null, validYear: null, place: null }] }, { destinations: [] }];

describe('цены из базы', () => {
  it('туры по видам: число и вилка с единицей, неизвестный вид — в конце', () => {
    const k = costByKind(tours);
    expect(k[0]).toMatchObject({ count: 2 });
    expect(sp(k[0]!.prices)).toBe('от 45 000 ₽ до 90 000 ₽ за человека (2 тура)');
    expect(k[k.length - 1]!.label).toBe('Другие туры');
    expect(sp(k.find((x) => x.prices?.includes('за группу'))!.prices)).toBe('300 000 ₽ за группу (1 тур)');
  });
  it('жильё и машина: вилки и сколько объектов или направлений', () => {
    expect(sp(stayCostWords([{ price_per_night_from: '3000' }, { price_per_night_from: '18000' }, { price_per_night_from: null }]))).toBe('от 3 000 ₽ до 18 000 ₽ за ночь (2 объекта с ценой «от»)');
    expect(sp(charterCostWords(carriers))).toBe('от 3 500 ₽ до 60 000 ₽ за машину целиком (2 направления у 1 перевозчика)');
    expect(stayCostWords([])).toBeNull();
    expect(charterCostWords([])).toBeNull();
  });
});

describe('страница «Сколько стоит»', () => {
  it('числа, ссылка на планер, о перелёте — без цены, разметка FAQPage', () => {
    const html = sp(renderToStaticMarkup(<TripCostView data={{ tours, stays: [{ price_per_night_from: '3000' }], carriers }} />));
    expect(html).toContain('Сколько стоит поездка на Камчатку</h1>');
    expect(html).toContain('На Ведаре сейчас 5 туров местных операторов.');
    // Смету складывает конструктор /planner (после входа), а не /planning, где сметы нет (21.11).
    expect(html).toContain('href="/planner"');
    expect(html).not.toContain('href="/planning"');
    expect(html).toContain('Цен на билеты у Ведара нет');
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).not.toMatch(/за неделю[^»]*\d/);
  });
  it('отказ базы — «не загрузилось» в каждом блоке, а не «нет»', () => {
    const html = renderToStaticMarkup(<TripCostView data={{ tours: null, stays: null, carriers: null }} />);
    expect(html.match(/Не загрузилось: база не ответила/g)?.length).toBe(3);
    expect(html).not.toContain('Опубликованных туров сейчас нет');
    expect(html).not.toContain('data-trip-lead');
  });
  it('пусто — так и сказано', () => {
    const html = renderToStaticMarkup(<TripCostView data={{ tours: [], stays: [], carriers: [] }} />);
    expect(html).toContain('Опубликованных туров сейчас нет.');
    expect(html).toContain('Цен жилья на Ведаре сейчас нет.');
    expect(html).toContain('Прайсов перевозчиков на Ведаре сейчас нет.');
  });
});

describe('страница «Когда ехать»', () => {
  const fish = fishByMonth([{ name: 'Нерка', seasonMonths: [7, 8] }]);
  it('по месяцам: число туров и виды; сезон через Новый год; рыба из справочника', () => {
    const { months, unknown } = toursByMonth(tours);
    expect(unknown).toBe(1);
    expect(months[6]).toMatchObject({ month: 7, count: 3 });
    expect(months[0]).toMatchObject({ month: 1, count: 1 });
    expect(months[4]).toMatchObject({ month: 5, count: 0 });
    const html = renderToStaticMarkup(<WhenToGoView tours={tours} fish={fish} />);
    expect(html).toContain('Когда ехать на Камчатку</h1>');
    expect(html).toContain('рыба в сезоне: нерка');
    expect(html).toContain('У 1 тура сезон не записан');
  });
  it('лучший месяц — по числу туров и с оговоркой; зима — по зимним турам', () => {
    const faq = whenFaq(toursByMonth(tours).months, fish);
    expect(faq[0]!.a).toContain('больше всего их идёт: июль, август (3 тура)');
    expect(faq.find((f) => f.q === 'Можно ли ехать зимой?')!.a).toContain('Да: зимой (декабрь–март)');
  });
  it('туры не прочитались — «не загрузилось», и о зиме молчим', () => {
    const html = renderToStaticMarkup(<WhenToGoView tours={null} fish={fish} />);
    expect(html).toContain('Не загрузилось: база не ответила');
    expect(html).not.toContain('Можно ли ехать зимой?');
    expect(html).not.toContain('Зимних туров');
  });
});
