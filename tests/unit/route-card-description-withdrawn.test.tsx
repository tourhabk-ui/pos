/**
 * Карточка маршрута целиком: снятое описание (1261) — словами, а не пустым
 * местом; переписанное — текстом, без объяснения.
 *
 * Компонент объяснения проверен отдельно (route-descriptions-withdrawn);
 * здесь — что карточка его действительно ставит и кормит признаком из
 * загрузчика. Без этого рендера объяснение могло бы лежать в файле, не
 * доходя до экрана (решение владельца 13.10: сторож судит поведение).
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

const NOTICE = /Описание этого маршрута было написано не по источникам/;

function route(over: Partial<RouteDetail>): RouteDetail {
  return {
    id: 'r1', category: 'trekking', locationType: null, activityType: 'hiking',
    title: 'Авачинский вулкан: путь на вершину', description: '',
    lat: null, lng: null, sourceUrl: null, sourceName: null,
    priceFrom: null, season: null, difficulty: null, durationDays: null, bestMonths: null,
    altitude: null, groupSizeMax: null, dangerLevel: null, equipment: null, kuzmichReview: null,
    photos: null, offers: [], hasRealImage: false, waypointPhotos: null,
    mchsRequired: false, mchsPhone: null, parkName: null, parkSlug: null, parkApprovalUrl: null,
    hazards: null, distanceKm: null, elevationGainM: null, elevationLossM: null,
    elevationMinM: null, elevationMaxM: null, surfaceTypes: null, durationHours: null,
    pdfUrl: null, officialPassportUrl: null, passportAgency: null,
    ...over,
  } as RouteDetail;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('карточка маршрута: снятое описание', () => {
  it('описание снято и не переписано — объяснение словами', () => {
    render(<RouteDetailClient id="r1" initialRoute={route({ description: '', descriptionWithdrawn: true })} initialRelated={[]} />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });

  it('переписанное по источникам — текстом, без объяснения', () => {
    render(<RouteDetailClient id="r1" initialRoute={route({ description: 'Подъём от Авачинского перевала по паспорту маршрута.', descriptionWithdrawn: false })} initialRelated={[]} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByText(/по паспорту маршрута/)).toBeTruthy();
  });

  it('не снятое и пустое — без объяснения: молчание тут не наша правка', () => {
    render(<RouteDetailClient id="r1" initialRoute={route({ description: '' })} initialRelated={[]} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
