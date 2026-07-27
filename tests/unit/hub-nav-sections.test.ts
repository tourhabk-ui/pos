/**
 * Мобильная навигация кабинетов ролей — сетка иконок по разделам.
 *
 * HubSidebar выбирает мобильный режим по наличию `section` у пунктов: с
 * разделами — сворачиваемый grid-лаунчер иконок (как в админке), без —
 * горизонтальная лента. У оператора (17 пунктов), туриста (15) и агента (10)
 * лента вылезала за экран: всё после четвёртого пункта жило за правым краем —
 * фактически невидимые разделы. Инвариант: в каждом кабинете у каждого пункта,
 * кроме «Обзор», задан section — иначе мобила молча откатится в ленту.
 *
 * Админка не в списке: у неё секции с рождения, и её стережёт сама структура
 * (45+ пунктов без групп никто не соберёт заново случайно).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const HUB_LAYOUTS = [
  'app/hub/agent/layout.tsx',
  'app/hub/operator/layout.tsx',
  'app/hub/tourist/layout.tsx',
  'app/hub/guide/layout.tsx',
  'app/hub/gear/layout.tsx',
  'app/hub/stay/layout.tsx',
  'app/hub/transfer-operator/layout.tsx',
];

/** Строки-пункты SIDEBAR_ITEMS: { href: '...', ... }. */
function sidebarLines(src: string): string[] {
  return src.split('\n').filter(l => /^\s*\{\s*href:\s*'/.test(l));
}

describe.each(HUB_LAYOUTS)('%s', (path) => {
  const src = readFileSync(join(process.cwd(), path), 'utf-8');
  const lines = sidebarLines(src);

  it('пункты меню найдены', () => {
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it('у каждого пункта задана иконка', () => {
    const withoutIcon = lines.filter(l => !/icon:\s*\w+/.test(l));
    expect(withoutIcon, `пункты без icon:\n${withoutIcon.join('\n')}`).toEqual([]);
  });

  it('у каждого пункта, кроме Обзора, задан section', () => {
    const withoutSection = lines.filter(
      l => !/section:/.test(l) && !/label:\s*'Обзор'/.test(l),
    );
    expect(withoutSection, `пункты без section:\n${withoutSection.join('\n')}`).toEqual([]);
  });

  it('Обзор — первый пункт и без раздела (паттерн админки)', () => {
    expect(lines[0]).toContain("'Обзор'");
    expect(lines[0]).not.toContain('section:');
  });
});
