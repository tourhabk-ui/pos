/**
 * Раздел «Что знать» на карточке места есть всегда (15.10).
 *
 * В разделе — блок безопасности с кнопкой 112 и инструкциями выживания
 * (PlaceSafety), и он есть у любого места. Прежнее условие показывало раздел
 * только при режиме охраны, сезоне, опасностях, медпомощи или лимите
 * посещения — и у мест без записанного режима (98 в переписи
 * place-eco-census) кнопки 112 в теле карточки не было вовсе. У остальных
 * раздел держался случайной связью: режимом «нет», который 170 проставила
 * без сверки.
 *
 * Рендером карточки с данными места, у которого нет ни режима, ни опасностей,
 * ни сезона (снимок «Паланских термальных источников» с прода, проба 960):
 * ленивые блоки подменены метками, видно, какой блок под каким заголовком.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { PlaceData } from '@/components/places/types';

vi.mock('next/dynamic', () => ({
  default: (loader: () => unknown) => {
    // Загрузчик ленивого блока несёт путь модуля: «/components/places/PlaceSafety.tsx».
    const name = /components\/(?:[\w-]+\/)*(\w+)\.tsx?/.exec(String(loader))?.[1] ?? 'Dynamic';
    const Stub = () => <div data-dyn={name} />;
    Stub.displayName = `Dyn(${name})`;
    return Stub;
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/hooks/use-catalog-return', () => ({ useCatalogReturnHref: () => '/places' }));

beforeAll(() => {
  // Карточка уже пришла с сервера; сеть не отвечает — данные не меняются.
  globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});
afterEach(cleanup);

const BARE_PLACE = {
  id: '4a474632-d8d6-4147-9fa1-ed149edb1a62',
  name: 'Паланские термальные источники',
  description: null, descriptionSource: null, descriptionByModel: false, descriptionWithdrawn: true, descriptionImpression: false,
  essence: null, category: 'hot_spring', locationType: 'hot_spring',
  lat: 58.8451, lng: 161.325, zone: 'northern', district: null,
  photoUrl: null, images: [], photoCount: 0, photoAttribution: null, photoCredits: {}, photoRights: {},
  bestSeason: null, seasonalNotes: null, accessInfo: null, sourceUrl: null, sourceName: null,
  updatedAt: '2026-10-14T11:17:47.862Z', kuzmichReview: null, chronicle: [], coordSource: 'unknown',
  eco: null, indigenous: null,
  safety: {
    source: 'manual', difficultyLevel: null, altitudeM: null, altitudeDiffM: null, distanceKm: null,
    terrainType: null, roadType: null, roadAccessibility: null, nearestMedicalKm: null, emergencyAccess: null,
    phoneRangerMches: null, satCommunicatorRequired: false, rulesRequired: null, weatherThreshold: null,
    hazardTypes: [], capacityPerDay: null, capacityPerDaySource: null, optimalGroupSize: null,
    openFromDate: null, openToDate: null, requiredGear: [], connectivity: null, registrationRequired: false,
    medicalInfo: null,
  },
  volcanoStatus: null, realtime: null,
  routes: [], tours: [], reviewsSummary: { total: 0, avg: null }, reviews: [], nearby: [],
} as unknown as PlaceData;

/** Заголовок раздела и всё, что под ним до следующего раздела. */
function sectionOf(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const section = heading.closest('section');
  if (!section) throw new Error(`раздел «${title}» без <section>`);
  return section as HTMLElement;
}

describe('раздел «Что знать»', () => {
  it('есть у места без режима, опасностей и сезона — и в нём блок безопасности с 112', async () => {
    const { default: PlaceDetailClient } = await import('@/app/places/[id]/_PlaceDetailClient');
    render(<PlaceDetailClient id={BARE_PLACE.id} initialPlace={BARE_PLACE} />);
    const section = sectionOf('Что знать');
    expect(section.querySelector('[data-dyn="PlaceSafety"]'), 'блок безопасности под «Что знать»').not.toBeNull();
    // Режима нет — блока режима нет, и о «нет режима» карточка не говорит.
    expect(section.querySelector('[data-dyn="PlaceEco"]')).toBeNull();
    expect(within(section).queryByText(/не охраняется|не требуется/)).toBeNull();
  });
});
