/**
 * Карточка парка (замечание Сыщика 21.11): дата правки — из parks.updated_at,
 * видна на странице и стоит в WebPage.dateModified; поля нет — ни строки, ни узла.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ParkPageData } from '@/lib/parks/park-page';

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/EmergencyAction', () => ({ EmergencyAction: () => null }));

const loadParkPage = vi.fn<(slug: string) => Promise<ParkPageData | null>>();
vi.mock('@/lib/parks/park-page', () => ({ loadParkPage: (slug: string) => loadParkPage(slug) }));

import ParkPage from '@/app/park/[slug]/page';

afterEach(() => { cleanup(); loadParkPage.mockReset(); });

function park(updatedAt: string | null): ParkPageData {
  return {
    slug: 'nalychevo', displayName: 'Природный парк «Налычево»', description: null, zone: null, permit_url: null,
    permitChannels: { email: null, officeAddress: null, officeHours: null, gosuslugiUrl: null, onlineUrl: null },
    routes: [], routesFailed: false, updatedAt,
  };
}

const lds = (c: HTMLElement) =>
  [...c.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.innerHTML));

describe('карточка парка: дата правки записи', () => {
  it('updated_at есть — строка на странице и WebPage со ссылкой на парк', async () => {
    loadParkPage.mockResolvedValue(park('2026-10-14T12:53:48.635Z'));
    const { container } = render(await ParkPage({ params: Promise.resolve({ slug: 'nalychevo' }) }));
    expect(container.textContent).toContain('Последняя правка записи: 15 октября 2026');
    const all = lds(container);
    const parkNode = all.find((n) => Array.isArray(n['@type']) && n['@type'].includes('Park'));
    const page = all.find((n) => n['@type'] === 'WebPage');
    expect(page?.dateModified).toBe('2026-10-14T12:53:48.635Z');
    expect(page?.mainEntity?.['@id']).toBe(parkNode?.['@id']);
  });

  it('поля нет — ни строки, ни dateModified', async () => {
    loadParkPage.mockResolvedValue(park(null));
    const { container } = render(await ParkPage({ params: Promise.resolve({ slug: 'nalychevo' }) }));
    expect(container.textContent).not.toContain('Последняя правка записи');
    expect(lds(container).some((n) => 'dateModified' in n)).toBe(false);
  });
});
