import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('app/routes/_RoutesPageClient.tsx', 'utf8');

describe('тулбар Мест/Маршрутов (02.11)', () => {
  it('поиск своей строкой на телефоне, с плейсхолдером; сорт не обрезан', () => {
    expect(src).toContain('basis-full sm:basis-auto flex-1');
    expect(src).toContain("'Поиск мест…'");
    expect(src).not.toContain('max-w-[8.5rem]');
  });
  it('счётчик активных фильтров виден и на телефоне', () => {
    expect(src).toMatch(/Фильтры\{activeFiltersCount > 0/);
  });
  it('Парки и Виды остаются на виду (не в окне фильтров)', () => {
    const panel = src.slice(src.indexOf('{showFilters && ('), src.indexOf('{toursSlot}'));
    expect(panel).not.toContain('ParksStrip');
    expect(panel).not.toContain('CategoriesStrip');
    expect(src).toMatch(/ParksStrip initialParks=/);
    expect(src).toMatch(/CategoriesStrip categories=/);
  });
});
