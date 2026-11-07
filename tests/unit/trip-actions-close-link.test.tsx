/**
 * «Закрыть ссылку» в «Перед поездкой» (аудит планировщика 07.11, H15): до
 * этого публикацию нельзя было отозвать. API — tests/unit/trip-share-saved-tour.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { TripActions, type TripActionsTrip } from '@/components/trips/TripActions';

const TRIP: TripActionsTrip = { id: 'trip-1', title: 'Маршрут', arrival_date: '2030-08-01', departure_date: '2030-08-03', days: [] };
let deleteReply: { success: boolean; error?: string } = { success: true };

beforeEach(() => {
  deleteReply = { success: true };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    json: async () => (init?.method === 'DELETE' ? deleteReply
      : String(url).endsWith('/share') ? { success: true, shareUrl: 'https://vedarai.ru/trip/abc' } : { success: false }),
  }) as Response));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const closeButton = () => screen.queryByRole('button', { name: /Закрыть ссылку/ });

describe('закрыть ссылку для близких', () => {
  it('ссылка открыта — кнопка есть; закрыли — DELETE, кнопки нет, сказано, что дальше', async () => {
    render(<TripActions trip={{ ...TRIP, is_public: true }} />);
    expect(screen.getByText(/Ссылка на план открыта/)).toBeTruthy();
    fireEvent.click(closeButton()!);
    expect(await screen.findByText(/Ссылка закрыта: по ней план больше не открыть/)).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([u, i]) => u === '/api/trips/trip-1/share' && (i as RequestInit)?.method === 'DELETE')).toBe(true);
    expect(closeButton()).toBeNull();
  });

  it('ссылка не открыта — кнопки нет; после «Копировать» появляется', async () => {
    render(<TripActions trip={TRIP} />);
    expect(closeButton()).toBeNull();
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
    fireEvent.click(screen.getByRole('button', { name: /Копировать/ }));
    expect(await screen.findByRole('button', { name: /Закрыть ссылку/ })).toBeTruthy();
  });

  it('сервер не закрыл — ошибка словами, кнопка остаётся', async () => {
    deleteReply = { success: false, error: 'Ссылку сейчас не закрыть — попробуйте ещё раз' };
    render(<TripActions trip={{ ...TRIP, is_public: true }} />);
    fireEvent.click(closeButton()!);
    expect(await screen.findByText('Ссылку сейчас не закрыть — попробуйте ещё раз')).toBeTruthy();
    expect(closeButton()).toBeTruthy();
  });
});
