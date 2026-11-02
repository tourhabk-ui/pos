import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('app/routes/_RoutesPageClient.tsx', 'utf8');

describe('тулбар Мест/Маршрутов (02.11)', () => {
  it('поиск своей строкой на телефоне, с плейсхолдером; сорт не обрезан', () => {
    expect(src).toContain('basis-full sm:basis-auto flex-1');
    expect(src).toContain("'Поиск мест…'");
    expect(src).not.toContain('max-w-[8.5rem]');
  });
  it('на телефоне кнопка фильтров — иконка и счётчик, слово для экранного чтеца; сорт помещается', () => {
    expect(src).toMatch(/sr-only sm:not-sr-only">Фильтры/);
    expect(src).toMatch(/sm:hidden tabular-nums">\{activeFiltersCount\}/);
  });
  it('Парки и Виды остаются на виду (не в окне фильтров)', () => {
    const panel = src.slice(src.indexOf('{showFilters && ('), src.indexOf('{toursSlot}'));
    expect(panel).not.toContain('ParksStrip');
    expect(panel).not.toContain('CategoriesStrip');
    expect(src).toMatch(/ParksStrip initialParks=/);
    expect(src).toMatch(/CategoriesStrip categories=/);
  });
});
