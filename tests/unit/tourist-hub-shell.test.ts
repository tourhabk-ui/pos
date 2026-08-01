/**
 * Гибрид-оболочка кабинета туриста (решение владельца 01.08).
 *
 * Аудит ЛК вскрыл: кабинет туриста жил в HubLayout как back-office
 * (сайдбар + своя шапка, без платформенного BottomNav). На мобиле тап
 * «Поездки» в нижнем баре уводил в кабинет, и бар исчезал — «Поездки»
 * была дверью в один конец, а Дом/Карта/Кузьмич становились недостижимы.
 *
 * Гибрид: турист получает BottomNav на мобиле (кабинет = продолжение
 * приложения), оператор/админ/гид остаются back-office без бара. Сторож
 * держит и включение (турист), и НЕвключение (чужие роли не должны
 * получить нижний бар в своём рабочем столе).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LAYOUT = readFileSync(join(process.cwd(), 'components/layout/HubLayout.tsx'), 'utf-8');
const code = LAYOUT.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('гибрид-оболочка: BottomNav только туристу', () => {
  it('BottomNav импортирован и рендерится под условием роли', () => {
    expect(code).toContain("import BottomNav from '@/components/shared/BottomNav'");
    expect(code, 'BottomNav рендерится безусловно — он попадёт и в back-office операторов/админов')
      .toMatch(/isTourist\s*&&[\s\S]{0,120}<BottomNav/);
  });

  it('признак туриста берётся из requiredRole, а не хардкодом пути', () => {
    expect(code).toMatch(/const isTourist =[\s\S]{0,80}\.includes\('tourist'\)/);
  });

  it('«Поездки» подсвечена на всём /hub/tourist/*', () => {
    // Кабинет живёт под вкладкой «Поездки»; иначе ни одна вкладка не активна.
    expect(code).toMatch(/startsWith\('\/hub\/tourist'\)\s*\?\s*'\/hub\/tourist\/trips'/);
  });

  it('контент получает запас снизу под бар только у туриста на мобиле', () => {
    // Без padding последний блок прячется за фиксированным баром; на desktop
    // бара нет — pb только мобильный.
    expect(code).toMatch(/isTourist \? ' pb-24 md:pb-0' : ''/);
  });
});
