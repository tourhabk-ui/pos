/**
 * Мобильная навигация кабинета агента — сетка иконок по разделам.
 *
 * HubSidebar выбирает мобильный режим по наличию `section` у пунктов: с
 * разделами — сворачиваемый grid-лаунчер (как в админке), без — горизонтальная
 * лента. У агента 10 пунктов и разделов не было: лента вылезала за экран, и
 * Сделки/Комиссии/Ваучеры/Рефералы/Статистика/Профиль жили за правым краем —
 * фактически невидимые разделы. Тест сторожит, чтобы секции не потерялись.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const LAYOUT = readFileSync(join(process.cwd(), 'app/hub/agent/layout.tsx'), 'utf-8');

/** Строки-пункты SIDEBAR_ITEMS: { href: '...', ... }. */
function sidebarLines(): string[] {
  return LAYOUT.split('\n').filter(l => /\{\s*href:\s*'\/hub\/agent/.test(l));
}

describe('навигация кабинета агента', () => {
  it('пунктов достаточно много, чтобы лента без секций не влезала (регресс-контекст)', () => {
    expect(sidebarLines().length).toBeGreaterThanOrEqual(8);
  });

  it('у каждого пункта, кроме Обзора, задан section — иначе мобила откатится в ленту', () => {
    const withoutSection = sidebarLines().filter(
      l => !/section:/.test(l) && !/label:\s*'Обзор'/.test(l),
    );
    expect(withoutSection, `пункты без section:\n${withoutSection.join('\n')}`).toEqual([]);
  });

  it('Обзор — сверху и без раздела (паттерн админки)', () => {
    const first = sidebarLines()[0];
    expect(first).toContain("'Обзор'");
    expect(first).not.toContain('section:');
  });
});
