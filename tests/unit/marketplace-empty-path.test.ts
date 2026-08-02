/**
 * Маркетплейс: пустое состояние — путь, а не тупик (план 02.08, №2).
 *
 * С ~20 турами фильтр легко даёт 0 результатов, и «Туры не найдены» был
 * дедэндом (только сброс фильтров). Но Камчатка на платформе — это сотни
 * маршрутов и мест: тупик обязан вести к ним и к планировщику, иначе турист
 * решает «тут ничего нет». Готовые туры — слой, ядро — маршруты/места.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'components/marketplace/MarketplaceClient.tsx'), 'utf-8');

describe('пустой маркетплейс ведёт к маршрутам и планировщику', () => {
  it('есть ссылка на все маршруты', () => {
    expect(src.includes('href="/routes"')).toBe(true);
    expect(src.includes('Все маршруты')).toBe(true);
  });
  it('есть ссылка в планировщик — собрать поездку', () => {
    expect(src.includes('href="/planner"')).toBe(true);
    expect(src.includes('Собрать поездку')).toBe(true);
  });
  it('копирайт честный и качественный (без хардкод-чисел): «сотни маршрутов и мест»', () => {
    expect(src).toMatch(/не только готовые туры/);
    // Качественное «сотни» вместо конкретного числа — оно не устаревает.
    expect(src).toMatch(/сотни маршрутов и мест/);
  });
});
