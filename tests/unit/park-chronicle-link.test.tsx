/**
 * Страница парка ведёт в летопись — владелец 14.10: «Страница парка
 * /park/kronotsky — нужен переход для летописи, очень интересная статья».
 *
 * Статья знает свои парки (`parkSlugs`), серверная страница парка отдаёт
 * карточке только заголовок, годы и лид. Судит рендер серверной страницы с
 * данными загрузчика: что человек видит и куда ведёт ссылка.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ParkPageData } from '@/lib/parks/park-page';

// cache() — серверная часть React, в jsdom её нет: та же заглушка, что у прочих сторожей серверных страниц.
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/EmergencyAction', () => ({ EmergencyAction: () => null }));

const loadParkPage = vi.fn<(slug: string) => Promise<ParkPageData | null>>();
vi.mock('@/lib/parks/park-page', () => ({ loadParkPage: (slug: string) => loadParkPage(slug) }));

import ParkPage from '@/app/park/[slug]/page';
import { chronicleForPark } from '@/lib/chronicle/articles';

afterEach(() => {
  cleanup();
  loadParkPage.mockReset();
});

function park(slug: string, displayName: string): ParkPageData {
  return {
    slug, displayName, description: null, zone: null, permit_url: null,
    permitChannels: { email: null, officeAddress: null, officeHours: null, gosuslugiUrl: null, onlineUrl: null },
    routes: [], routesFailed: false,
  };
}

describe('какие статьи у какого парка', () => {
  it('Кроноцкий — «Кроноцкий заповедник», Командорский — «Командорские острова», чужому — ничего', () => {
    expect(chronicleForPark('kronotsky').map((a) => a.slug)).toEqual(['kronotskij-zapovednik']);
    expect(chronicleForPark('komandorskiy').map((a) => a.slug)).toEqual(['komandorskie-ostrova']);
    // У «Налычево» статья появилась 14.10 (1248); у обоих кластеров
    // национального парка — общая (1250); «чужой» — парк без статьи.
    expect(chronicleForPark('nalychevo').map((a) => a.slug)).toEqual(['nalychevo']);
    expect(chronicleForPark('klyuchevskoy').map((a) => a.slug)).toEqual(['vulkany-kamchatki']);
    expect(chronicleForPark('yuzhno-kamchatsky').map((a) => a.slug)).toEqual(['vulkany-kamchatki']);
    expect(chronicleForPark('vilyuchinsky')).toEqual([]);
  });
});

describe('страница парка', () => {
  it('/park/kronotsky: блок «Летопись» со ссылкой на статью, её годами и лидом', async () => {
    loadParkPage.mockResolvedValue(park('kronotsky', 'Кроноцкий заповедник'));
    render(await ParkPage({ params: Promise.resolve({ slug: 'kronotsky' }) }));
    const block = screen.getByRole('region', { name: 'Летопись' });
    const link = within(block).getByRole('link');
    expect(link.getAttribute('href')).toBe('/letopis/kronotskij-zapovednik');
    expect(link.textContent).toContain('Кроноцкий заповедник');
    expect(link.textContent).toContain('1882 — наши дни');
    expect(link.textContent).toContain('Читать статью');
  });

  it('блок стоит перед маршрутами — длинный список его не прячет', async () => {
    loadParkPage.mockResolvedValue(park('kronotsky', 'Кроноцкий заповедник'));
    render(await ParkPage({ params: Promise.resolve({ slug: 'kronotsky' }) }));
    const block = screen.getByRole('region', { name: 'Летопись' });
    const routes = screen.getByRole('heading', { name: 'Маршруты парка' });
    expect(block.compareDocumentPosition(routes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('у парка без статьи блока нет', async () => {
    loadParkPage.mockResolvedValue(park('vilyuchinsky', 'Природный парк «Вилючинский»'));
    render(await ParkPage({ params: Promise.resolve({ slug: 'vilyuchinsky' }) }));
    expect(screen.queryByRole('region', { name: 'Летопись' })).toBeNull();
  });
});
