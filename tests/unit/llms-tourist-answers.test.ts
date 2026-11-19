// @vitest-environment node
/**
 * llms.txt: короткие ответы туристу (разбор видимости в ответах ИИ, 19.11).
 * Цена и сезон — из туров витрины тем же правилом, что FAQ посадочных;
 * туров нет — этих ответов нет; правила заповедника и МЧС — с источником.
 */
import { describe, it, expect } from 'vitest';
import { touristAnswersRu } from '@/lib/seo/tourist-answers';

const BASE = 'https://vedarai.ru';
const sp = (v: string) => v.replace(/[  ]/g, ' ');
const tour = (o: Partial<{ base_price: string; price_unit: string | null; season_start: string | null; season_end: string | null }>) => ({
  base_price: '45000', price_unit: 'per_person', season_start: '2026-06-01', season_end: '2026-09-30', ...o,
});

describe('короткие ответы туристу', () => {
  it('цена: вилка по единицам, число туров, ссылки на каталог и темы', () => {
    const text = sp(touristAnswersRu([tour({}), tour({ base_price: '120000', season_start: '2026-08-01', season_end: '2026-08-31' }), tour({ base_price: '300000', price_unit: 'per_tour' })], BASE));
    expect(text).toContain('**Сколько стоит тур на Камчатку?** В каталоге 3 тура местных операторов: от 45 000 ₽ до 120 000 ₽ за человека (2 тура); 300 000 ₽ за группу (1 тур).');
    expect(text).toContain(`[каталог](${BASE}/catalog)`);
  });
  it('сезон: месяцы по данным операторов и месяц, где туров больше всего', () => {
    const text = touristAnswersRu([tour({}), tour({ season_start: '2026-08-01', season_end: '2026-08-31' }), tour({ season_start: null, season_end: null })], BASE);
    expect(text).toContain('По данным операторов туры идут: июнь–сентябрь. Больше всего туров в месяце: август (2 тура). У 1 тура сезон не записан.');
  });
  it('туров нет — ни цены, ни сезона; правила с источником остаются', () => {
    const text = touristAnswersRu([], BASE);
    expect(text).not.toContain('Сколько стоит тур');
    expect(text).not.toContain('Когда ехать');
    expect(text).toContain('приказ № 24-П от 29.01.2026');
    expect(text).toContain('https://kronoki.ru/ru/visit/information-for-all/rules/447.html');
    expect(text).toContain('за 10 рабочих дней');
    expect(text).toContain(`${BASE}/register`);
  });
  it('о перелёте не выдумывает цену', () => {
    expect(touristAnswersRu([], BASE)).toContain('Цен на билеты у Ведара нет');
  });
});

describe('/llms.txt: раздел ответов в самом файле', () => {
  it('раздел есть; непосчитанного «лучшего сезона» и «авиабилетов» на табло задержек нет', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
    const { GET } = await import('@/app/llms.txt/route');
    const text = await (await GET()).text();
    expect(text).toContain('## Короткие ответы туристу');
    expect(text).toContain('приказ № 24-П от 29.01.2026');
    expect(text).not.toMatch(/лучший сезон для туристов — июнь–сентябрь/);
    expect(text).not.toContain('[авиабилеты на Камчатку]');
    expect(text).toContain('[табло аэропорта](https://vedarai.ru/flights)');
  });
});
