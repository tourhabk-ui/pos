/**
 * Календарь туров на телефоне — колонкой (14.10).
 *
 * Замер в браузере 14.10, экран 375×812: сетка дней стояла в одном ряду с
 * панелью дня шириной 320 px (`w-80 shrink-0`, без переноса) — карточке
 * календаря доставалось 34 px, самой сетке 0, числа дней налезали друг на
 * друга. Пункт «Календарь туров» стоит в мобильном меню (/menu), то есть
 * открывали его как раз с телефона. После правки на 375 px карточка 343 px,
 * сетка 309, панель дня — под ней во всю ширину; на 1280 — как было
 * (сетка 652, панель 320 справа).
 *
 * Раскладку jsdom не считает, поэтому сторож держит то, что её задаёт, в
 * отрисованной разметке (как media-no-stretch): ряд сетки и панели — колонка,
 * в ряд — только с брейкпоинтом; фиксированная ширина панели — только с
 * брейкпоинтом. И поведение: панель дня под сеткой при выборе дня
 * прокручивается в вид, а рядом с сеткой — нет.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/booking/TourPaymentModal', () => ({ default: () => null }));

import CalendarClient from '@/app/calendar/_CalendarClient';

const MONTH = {
  success: true,
  days: [{ date: '2026-10-20', tourCount: 2, freeSlots: 5, priceFrom: 12000, activities: ['trekking'], operators: 1 }],
};

const originalRect = Element.prototype.getBoundingClientRect;
const originalScroll = Element.prototype.scrollIntoView;
let scrolled: Element[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00'));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.startsWith('/api/availability/day') ? { success: true, tours: [] } : MONTH),
  })));
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Element.prototype.getBoundingClientRect = originalRect;
  Element.prototype.scrollIntoView = originalScroll;
});

const classes = (el: Element) => el.className.split(/\s+/).filter(Boolean);
const day = (n: number) => screen.queryAllByRole('button').find((b) => b.querySelector('span')?.textContent === String(n));

/** Ряд «сетка + панель дня»: общий родитель карточки месяца и панели «Выберите дату». */
async function layout() {
  render(<CalendarClient />);
  await waitFor(() => expect(day(20)).toBeTruthy());
  const grid = screen.getByRole('heading', { name: 'Октябрь 2026' }).closest('.ds-card')!.parentElement!;
  const row = grid.parentElement!;
  const panel = [...row.children].find((c) => c !== grid && c.textContent?.includes('Выберите дату'))!;
  expect(panel).toBeTruthy();
  return { grid, row, panel };
}

/** Раскладка, какую дал бы браузер: прямоугольники сетки и панели. */
function placeAt(grid: Element, panel: Element, gridBottom: number, panelTop: number) {
  Element.prototype.getBoundingClientRect = function rect(this: Element) {
    if (this === grid) return { top: 300, bottom: gridBottom, left: 16, right: 359, width: 343, height: gridBottom - 300, x: 16, y: 300, toJSON: () => ({}) } as DOMRect;
    if (this === panel) return { top: panelTop, bottom: panelTop + 166, left: 16, right: 359, width: 343, height: 166, x: 16, y: panelTop, toJSON: () => ({}) } as DOMRect;
    return originalRect.call(this);
  };
}

describe('календарь туров: на телефоне сетка не делит ряд с панелью дня', () => {
  it('ряд — колонкой, в ряд — только с брейкпоинтом; ширина панели — только с брейкпоинтом', async () => {
    const { row, panel } = await layout();
    expect(classes(row)).toContain('flex-col');
    expect(classes(row)).not.toContain('flex-row');
    expect(classes(row).some((c) => /^(sm|md|lg|xl):flex-row$/.test(c))).toBe(true);
    // `w-80 shrink-0` без брейкпоинта и есть дефект 14.10: 320 px из 343.
    expect(classes(panel).filter((c) => /^w-\d/.test(c) || c === 'shrink-0')).toEqual([]);
  });

  it('панель дня под сеткой: выбрали день — панель прокручена в вид', async () => {
    const { grid, panel } = await layout();
    placeAt(grid, panel, 640, 660);
    fireEvent.click(day(20)!);
    await waitFor(() => expect(scrolled).toEqual([panel]));
  });

  it('панель рядом с сеткой (десктоп): выбрали день — страница на месте', async () => {
    const { grid, panel } = await layout();
    placeAt(grid, panel, 835, 231);
    fireEvent.click(day(20)!);
    await screen.findByText('Нет доступных туров на этот день');
    expect(scrolled).toEqual([]);
  });
});
