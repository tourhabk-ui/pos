/**
 * Петля самоулучшения ремонта данных: анализатор предлагает драфты правил
 * из результатов прогона, ничего не меняя сам. Дедуп — по сигнатуре.
 */

import { describe, it, expect } from 'vitest';
// CJS-скрипт раннера — импортируется как модуль
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildProposal, outlierRoute } = require('../../scripts/propose-repair-steps.js');

const wp = (place: string, km: number, route: string) => ({
  step: 'wp_outlier',
  place,
  detail: `${km} км от маршрута «${route}» — проверить связку`,
});

describe('propose-repair-steps — анализатор паттернов прогона', () => {
  it('outlierRoute разбирает название маршрута из detail', () => {
    expect(outlierRoute('95 км от маршрута «Бухта Русская» — проверить связку')).toBe('Бухта Русская');
    expect(outlierRoute('мусор')).toBeNull();
  });

  it('маршрут с 3+ дальними waypoints попадает в предложение, с 2 — нет', () => {
    const apply = { items: [
      wp('А', 100, 'Обзорная статья'), wp('Б', 90, 'Обзорная статья'), wp('В', 80, 'Обзорная статья'),
      wp('Г', 70, 'Честный маршрут'), wp('Д', 60, 'Честный маршрут'),
    ] };
    const out = buildProposal(apply, {});
    expect(out).toContain('«Обзорная статья»');
    expect(out).not.toContain('«Честный маршрут»');
    expect(out).toMatch(/<!-- sig:[a-f0-9]{16} -->/);
  });

  it('пары друг на друге (<=50 м) и скрытые без координат попадают в предложение', () => {
    const apply = { items: [
      { step: 'coords', place: 'Гора Кэнгынэй', detail: 'координата не восстановилась — скрыто до ручной проверки' },
    ] };
    const inv = { sections: [
      { id: 'places_coord_dupes', rows: [
        { name_a: 'Дранкинские термальные источники', name_b: 'Кордон озеро Паланское', km: '0.00' },
        { name_a: 'Соседи по кварталу', name_b: 'Через дорогу', km: '0.13' },
      ] },
    ] };
    const out = buildProposal(apply, inv);
    expect(out).toContain('Дранкинские');
    // 130 м — не «друг на друге», в предложение не идёт
    expect(out).not.toContain('Соседи по кварталу');
    expect(out).toContain('Гора Кэнгынэй');
  });

  it('нечего предлагать — null (issue не открывается)', () => {
    expect(buildProposal({ items: [] }, { sections: [] })).toBeNull();
    expect(buildProposal({}, {})).toBeNull();
  });

  it('одинаковый вход даёт одинаковую сигнатуру, разный — разную', () => {
    const apply = { items: [wp('А', 100, 'X'), wp('Б', 90, 'X'), wp('В', 80, 'X')] };
    const a = buildProposal(apply, {});
    const b = buildProposal(apply, {});
    expect(a).toBe(b);
    const c = buildProposal({ items: [...apply.items, wp('Г', 70, 'X')] }, {});
    expect(c).not.toBe(a);
  });
});
