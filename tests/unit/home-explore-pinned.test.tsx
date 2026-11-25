/**
 * Лента «Исследовать» на главной: места владельца первыми (слово владельца
 * 25.11: «давай в Карточки мест на главную добавим еще карточки три брата и
 * маяк»), за ними — восемь мест каталога, как раньше.
 *
 * Здесь — вызов самой сборки ленты (`fetchExplore`) с подменённым каталогом
 * и рендер колоды, которую из этой ленты рисует главная. Что отбор по номеру
 * места выполняется на схеме прода и не отдаёт скрытое, слитое и маршрут,
 * держит сцена «места владельца для главной» в
 * tests/integration/catalog-place-type.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { CatalogFilters, CatalogInternal } from '@/lib/routes/catalog-query';

const { queryCatalog } = vi.hoisted(() => ({ queryCatalog: vi.fn() }));
vi.mock('@/lib/routes/catalog-query', async () => {
  const actual = await vi.importActual<typeof import('@/lib/routes/catalog-query')>('@/lib/routes/catalog-query');
  return { ...actual, queryCatalog };
});
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { fetchExplore, EXPLORE_LIMIT } from '@/app/_home/data';
import { EXPLORE_PINNED_PLACES, exploreWithPinned } from '@/lib/home/explore-pinned';
import { PlaceSwipeDeck } from '@/components/places/PlaceSwipeDeck';

interface Item { id: string; title: string; locationType: string | null; description: string; imageUrl: string | null; urlSlug: string | null }
const item = (id: string, title: string, locationType: string): Item =>
  ({ id, title, locationType, description: `${title}: описание`, imageUrl: null, urlSlug: id });

const TRI_BRATA = item('ark-tri', 'Скалы Три Брата', 'rock');
const MAYAK = item('ark-mayak', 'Маяк Петропавловский', 'historical');
// Каталог: десять мест разных типов, и «Три Брата» среди них — повтора быть не должно.
const POOL = [
  item('v1', 'Вулкан Горелый', 'volcano'), item('l1', 'Озеро Курильское', 'lake'),
  TRI_BRATA, item('h1', 'Паратунка', 'hot_spring'), item('w1', 'Водопад Спокойный', 'waterfall'),
  item('b1', 'Бухта Русская', 'bay'), item('v2', 'Вулкан Мутновский', 'volcano'),
  item('l2', 'Озеро Кроноцкое', 'lake'), item('r1', 'Река Быстрая', 'river'), item('m1', 'Гора Морозная', 'mountain'),
];

function catalog(pool: () => Promise<{ items: Item[] }>, pinned: () => Promise<{ items: Item[] }>) {
  queryCatalog.mockImplementation((_f: CatalogFilters, internal?: CatalogInternal) =>
    internal?.placeIds ? pinned() : pool());
}

let err: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  queryCatalog.mockReset();
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  err.mockRestore();
  warn.mockRestore();
});

describe('места владельца в ленте «Исследовать»', () => {
  it('список — Скалы Три Брата и Маяк Петропавловский по номерам мест, в этом порядке', () => {
    expect(EXPLORE_PINNED_PLACES).toEqual([
      { placeId: 'e265d0f0-8187-4d7a-b0e4-fe9be5a2d9e0', name: 'Скалы Три Брата' },
      { placeId: '0aa97c3c-c4d7-496d-a879-7fa065d7f8de', name: 'Маяк Петропавловский' },
    ]);
  });

  it('первыми — места владельца, за ними восемь мест каталога без повтора', async () => {
    catalog(async () => ({ items: POOL }), async () => ({ items: [TRI_BRATA, MAYAK] }));
    const lenta = await fetchExplore();
    expect(lenta.map((p) => p.title).slice(0, 2)).toEqual(['Скалы Три Брата', 'Маяк Петропавловский']);
    expect(lenta).toHaveLength(2 + EXPLORE_LIMIT);
    expect(lenta.filter((p) => p.title === 'Скалы Три Брата')).toHaveLength(1);
    expect(lenta[0]).toMatchObject({ id: 'ark-tri', typeLabel: expect.any(String), urlSlug: 'ark-tri' });
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('места владельца спрашиваются у каталога по номерам мест, а не своим запросом', async () => {
    catalog(async () => ({ items: POOL }), async () => ({ items: [TRI_BRATA, MAYAK] }));
    await fetchExplore();
    const pinnedCall = queryCatalog.mock.calls.find((c) => (c[1] as CatalogInternal | undefined)?.placeIds);
    expect(pinnedCall?.[1]).toEqual({ placeIds: EXPLORE_PINNED_PLACES.map((p) => p.placeId) });
    expect(pinnedCall?.[0]).toMatchObject({ kind: 'place', limit: EXPLORE_PINNED_PLACES.length });
    // Лента каталога — прежний запрос, без отбора по местам.
    const poolCall = queryCatalog.mock.calls.find((c) => !(c[1] as CatalogInternal | undefined)?.placeIds);
    expect(poolCall?.[0]).toMatchObject({ kind: 'place', sort: 'recommended' });
  });

  it('место скрыто или слито — его нет в ленте, а лог называет, кого ждали и кто пришёл', async () => {
    catalog(async () => ({ items: POOL }), async () => ({ items: [MAYAK] }));
    const lenta = await fetchExplore();
    expect(lenta[0].title).toBe('Маяк Петропавловский');
    expect(lenta).toHaveLength(1 + EXPLORE_LIMIT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('не все места владельца'), {
      expected: ['Скалы Три Брата', 'Маяк Петропавловский'],
      got: ['Маяк Петропавловский'],
    });
  });

  it('места владельца не прочитались — лента каталога стоит, отказ с SQLSTATE в логе', async () => {
    catalog(async () => ({ items: POOL }), () => Promise.reject(Object.assign(new Error('timeout'), { code: '57014' })));
    const lenta = await fetchExplore();
    expect(lenta).toHaveLength(EXPLORE_LIMIT);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('места владельца не прочитаны'), { sqlstate: '57014', message: 'timeout' });
  });

  it('каталог не прочитался — места владельца всё равно в ленте, отказ в логе', async () => {
    catalog(() => Promise.reject(Object.assign(new Error('down'), { code: '08006' })), async () => ({ items: [TRI_BRATA, MAYAK] }));
    const lenta = await fetchExplore();
    expect(lenta.map((p) => p.title)).toEqual(['Скалы Три Брата', 'Маяк Петропавловский']);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('места каталога не прочитаны'), { sqlstate: '08006', message: 'down' });
  });

  it('оба запроса упали — ленты нет, и оба отказа названы', async () => {
    const fail = () => Promise.reject(Object.assign(new Error('x'), { code: '08006' }));
    catalog(fail, fail);
    expect(await fetchExplore()).toEqual([]);
    expect(err).toHaveBeenCalledTimes(2);
  });

  it('повтор убирается до раскладки: остаток не становится короче предела', () => {
    const pick = vi.fn((rest: Item[]) => rest.slice(0, 3));
    const out = exploreWithPinned([TRI_BRATA], POOL, pick);
    expect(pick.mock.calls[0][0].map((p) => p.id)).not.toContain('ark-tri');
    expect(out.map((p) => p.id)).toEqual(['ark-tri', 'v1', 'l1', 'h1']);
  });

  it('колода главной открывается «Тремя Братьями», маяк — следующим краем', async () => {
    catalog(async () => ({ items: POOL }), async () => ({ items: [TRI_BRATA, MAYAK] }));
    render(<PlaceSwipeDeck places={await fetchExplore()} />);
    const deck = screen.getByRole('group', { name: 'Места: листайте карточки' });
    expect(deck.querySelector('a:not([aria-hidden])')).toHaveAttribute('href', '/places/ark-tri');
    expect(screen.getByText(`1 из ${2 + EXPLORE_LIMIT}`)).toBeInTheDocument();
    const peeks = Array.from(deck.querySelectorAll('[data-deck-peek]')).map((el) => el.textContent);
    expect(peeks).toEqual(expect.arrayContaining([expect.stringContaining('Маяк Петропавловский')]));
  });
});
