/**
 * Лента «Исследовать»: разные типы мест, порядок каталога внутри типа.
 * Шапка — lib/home/explore-variety.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { varietyByType } from '@/lib/home/explore-variety';

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
  it('fetchExplore зовёт varietyByType поверх выдачи каталога с запасом', () => {
    const data = readFileSync(join(process.cwd(), 'app/_home/data.ts'), 'utf-8');
    const at = data.indexOf('export async function fetchExplore');
    const body = data.slice(at, data.indexOf('\n}\n', at));
    expect(body).toMatch(/queryCatalog\(\{ kind: 'place', page: 1, limit: EXPLORE_POOL, sort: 'recommended' \}\)/);
    expect(body).toContain('varietyByType(items, EXPLORE_LIMIT)');
  });
});
