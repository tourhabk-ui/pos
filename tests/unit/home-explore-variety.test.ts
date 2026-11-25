/**
 * Лента «Исследовать»: разные типы мест, порядок каталога внутри типа.
 * Шапка — lib/home/explore-variety.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CatalogFilters, CatalogInternal } from '@/lib/routes/catalog-query';
import { varietyByType } from '@/lib/home/explore-variety';

const { queryCatalog } = vi.hoisted(() => ({ queryCatalog: vi.fn() }));
vi.mock('@/lib/routes/catalog-query', async () => {
  const actual = await vi.importActual<typeof import('@/lib/routes/catalog-query')>('@/lib/routes/catalog-query');
  return { ...actual, queryCatalog };
});

const p = (title: string, locationType: string | null) => ({ title, locationType });

// Дословно начало выдачи каталога 29.09: восемь вулканов подряд, дальше прочее.
const CATALOG = [
  p('Крашенинникова', 'volcano'), p('Айнелькан', 'volcano'), p('Академии Наук', 'volcano'),
  p('Ичинский', 'volcano'), p('Асача', 'volcano'), p('Алаид', 'volcano'),
  p('Чашаконджа', 'volcano'), p('Желтовская', 'volcano'),
  p('Долина гейзеров', 'geyser'), p('Озеро Толмачева', 'lake'), p('Дикие озерки', 'hot_spring'),
  p('Озеро Высокое', 'lake'),
];

describe('varietyByType', () => {
  it('восемь вулканов подряд превращаются в ленту из разных типов', () => {
    const out = varietyByType(CATALOG, 8).map((x) => x.title);
    expect(out).toEqual([
      'Крашенинникова', 'Долина гейзеров', 'Озеро Толмачева', 'Дикие озерки',
      'Айнелькан', 'Озеро Высокое', 'Академии Наук', 'Ичинский',
    ]);
  });

  it('внутри типа порядок каталога не меняется', () => {
    const volcanoes = varietyByType(CATALOG, 8).filter((x) => x.locationType === 'volcano').map((x) => x.title);
    expect(volcanoes).toEqual(['Крашенинникова', 'Айнелькан', 'Академии Наук', 'Ичинский']);
  });

  it('мест меньше лимита — отдаёт все, ничего не выдумывает', () => {
    expect(varietyByType([p('А', 'lake')], 8)).toHaveLength(1);
    expect(varietyByType([], 8)).toEqual([]);
  });

  it('место без типа — своя группа, а не «вулкан по умолчанию»', () => {
    const out = varietyByType([p('А', 'volcano'), p('Б', 'volcano'), p('В', null)], 2);
    expect(out.map((x) => x.title)).toEqual(['А', 'В']);
    expect(out[1].locationType).toBeNull();
  });
});

describe('главная берёт ленту через раскладку по типам', () => {
  it('fetchExplore раскладывает по типам выдачу каталога, взятую с запасом', async () => {
    // Вызовом, а не поиском строки (правило 13.10): 25.11 в ленту встали места
    // владельца (lib/home/explore-pinned), и текст функции поменялся, а правило
    // раскладки — нет. Здесь мест владельца нет — видна одна раскладка.
    queryCatalog.mockImplementation(async (_f: CatalogFilters, internal?: CatalogInternal) => ({
      items: internal?.placeIds ? [] : CATALOG.map((x, i) => ({
        ...x, id: `id-${i}`, description: '', imageUrl: null, urlSlug: null,
      })),
    }));
    const { fetchExplore, EXPLORE_LIMIT } = await import('@/app/_home/data');
    const out = await fetchExplore();
    expect(out.map((x) => x.title)).toEqual(varietyByType(CATALOG, EXPLORE_LIMIT).map((x) => x.title));
    const poolCall = queryCatalog.mock.calls.find((c) => !(c[1] as CatalogInternal | undefined)?.placeIds);
    expect(poolCall?.[0]).toMatchObject({ kind: 'place', page: 1, sort: 'recommended' });
    expect((poolCall?.[0] as CatalogFilters).limit, 'выдача без запаса').toBeGreaterThan(EXPLORE_LIMIT);
  });
});
