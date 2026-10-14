/**
 * Указатель мест под картой /map (14.10) — вызовом группировки и загрузчика,
 * рендером блока и разбором дерева страницы (правило 13.10).
 *
 * Перепись sitemap 12 (14.10): у /map 12 слов в серверном HTML — карта
 * рисуется в браузере, и под запрос «карта Камчатки» поисковику читать было
 * нечего. Теперь под картой все видимые места по типам ссылками на карточки;
 * условие видимости — как у sitemap, чтобы ссылка не вела в 308 или 404.
 */
import React, { Suspense, type ReactElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...args: unknown[]) => query(...args) } }));
vi.mock('@/app/map/_MapPageClient', () => ({ default: () => null }));

import { groupPlaces, loadMapPlacesIndex, type MapIndexRow } from '@/lib/map/places-index';
import { MapPlacesIndex, MapPlacesIndexSection } from '@/components/map/MapPlacesIndex';
import MapPage, { metadata } from '@/app/map/page';
import MapPageClient from '@/app/map/_MapPageClient';

const ROWS: MapIndexRow[] = [
  { ark_id: 'a1', slug: 'koryakskaya-sopka', name: 'Корякская сопка', location_type: 'volcano' },
  { ark_id: 'a2', slug: 'avachinskaya-sopka', name: 'Авачинская сопка', location_type: 'volcano' },
  { ark_id: 'a3', slug: null, name: 'Халактырский пляж', location_type: 'beach' },
  { ark_id: 'a4', slug: 'paratunka', name: 'Паратунка', location_type: 'hot_spring' },
  { ark_id: 'a5', slug: 'nalychevo', name: 'Налычево', location_type: 'hot_spring' },
  { ark_id: 'a6', slug: 'zhupanovo', name: 'Жупаново', location_type: null },
  { ark_id: 'a7', slug: 'kamen', name: 'Камень', location_type: 'other' },
  { ark_id: 'a8', slug: 'bez-imeni', name: '   ', location_type: 'lake' },
];

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  query.mockReset();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  errors.mockRestore();
});

describe('группировка: те же места, что на карте, по типам', () => {
  it('больше мест — выше, равные — по названию типа, «Другие места» — в конце', () => {
    const index = groupPlaces(ROWS);
    expect(index.groups.map((g) => [g.label, g.places.length])).toEqual([
      ['Вулкан', 2], ['Термальный источник', 2], ['Пляж', 1], ['Другие места', 2],
    ]);
    expect(index.total).toBe(7);
  });

  it('внутри типа — по алфавиту; адрес — slug, а без него ark_id, как в sitemap; пустое имя — не ссылка', () => {
    const index = groupPlaces(ROWS);
    expect(index.groups[0].places).toEqual([
      { name: 'Авачинская сопка', href: '/places/avachinskaya-sopka' },
      { name: 'Корякская сопка', href: '/places/koryakskaya-sopka' },
    ]);
    expect(index.groups.find((g) => g.type === 'beach')?.places).toEqual([{ name: 'Халактырский пляж', href: '/places/a3' }]);
    expect(index.groups.some((g) => g.type === 'lake')).toBe(false);
  });

  it('мест нет — пустой указатель, а не выдуманная группа', () => {
    expect(groupPlaces([])).toEqual({ total: 0, groups: [] });
  });
});

describe('загрузчик: видимость как у sitemap, отказ — не «мест нет»', () => {
  it('берёт видимые и не слитые места', async () => {
    query.mockResolvedValueOnce({ rows: ROWS });
    expect(await loadMapPlacesIndex()).toEqual(groupPlaces(ROWS));
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/is_visible\s*=\s*TRUE/);
    expect(sql).toMatch(/merged_into_id IS NULL/);
  });

  it('база не ответила — null и строка в логе с SQLSTATE (§4.0)', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    expect(await loadMapPlacesIndex()).toBeNull();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('указатель мест'), expect.objectContaining({ code: '57P01' }));
  });
});

describe('блок под картой', () => {
  it('заголовок, число мест, тип — заголовком группы, место — ссылкой на карточку', () => {
    const { container } = render(<MapPlacesIndex index={groupPlaces(ROWS)} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Места на карте Камчатки' })).toBeTruthy();
    expect(container.textContent).toContain('На карте — 7 мест.');
    const summaries = [...container.querySelectorAll('details > summary')];
    expect(summaries.map((s) => s.querySelector('h3')?.textContent)).toEqual(['Вулкан', 'Термальный источник', 'Пляж', 'Другие места']);
    const links = [...container.querySelectorAll('a[href]')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toHaveLength(7);
    expect(links).toContainEqual(['Халактырский пляж', '/places/a3']);
    expect(links[0]).toEqual(['Авачинская сопка', '/places/avachinskaya-sopka']);
  });

  it('одно место — «1 место», не «1 мест»', () => {
    const { container } = render(<MapPlacesIndex index={groupPlaces(ROWS.slice(0, 1))} />);
    expect(container.textContent).toContain('На карте — 1 место.');
  });

  it('чтение не удалось или мест нет — блока нет, карта и без него работает', () => {
    expect(render(<MapPlacesIndex index={null} />).container.innerHTML).toBe('');
    cleanup();
    expect(render(<MapPlacesIndex index={{ total: 0, groups: [] }} />).container.innerHTML).toBe('');
  });

  it('загрузка и вывод вместе: из базы — ссылками; отказ — пусто и строка в логе', async () => {
    query.mockResolvedValueOnce({ rows: ROWS });
    const { container } = render(await MapPlacesIndexSection());
    expect(container.querySelectorAll('a[href^="/places/"]')).toHaveLength(7);
    cleanup();
    query.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: '57014' }));
    expect(render(await MapPlacesIndexSection()).container.innerHTML).toBe('');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('указатель мест'), expect.objectContaining({ code: '57014' }));
  });
});

/** Путь от корня до элемента данного типа: типы предков, сам элемент последним. */
function pathTo(node: ReactNode, target: unknown, trail: unknown[] = []): unknown[] | null {
  if (!React.isValidElement(node)) {
    if (Array.isArray(node)) for (const n of node) { const p = pathTo(n, target, trail); if (p) return p; }
    return null;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  const here = [...trail, el.type];
  if (el.type === target) return here;
  return pathTo(el.props.children, target, here);
}

describe('страница /map', () => {
  it('указатель — под картой и своей границей ожидания: разметку карты запрос к базе не держит', () => {
    const tree = MapPage();
    const index = pathTo(tree, MapPlacesIndexSection);
    expect(index).not.toBeNull();
    expect(index).toContain(Suspense);
    const map = pathTo(tree, MapPageClient);
    expect(map).not.toBeNull();
    expect(map).not.toContain(Suspense);
  });

  it('заголовок — запрос целиком, описание — без цифр и в пределах сниппета', () => {
    expect(metadata.title).toBe('Карта Камчатки с достопримечательностями');
    const d = String(metadata.description);
    expect(d.length).toBeGreaterThanOrEqual(70);
    expect(d.length).toBeLessThanOrEqual(160);
    expect(d).not.toMatch(/\d/);
  });
});
