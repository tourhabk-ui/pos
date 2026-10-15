/**
 * Галочка «Закрепить наверху моей страницы» в редакторе тура — рендером:
 * состояние приходит из pinned_at тура, а сохранение отправляет pinned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: '51' }),
}));

import EditTourClient from '@/app/hub/operator/tours/[id]/_EditTourClient';

const TOUR = {
  id: '51', title: 'Курильское озеро (вертолёт)', short_description: null, description: null,
  location_type: 'lake', activity_type: 'helicopter', location_name: 'Курильское озеро',
  latitude: null, longitude: null, base_price: 180000, price_old: null, price_unit: 'per_person',
  max_participants: 20, min_participants: null, duration_hours: 10, duration_type: 'day', multi_day_count: null,
  season_start: null, season_end: null, seasonal_only: false, difficulty: null, weather_dependent: true,
  is_active: true, is_published: true, included: [], not_included: [], what_to_bring: [],
  cancellation_policy: null, pickup_type: null, pickup_details: null, photos: [], tour_image: null,
};

let patchBodies: Array<Record<string, unknown>>;

function mockFetch(pinnedAt: string | null) {
  patchBodies = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'PATCH') {
      patchBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ success: true, data: { id: '51' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/availability')) {
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: { ...TOUR, pinned_at: pinnedAt } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => vi.restoreAllMocks());

describe('редактор тура: закрепление наверху страницы', () => {
  it('незакреплённый тур: галочка снята; отметил и сохранил — уходит pinned: true', async () => {
    mockFetch(null);
    render(<EditTourClient />);
    const box = await screen.findByLabelText('Закрепить наверху моей страницы') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getAllByText('Сохранить')[0]);
    await waitFor(() => expect(patchBodies.length).toBe(1));
    expect(patchBodies[0].pinned).toBe(true);
  });

  it('закреплённый тур: галочка стоит, сохранение без правки оставляет pinned: true', async () => {
    mockFetch('2026-10-15T09:00:00.000Z');
    render(<EditTourClient />);
    const box = await screen.findByLabelText('Закрепить наверху моей страницы') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getAllByText('Сохранить')[0]);
    await waitFor(() => expect(patchBodies.length).toBe(1));
    expect(patchBodies[0].pinned).toBe(true);
  });
});
