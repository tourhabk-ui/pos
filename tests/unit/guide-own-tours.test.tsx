/**
 * Раздел «Свои туры» кабинета гида (28.10, владелец: «Раздел в кабинете
 * гида») — рендером и вызовом.
 *
 *   — бронь своего тура видна с контактами туриста; кнопки — из тех же
 *     переходов, что проверяет сервер (ALLOWED_TRANSITIONS);
 *   — отклонить без причины нельзя: кнопка «Да» не нажимается, пока причины
 *     нет, и причина уходит в PATCH;
 *   — список, который не прочитался (null), — «не загрузились», а не «пусто»
 *     (§4.0);
 *   — даты открываются только у опубликованных туров, черновик назван
 *     черновиком;
 *   — личные сообщения ведут гида в «Свои туры», а оператора — в его кабинет
 *     (lib/partners/cabinet-links).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import OwnToursClient, { actionsFor, STATUS_LABEL } from '@/app/hub/guide/own/_OwnToursClient';
import { ownerBookingsListUrl, ownerBookingsUrl, ownerLeadUrl } from '@/lib/partners/cabinet-links';
import { ALLOWED_TRANSITIONS } from '@/types/booking.types';

const TOUR = {
  id: '101', title: 'Толбачик, 4 дня', slug: 'tolbachik', is_published: true, is_active: true,
  base_price: '85000', max_participants: 4, season_start: '2027-07-26', season_end: '2027-09-23', open_dates: 5,
};
const DRAFT = { ...TOUR, id: '102', title: 'Бухта Русская', slug: 'russkaya', is_published: false, open_dates: 0 };
const BOOKING = {
  id: '7001', tour_id: '101', tour_title: 'Толбачик, 4 дня', booking_date: '2027-07-26', participants: 2,
  booking_status: 'new', tourist_name: 'Пётр', tourist_phone: '+79990001122', tourist_email: null,
  special_requests: 'Вегетарианское питание', created_at: '2026-10-28',
};

type Reply = { ok: boolean; status?: number; body: unknown };
let ownReply: Reply;
let patchReply: Reply;
let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  ownReply = { ok: true, body: { success: true, data: { tours: [TOUR, DRAFT], bookings: [BOOKING], leads: [] } } };
  patchReply = { ok: true, body: { success: true, data: {}, tourist_notice: 'sent' } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : null });
    const r = method === 'PATCH' ? patchReply : ownReply;
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('«Свои туры» гида', () => {
  it('кнопки брони — ровно разрешённые сервером переходы', () => {
    for (const [from, to] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect([...actionsFor(from)].sort()).toEqual([...to].sort());
    }
    expect(actionsFor('неизвестный')).toEqual([]);
  });

  it('новая бронь своего тура — с контактами туриста; подтверждение уходит PATCH-ем в раздел гида', async () => {
    render(<OwnToursClient />);
    const row = await screen.findByTestId('own-booking-7001');
    expect(within(row).getByText('Толбачик, 4 дня')).toBeTruthy();
    expect(within(row).getByText(STATUS_LABEL.new)).toBeTruthy();
    expect(within(row).getByText('Пётр')).toBeTruthy();
    expect(within(row).getByRole('link', { name: /\+79990001122/ }).getAttribute('href')).toBe('tel:+79990001122');
    expect(within(row).getByText(/Вегетарианское питание/)).toBeTruthy();
    // Для новой — только «Подтвердить» и «Отклонить».
    expect(within(row).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Подтвердить', 'Отклонить']);

    fireEvent.click(within(row).getByRole('button', { name: 'Подтвердить' }));
    fireEvent.click(within(row).getByRole('button', { name: /Да, подтвердить/ }));
    await screen.findByText(/Бронь №7001: подтверждена\./);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toEqual({ url: '/api/guide/own/bookings/7001', method: 'PATCH', body: { booking_status: 'confirmed' } });
  });

  it('отклонить без причины нельзя; причина уходит туристу', async () => {
    render(<OwnToursClient />);
    const row = await screen.findByTestId('own-booking-7001');
    fireEvent.click(within(row).getByRole('button', { name: 'Отклонить' }));
    const yes = within(row).getByRole('button', { name: /Да, отклонить/ }) as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    fireEvent.change(within(row).getByLabelText(/Причина/), { target: { value: 'Закрыт подъезд к вулкану' } });
    expect(yes.disabled).toBe(false);
    fireEvent.click(yes);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ booking_status: 'cancelled', cancellation_reason: 'Закрыт подъезд к вулкану' });
  });

  it('отказ сервера назван словами сервера, бронь не помечена изменённой', async () => {
    patchReply = { ok: false, status: 409, body: { success: false, error: 'Из статуса «cancelled» так перевести бронь нельзя' } };
    render(<OwnToursClient />);
    const row = await screen.findByTestId('own-booking-7001');
    fireEvent.click(within(row).getByRole('button', { name: 'Подтвердить' }));
    fireEvent.click(within(row).getByRole('button', { name: /Да, подтвердить/ }));
    expect((await within(row).findByRole('alert')).textContent).toContain('так перевести бронь нельзя');
    expect(screen.queryByText(/Бронь №7001: подтверждена/)).toBeNull();
  });

  it('не прочитанный список — «не загрузились», пустой — «пока нет»', async () => {
    ownReply = { ok: true, body: { success: true, data: { tours: [TOUR], bookings: null, leads: [] } } };
    render(<OwnToursClient />);
    expect((await screen.findByText(/Брони не загрузились/)).getAttribute('role')).toBe('alert');
    expect(screen.queryByText('Броней пока нет.')).toBeNull();
    expect(screen.getByText('Заявок пока нет.')).toBeTruthy();
  });

  it('даты — только у опубликованных туров; черновик назван черновиком', async () => {
    render(<OwnToursClient />);
    await screen.findByTestId('own-booking-7001');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Толбачик, 4 дня']);
    expect(screen.getByRole('link', { name: 'Толбачик, 4 дня' }).getAttribute('href')).toBe('/catalog/tours/101');
    expect(screen.getByText(/Бухта Русская/).parentElement?.textContent).toContain('черновик, на сайте не виден');
  });
});

describe('куда ведёт личное сообщение продавцу тура', () => {
  it('гида — в «Свои туры», оператора и неизвестного — в кабинет оператора', () => {
    expect(ownerBookingsUrl('guide', '7001')).toBe('https://vedarai.ru/hub/guide/own');
    expect(ownerBookingsListUrl('guide')).toBe('https://vedarai.ru/hub/guide/own');
    expect(ownerLeadUrl('guide', 'L1')).toBe('https://vedarai.ru/hub/guide/own');
    expect(ownerBookingsUrl('operator', '7001')).toBe('https://vedarai.ru/hub/operator/bookings/7001');
    expect(ownerBookingsListUrl(null)).toBe('https://vedarai.ru/hub/operator/bookings');
    expect(ownerLeadUrl(undefined, 'L1')).toBe('https://vedarai.ru/hub/operator/leads/L1');
  });
});
