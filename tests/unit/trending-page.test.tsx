/**
 * /trending — оба списка в разметке и заголовок, который не врёт о счётчике
 * (14.10) — рендером страницы с данными, как её видит поисковик (правило 13.10).
 *
 * Прогон 9 переписи sitemap: 88 слов. Списки приходили с сервера, но стояли
 * вкладками, и маршруты попадали в разметку только после щелчка. Заголовок
 * обещал «что смотрят прямо сейчас», а порядок — по просмотрам за всё время
 * (lib/trending/load). Отказ базы — «не удалось», а не пустая страница (§4.0).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import type { TrendingPlace, TrendingRoute } from '@/lib/trending/load';

const loadTrendingMock = vi.fn();
vi.mock('@/lib/trending/load', () => ({ loadTrending: (...a: unknown[]) => loadTrendingMock(...a) }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

import TrendingPage, * as pageModule from '@/app/trending/page';

const PLACES: TrendingPlace[] = [
  { id: 'p1', slug: 'vulkan-gorelyj', name: 'Вулкан Горелый', location_type: 'volcano', view_count: 1521, image_url: '/api/images/route/a1' },
  { id: 'p2', slug: null, name: 'Озеро без адреса', location_type: 'lake', view_count: 1, image_url: null },
  { id: 'p3', slug: 'p-3', name: 'Третье', location_type: null, view_count: 3, image_url: '/api/images/route/a3' },
  { id: 'p4', slug: 'p-4', name: 'Четвёртое', location_type: 'waterfall', view_count: 0, image_url: '/api/images/route/a4' },
];
const ROUTES: TrendingRoute[] = [
  { id: 'r1', slug: 'avachinskij-pereval', title: 'Авачинский перевал', difficulty: 'extreme', distance_km: 12.5, duration_hours: 0, activity_type: 'trekking', view_count: 22 },
  { id: 'r2', slug: null, title: 'Маршрут без адреса', difficulty: null, distance_km: null, duration_hours: 6, activity_type: null, view_count: 5 },
];

async function renderPage() {
  render(await TrendingPage());
}

beforeEach(() => {
  loadTrendingMock.mockReset();
  loadTrendingMock.mockResolvedValue({ places: PLACES, routes: ROUTES });
});
afterEach(cleanup);

describe('/trending: что видит поисковик', () => {
  it('оба списка в разметке сразу — без щелчка по вкладке', async () => {
    await renderPage();
    const places = screen.getByRole('region', { name: 'Места' });
    const routes = screen.getByRole('region', { name: 'Маршруты' });
    expect(within(places).getAllByRole('link')).toHaveLength(PLACES.length);
    expect(within(routes).getAllByRole('link')).toHaveLength(ROUTES.length);
    expect(screen.queryByRole('button')).toBeNull();
    expect(loadTrendingMock).toHaveBeenCalledWith('all', 12);
  });

  it('заголовок не обещает «прямо сейчас»: порядок — по просмотрам за всё время', async () => {
    await renderPage();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Популярные места и маршруты Камчатки');
    expect(document.body.textContent).not.toMatch(/прямо сейчас/i);
    expect(document.body.textContent).toContain('за всё время');
  });

  it('ссылки — по ЧПУ, без него — по id', async () => {
    await renderPage();
    const href = (name: RegExp) => screen.getByRole('link', { name }).getAttribute('href');
    expect(href(/Вулкан Горелый/)).toBe('/places/vulkan-gorelyj');
    expect(href(/Озеро без адреса/)).toBe('/places/p2');
    expect(href(/Авачинский перевал/)).toBe('/routes/avachinskij-pereval');
    expect(href(/Маршрут без адреса/)).toBe('/routes/r2');
  });

  it('подписи — из общих словарей, просмотры склоняются, нулей вместо данных нет', async () => {
    await renderPage();
    const card = (name: RegExp) => screen.getByRole('link', { name });
    expect(card(/Вулкан Горелый/).textContent).toContain('Вулкан');
    expect(card(/Вулкан Горелый/).textContent).toContain('1 521 просмотр');
    expect(card(/Озеро без адреса/).textContent).toContain('1 просмотр');
    expect(card(/Озеро без адреса/).textContent).not.toContain('просмотров');
    expect(card(/Третье/).textContent).toContain('3 просмотра');
    expect(card(/Четвёртое/).textContent).toContain('0 просмотров');
    // Сложность — общим словарём (lib/tours/labels), не своей копией «Экстрим».
    expect(card(/Авачинский перевал/).textContent).toContain('Экстремальный');
    expect(card(/Авачинский перевал/).textContent).toContain('12.5 км');
    // Ноль часов — не длительность, а её отсутствие.
    expect(card(/Авачинский перевал/).textContent).not.toMatch(/\b0 ч/);
    expect(card(/Маршрут без адреса/).textContent).toContain('6 ч');
  });

  it('снимки: первый ряд грузится сразу, остальные — лениво', async () => {
    await renderPage();
    const img = (alt: string) => screen.getByRole('img', { name: alt });
    expect(img('Вулкан Горелый').getAttribute('loading')).toBeNull();
    expect(img('Третье').getAttribute('loading')).toBeNull();
    expect(img('Четвёртое').getAttribute('loading')).toBe('lazy');
  });

  it('отказ базы — «не удалось», с причиной в логе, а не пустая страница', async () => {
    const err = Object.assign(new Error('connection refused'), { code: '08006' });
    loadTrendingMock.mockRejectedValue(err);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    expect(screen.getByText(/Не удалось загрузить популярное/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Места' })).toBeNull();
    expect(spy.mock.calls.some(c => c.join(' ').includes('sqlstate=08006'))).toBe(true);
    spy.mockRestore();
  });

  it('пустой список — словами, а не пустой сеткой', async () => {
    loadTrendingMock.mockResolvedValue({ places: [], routes: ROUTES });
    await renderPage();
    expect(within(screen.getByRole('region', { name: 'Места' })).getByText('Списка мест пока нет.')).toBeTruthy();
  });

  it('страница собирается на каждый запрос: популярность меняется со счётчиком', () => {
    expect(pageModule.dynamic).toBe('force-dynamic');
  });
});
