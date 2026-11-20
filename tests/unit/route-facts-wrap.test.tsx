/**
 * Строка фактов карточки маршрута на телефоне (#3568, проверка живой карточки
 * 20.11): длинный сезон паспорта «апрель - сентябрь; с 1 мая по 1 июля
 * гнездовые участки закрыты» уходил за край экрана в прокрутку вбок.
 *
 * Плитки не сжимаются (flex-shrink-0) и без предела берут ширину своего
 * текста. Предел в ширину ленты (max-w-full) даёт тексту перенос внутри
 * плитки — проверено в Chromium на 390 px: без предела лента шире видимой
 * части (508 против 374 px), с пределом — нет. jsdom раскладку не считает,
 * поэтому здесь — рендер карточки и предел у каждой плитки, которую она
 * рисует, с длинным сезоном внутри.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/routes/r1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/dynamic', () => ({ default: () => function Stub() { return null; } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('@/components/shared/EmergencyAction', () => ({ default: () => null, EmergencyAction: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.mock('@/components/shared/AssistantButton', () => ({ AssistantButton: () => null }));
vi.mock('@/hooks/useSourceTracker', () => ({ useSourceTracker: () => undefined }));
vi.mock('@/hooks/use-catalog-return', () => ({ useCatalogReturnHref: () => '/routes' }));

import RouteDetailClient, { type RouteDetail } from '@/app/routes/[id]/_RouteDetailClient';

const LONG_SEASON = 'апрель - сентябрь; с 1 мая по 1 июля гнездовые участки закрыты';

function route(over: Partial<RouteDetail>): RouteDetail {
  return {
    id: 'r1', category: 'trekking', locationType: null, activityType: 'hiking',
    title: 'Птичий городок', description: '',
    lat: null, lng: null, sourceUrl: null, sourceName: null,
    priceFrom: null, season: LONG_SEASON, difficulty: 'moderate', durationDays: 4, bestMonths: null,
    altitude: 1200, groupSizeMax: 12, dangerLevel: null, equipment: null, kuzmichReview: null,
    photos: null, offers: [], hasRealImage: false, waypointPhotos: null,
    mchsRequired: false, mchsPhone: null, parkName: null, parkSlug: null, parkApprovalUrl: null,
    hazards: null, distanceKm: 17, distanceNote: 'в одну сторону', elevationGainM: null, elevationLossM: null,
    elevationMinM: null, elevationMaxM: null, surfaceTypes: null, durationHours: null,
    pdfUrl: null, officialPassportUrl: null, passportAgency: null,
    ...over,
  } as RouteDetail;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('строка фактов маршрута: длинный текст не уходит за край', () => {
  it('у каждой плитки — предел в ширину ленты, длинный сезон внутри', () => {
    render(<RouteDetailClient id="r1" initialRoute={route({})} initialRelated={[]} />);
    const strip = screen.getByTestId('route-facts');
    const tiles = Array.from(strip.children) as HTMLElement[];
    expect(tiles.length).toBeGreaterThanOrEqual(5);
    for (const t of tiles) {
      expect(t.className.split(/\s+/), `плитка «${t.textContent}» без предела ширины`).toContain('max-w-full');
      expect(t.className).not.toMatch(/whitespace-nowrap|truncate/);
    }
    const season = tiles.find((t) => t.textContent?.startsWith('Сезон'));
    expect(season?.textContent).toContain(LONG_SEASON);
  });
});
