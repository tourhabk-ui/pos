/**
 * Карточка места на мобильном не должна показывать два одинаковых CTA
 * «Навигация» одновременно (владелец 07.09, скрин: «почему 2 кнопки
 * навигация? и ни одна не ведёт на наш ресурс»).
 *
 * `PlaceActionBar` (components/places/PlaceActionBar.tsx) рендерится БЕЗ
 * responsive-скрытия — значит виден и на мобильном, и там уже есть sticky
 * «Навигация» на тот же geo:-адрес. `MobileBottomBar` (только внутри
 * _PlaceDetailClient.tsx, `md:hidden` — то есть виден именно на мобильном)
 * держал СВОЙ второй такой же CTA — человек на телефоне видел одно и то же
 * действие дважды на одном экране. Сторож держит: geo: живёт только в
 * PlaceActionBar, MobileBottomBar несёт то, чего там нет — Organic Maps.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CLIENT = readFileSync(join(ROOT, 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf-8');
const ACTION_BAR = readFileSync(join(ROOT, 'components/places/PlaceActionBar.tsx'), 'utf-8');

function bodyOf(fnName: string, src: string): string {
  const at = src.indexOf(`function ${fnName}(`);
  expect(at, `${fnName} не найдена в файле`).toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', at);
  return src.slice(at, end > -1 ? end : undefined);
}

describe('карточка места — «Навигация» не дублируется на мобильном', () => {
  it('PlaceActionBar виден без responsive-скрытия (значит и на мобильном тоже)', () => {
    expect(ACTION_BAR).toContain('Навигация');
    expect(ACTION_BAR).not.toMatch(/hidden md:|md:hidden/);
  });

  it('MobileBottomBar не несёт geo:-ссылку и текст «Навигация» — это уже есть в PlaceActionBar', () => {
    const bar = bodyOf('MobileBottomBar', CLIENT);
    expect(bar).not.toContain('geo:');
    expect(bar).not.toContain('Навигация');
  });

  it('MobileBottomBar по-прежнему держит Organic Maps deep link — единственное, чего нет в PlaceActionBar', () => {
    const bar = bodyOf('MobileBottomBar', CLIENT);
    expect(bar).toContain('om://map');
    expect(bar).toContain('Оффлайн');
  });

  it('MobileBottomBar остаётся md:hidden — на десктопе не рисуется вовсе', () => {
    const bar = bodyOf('MobileBottomBar', CLIENT);
    expect(bar).toMatch(/md:hidden/);
  });
});
