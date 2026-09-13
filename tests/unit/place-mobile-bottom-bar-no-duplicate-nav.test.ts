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
 * действие дважды на одном экране.
 *
 * 13.09 правка пошла дальше: чужих навигаторов на карточке нет вовсе
 * (владелец: «кнопка навигация до сих пор открывает сторонние сервисы»).
 * geo: из PlaceActionBar и om:// из MobileBottomBar сняты оба — дорогу
 * считает свой граф. Разделение труда осталось прежним: шапка даёт
 * ДЕЙСТВИЕ (построить путь), нижний бар — ФАЙЛ (унести точку с собой),
 * и одинаковых CTA по-прежнему не два.
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

  it('«Навигация» в шапке — свой расчёт, не чужое приложение', () => {
    // Ищем ПЕРЕХОД, а не слово: комментарий в файле сам объясняет, что здесь
    // стояло раньше, и запрет на упоминание сделал бы объяснение невозможным.
    expect(ACTION_BAR).not.toMatch(/href=\{?[`'"]geo:/);
    expect(ACTION_BAR).toContain('OWN_ROUTE_EVENT');
  });

  it('MobileBottomBar не несёт geo:-ссылку и текст «Навигация» — это уже есть в PlaceActionBar', () => {
    const bar = bodyOf('MobileBottomBar', CLIENT);
    expect(bar).not.toMatch(/href=\{?[`'"]geo:/);
    expect(bar).not.toContain('Навигация');
  });

  it('MobileBottomBar несёт ФАЙЛ, а не второе такое же действие', () => {
    // Organic Maps deep link (om://) снят 13.09. Слово «оффлайн» было там к
    // тому же чужой заслугой: обещать офлайн через приложение, которого у
    // человека может не стоять, — обещание за чужой счёт. GPX не зависит ни
    // от какой установленной программы.
    const bar = bodyOf('MobileBottomBar', CLIENT);
    expect(bar).not.toMatch(/href=\{?[`'"]om:\/\//);
    expect(bar).toContain('/gpx');
    expect(bar).toContain('download');
  });

  it('MobileBottomBar остаётся md:hidden — на десктопе не рисуется вовсе', () => {
    const bar = bodyOf('MobileBottomBar', CLIENT);
    expect(bar).toMatch(/md:hidden/);
  });
});
