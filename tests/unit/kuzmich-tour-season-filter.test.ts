/**
 * Тест 21.11, п. 2: «рыбалка на кижуча, сентябрь» — без «Осенней рыбалки
 * (октябрь–ноябрь)»; ничего в сезон — «в январе такого тура нет, ближайший — …».
 */
import { describe, it, expect } from 'vitest';
import { filterToursByMonth } from '@/lib/kuzmich/tour-season-filter';
import { monthsNamedIn } from '@/lib/tours/season-month';

const TEXT = [
  'РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ:',
  'ID10: "Летняя рыбалка на кижуча" тип:fishing от 28 000 ₽/чел. в день',
  'ID11: "Осенняя рыбалка (октябрь–ноябрь)" тип:fishing от 25 000 ₽/чел. в день',
  'ID12: "Рыбалка без сезона в базе" тип:fishing',
].join('\n');
const ENTRIES = new Map([
  ['10', { seasonStart: '2027-08-25', seasonEnd: '2027-09-30' }],
  ['11', { seasonStart: '2026-10-01', seasonEnd: '2026-11-30' }],
  ['12', { seasonStart: null, seasonEnd: null }],
]);

describe('get_tours по месяцу', () => {
  it('сентябрь: осенняя рыбалка скрыта, летняя и тур без сезона — на месте', () => {
    const out = filterToursByMonth(TEXT, ENTRIES, monthsNamedIn('рыбалка на кижуча, 4 дня, сентябрь'));
    expect(out.text).toContain('ID10:');
    expect(out.text).toContain('ID12:');
    expect(out.text).not.toContain('ID11:');
    expect(out.hidden).toEqual(['Осенняя рыбалка (октябрь–ноябрь)']);
    expect(out.text).toMatch(/Вне сезона в сентябре скрыто туров: 1/);
  });

  it('январь, всё вне сезона: честно «такого тура нет, ближайший — …»', () => {
    const only = new Map([...ENTRIES].filter(([id]) => id !== '12'));
    const text = TEXT.split('\n').filter((l) => !l.startsWith('ID12')).join('\n');
    const out = filterToursByMonth(text, only, [1]);
    expect(out.text).not.toMatch(/^ID\d+:/m);
    expect(out.text).toContain('В январе такого тура нет. Ближайший по сезону — «Летняя рыбалка на кижуча» (сезон: авг–сен)');
  });

  it('месяц не назван — список как был', () => {
    expect(filterToursByMonth(TEXT, ENTRIES, []).text).toBe(TEXT);
  });
});
