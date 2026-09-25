/**
 * Сторож фильтра `get_tours` (сверка MCP 25.09): «вулканы» — не тип тура, и
 * ответ «по типу нет» плюс полный каталог рыбалки читался как подмена.
 */
import { describe, it, expect } from 'vitest';
import { filterTourCatalog } from '@/lib/kuzmich/tour-filter';

const LABEL = (s: string) => ({ fishing: 'Рыбалка', rafting: 'Сплав' } as Record<string, string>)[s] ?? s;
const CTX = [
  'РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ:',
  'ID1: "Рыбалка на Большой" тип:fishing 3 дн. от 45 000 р/чел',
  'ID2: "Сплав по Быстрой" тип:rafting 1 дн. от 12 000 р/чел — с видом на вулканы Авачинской группы',
].join('\n');

describe('get_tours: слово туриста', () => {
  it('тип находится по русской метке', () => {
    const out = filterTourCatalog(CTX, 'рыбалка', LABEL);
    expect(out).toContain('ID1');
    expect(out).not.toContain('ID2');
  });

  it('не тип, но упомянуто в описании — показано с пометкой «тип другой»', () => {
    const out = filterTourCatalog(CTX, 'вулканы', LABEL);
    expect(out).toMatch(/^Тура с типом «вулканы» нет/);
    expect(out).toContain('ID2');
    expect(out).not.toContain('ID1');
  });

  it('нигде нет — сказано прямо, каталог только как замена с оговоркой', () => {
    const out = filterTourCatalog(CTX, 'гейзеры', LABEL);
    expect(out).toMatch(/^Туров «гейзеры» у операторов платформы сейчас нет/);
    expect(out).toContain('Не выдавай другие туры за такие');
  });
});
