/**
 * Меню шапки — шесть пунктов (решение владельца 25.09: «да, сократи меню»).
 *
 * Десять пунктов плюс шесть иконок делали шапку плотной, как панель
 * приборов. Держит: пунктов не больше шести, «Туры» первым, а снятые —
 * Подборки, Жильё, «Приложения в дорогу», Операторы — по-прежнему достижимы через «Ещё»
 * (реестр lib/navigation/platform-links), а не потеряны.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEADER_NAV } from '@/components/layout/Header';

describe('меню шапки', () => {
  it('не больше семи пунктов, «Туры» первым, Кузьмич в шапке (21.11)', () => {
    expect(HEADER_NAV.length).toBeLessThanOrEqual(7);
    expect(HEADER_NAV.some((i) => i.href === '/kuzmich')).toBe(true);
    expect(HEADER_NAV[0]).toEqual({ href: '/catalog', label: 'Туры' });
  });

  it('снятые пункты достижимы через «Ещё»', () => {
    const registry = readFileSync(join(process.cwd(), 'lib/navigation/platform-links.ts'), 'utf-8');
    for (const href of ['/collections', '/accommodations', '/prilozheniya', '/operators']) {
      expect(registry, `${href} пропал из «Ещё»`).toContain(`href: '${href}'`);
    }
  });

  it('шапка рендерит именно HEADER_NAV, а не свой список', () => {
    const src = readFileSync(join(process.cwd(), 'components/layout/Header.tsx'), 'utf-8');
    expect(src).toMatch(/\{HEADER_NAV\.map\(item =>/);
  });
});
