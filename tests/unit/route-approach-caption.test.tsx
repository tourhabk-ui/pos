/**
 * Подпись под картой маршрута, когда в линию влита дорога подъезда (#3568).
 *
 * Длина маршрута, сверенного с официальным паспортом, — число паспорта со
 * стороной («17 км в одну сторону», `distance_note`), а не длина линии. Прежняя
 * подпись «длина считается по всей линии» у такой карточки была бы неправдой.
 * Правило — вызовом функции; что карточка его ставит — рендером карточки.
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

import { approachCaption } from '@/lib/routes/approach-caption';
import RouteDetailClient, { type RouteDetail } from '@/app/routes/[id]/_RouteDetailClient';

const BY_LINE = /Длина считается по всей линии, вместе с дорогой\./;
const BY_PASSPORT = /Длина маршрута на карточке — из официального паспорта, а не по линии\./;

describe('approachCaption — правило', () => {
  it('длина из линии (пометки стороны нет) — прежние слова', () => {
    expect(approachCaption(22.4, null)).toBe(
      'Линия включает подъезд: её дальний конец в 22 км от места. Длина считается по всей линии, вместе с дорогой.',
    );
    expect(approachCaption(22.4, '  ')).toMatch(BY_LINE);
  });

  it('длина из паспорта — подпись не говорит, что она по линии', () => {
    const s = approachCaption(22.4, 'в одну сторону');
    expect(s).toMatch(/^Линия включает подъезд: её дальний конец в 22 км от места\. /);
    expect(s).toMatch(BY_PASSPORT);
    expect(s).not.toMatch(BY_LINE);
  });

  it('дальнего конца не знаем — подписи нет', () => {
    expect(approachCaption(null, 'в одну сторону')).toBeNull();
    expect(approachCaption(undefined, null)).toBeNull();
    expect(approachCaption(Number.NaN, null)).toBeNull();
  });
});

// Точка записи у конца линии, начало линии в ~22 км к югу: судья
// line-ownership ставит `own_with_approach`.
const TRACK: [number, number][] = [
  [53.10, 157.50], [53.15, 157.50], [53.20, 157.50], [53.25, 157.50], [53.30, 157.50],
];

function route(over: Partial<RouteDetail>): RouteDetail {
  return {
    id: 'r1', category: 'trekking', locationType: null, activityType: 'hiking',
    title: 'Вулкан Дыгерен — Оленгендэ: зимний', description: '',
    lat: 53.30, lng: 157.50, sourceUrl: null, sourceName: null,
    priceFrom: null, season: null, difficulty: null, durationDays: null, bestMonths: null,
    altitude: null, groupSizeMax: null, dangerLevel: null, equipment: null, kuzmichReview: null,
    photos: null, offers: [], hasRealImage: false, waypointPhotos: null,
    mchsRequired: false, mchsPhone: null, parkName: null, parkSlug: null, parkApprovalUrl: null,
    hazards: null, distanceKm: 22.77, elevationGainM: null, elevationLossM: null,
    elevationMinM: null, elevationMaxM: null, surfaceTypes: null, durationHours: null,
    pdfUrl: null, officialPassportUrl: null, passportAgency: null,
    track: TRACK, geometrySource: 'external',
    ...over,
  } as RouteDetail;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('карточка маршрута: подпись о подъезде', () => {
  it('длина из линии — «по всей линии»', () => {
    render(<RouteDetailClient id="r1" initialRoute={route({})} initialRelated={[]} />);
    expect(screen.getAllByText(BY_LINE).length).toBeGreaterThan(0);
    expect(screen.queryByText(BY_PASSPORT)).toBeNull();
  });

  it('длина из паспорта со стороной — «из официального паспорта», и строка длины со стороной', () => {
    render(<RouteDetailClient id="r1" initialRoute={route({ distanceKm: 17, distanceNote: 'в одну сторону' })} initialRelated={[]} />);
    expect(screen.getAllByText(BY_PASSPORT).length).toBeGreaterThan(0);
    expect(screen.queryByText(BY_LINE)).toBeNull();
    expect(screen.getByTestId('route-facts').textContent).toContain('17 км в одну сторону');
  });
});
