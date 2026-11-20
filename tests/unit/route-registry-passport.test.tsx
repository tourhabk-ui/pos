/**
 * Паспорт реестра, к карточке не привязанный (#3568, слово владельца 20.11
 * «2 дописать»): «В официальном паспорте — N км … Маршрут в паспорте может
 * отличаться от этой карточки», со ссылкой на PDF реестра.
 * Правило — вызовом, карточка — рендером.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

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

import {
  parseRegistryPassports,
  registryPassportLinkLabel,
  registryPassportNote,
} from '@/lib/routes/registry-passport';
import RouteDetailClient, { type RouteDetail } from '@/app/routes/[id]/_RouteDetailClient';

const P = 'https://visitkamchatka.ru/upload/route_passports/';
const PERE = { url: `${P}vilyuchinsky_pereval_avto.pdf`, km: 76, side: 'в обе стороны', label: null };
const SUMMER = { url: `${P}vilyuchinsky_waterfall_summer.pdf`, km: 4, side: 'в обе стороны', label: 'летний' };
const WINTER = { url: `${P}vilyuchinsky_waterfall_winter.pdf`, km: 4, side: 'в обе стороны', label: 'зимний' };

describe('паспорт реестра — разбор колонки', () => {
  it('годные записи проходят, адрес — только PDF реестра', () => {
    expect(parseRegistryPassports([PERE, { ...SUMMER, km: '4' }])).toEqual([PERE, SUMMER]);
  });

  it('чужой адрес, javascript:, пустая длина и не-список — отбрасываются', () => {
    expect(parseRegistryPassports([
      { ...PERE, url: 'https://evil.example/route_passports/x.pdf' },
      { ...PERE, url: 'javascript:alert(1)' },
      { ...PERE, url: `${P}x.html` },
      { ...PERE, km: 0 },
      { ...PERE, km: 'много' },
      null,
      'строка',
    ])).toEqual([]);
    expect(parseRegistryPassports({ url: PERE.url, km: 76 })).toEqual([]);
    expect(parseRegistryPassports(null)).toEqual([]);
  });
});

describe('паспорт реестра — слова', () => {
  it('один паспорт', () => {
    expect(registryPassportNote([PERE])).toBe(
      'В официальном паспорте — 76 км в обе стороны. Маршрут в паспорте может отличаться от этой карточки.',
    );
  });

  it('два паспорта с одной длиной — одной фразой', () => {
    expect(registryPassportNote([SUMMER, WINTER])).toBe(
      'В обоих официальных паспортах — 4 км в обе стороны. Маршрут в паспорте может отличаться от этой карточки.',
    );
  });

  it('разные длины — каждая со своей подписью', () => {
    expect(registryPassportNote([SUMMER, { ...WINTER, km: 6 }])).toBe(
      'В официальных паспортах: летний — 4 км в обе стороны; зимний — 6 км в обе стороны. ' +
      'Маршрут в паспорте может отличаться от этой карточки.',
    );
  });

  it('паспортов нет — строки нет; подписи ссылок', () => {
    expect(registryPassportNote([])).toBeNull();
    expect(registryPassportLinkLabel(PERE)).toBe('Паспорт (PDF)');
    expect(registryPassportLinkLabel(SUMMER)).toBe('Летний паспорт (PDF)');
  });
});

function route(over: Partial<RouteDetail>): RouteDetail {
  return {
    id: 'r1', category: 'trekking', locationType: null, activityType: 'hiking',
    title: 'Вилючинский перевал', description: '',
    lat: null, lng: null, sourceUrl: null, sourceName: null,
    priceFrom: null, season: null, difficulty: null, durationDays: null, bestMonths: null,
    altitude: null, groupSizeMax: null, dangerLevel: null, equipment: null, kuzmichReview: null,
    photos: null, offers: [], hasRealImage: false, waypointPhotos: null,
    mchsRequired: false, mchsPhone: null, parkName: null, parkSlug: null, parkApprovalUrl: null,
    hazards: null, distanceKm: 12.1, elevationGainM: null, elevationLossM: null,
    elevationMinM: null, elevationMaxM: null, surfaceTypes: null, durationHours: null,
    pdfUrl: null, officialPassportUrl: null, passportAgency: null,
    ...over,
  } as RouteDetail;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('карточка маршрута: паспорт реестра, к ней не привязанный', () => {
  it('строка «может отличаться» и ссылка на PDF; своя длина карточки на месте', () => {
    render(<RouteDetailClient id="r1" initialRoute={route({ registryPassports: [PERE] })} initialRelated={[]} />);
    const note = screen.getByTestId('registry-passport-note');
    expect(note.textContent).toContain('В официальном паспорте — 76 км в обе стороны.');
    expect(note.textContent).toContain('Маршрут в паспорте может отличаться от этой карточки.');
    const link = within(note).getByRole('link', { name: 'Паспорт (PDF)' });
    expect(link.getAttribute('href')).toBe(PERE.url);
    expect(screen.getByTestId('route-facts').textContent).toContain('12,1 км');
    // Паспорт не привязан — «Официальный паспорт маршрута · Проверено» не обещаем.
    expect(screen.queryByText('Официальный паспорт маршрута')).toBeNull();
  });

  it('два паспорта — обе ссылки', () => {
    render(<RouteDetailClient id="r1" initialRoute={route({ title: 'Вилючинский водопад', registryPassports: [SUMMER, WINTER] })} initialRelated={[]} />);
    const note = screen.getByTestId('registry-passport-note');
    expect(within(note).getByRole('link', { name: 'Летний паспорт (PDF)' }).getAttribute('href')).toBe(SUMMER.url);
    expect(within(note).getByRole('link', { name: 'Зимний паспорт (PDF)' }).getAttribute('href')).toBe(WINTER.url);
  });

  it('паспортов нет — строки нет', () => {
    render(<RouteDetailClient id="r1" initialRoute={route({})} initialRelated={[]} />);
    expect(screen.queryByTestId('registry-passport-note')).toBeNull();
  });
});
