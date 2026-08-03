/**
 * Нижняя навигация: 4-й пункт — «Туры» (/catalog, витрина operator_tours).
 * Раньше был «Поездки»; на телефоне коммерция была спрятана (туров не было ни в
 * навигации, ни на главной) — вход в туры вернули в таб-бар (решение владельца).
 * Кузьмич по центру и «На маршруте» — не трогаем. Профиль/СОС в таб-баре нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'components/shared/BottomNav.tsx'), 'utf-8');
const items = src.slice(src.indexOf('const ITEMS'), src.indexOf('interface BottomNavProps'));

describe('таб-бар: вход в туры', () => {
  it('есть пункт «Туры» на /catalog', () => {
    expect(items).toMatch(/label: 'Туры',\s*href: '\/catalog'/);
    expect(items).toContain("activeOn: ['/catalog', '/marketplace']");
  });
  it('«Поездки» больше не в таб-баре (доступны из ЛК)', () => {
    expect(items).not.toContain("label: 'Поездки'");
    expect(items).not.toContain('/hub/tourist/trips');
  });
  it('Кузьмич по центру (3-й из 5) и «На маршруте» на месте', () => {
    const labels = [...items.matchAll(/label: '([^']+)'/g)].map(m => m[1]);
    expect(labels).toEqual(['Дом', 'Карта', 'Кузьмич', 'Туры', 'На маршруте']);
  });
});
