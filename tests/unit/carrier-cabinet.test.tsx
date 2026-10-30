/**
 * Кабинет перевозчика после 13.10 — рендером (владелец: «у нас не правильная
 * логика бронируют целую машину а не место в ней»).
 *
 *   — кабинет — парк машин и слова о том, как заказывают машину целиком;
 *     завести поездку с местами нельзя: вкладки «Поездки» нет, адреса
 *     /api/hub/carrier/trips экран не зовёт;
 *   — запросы мест, которые ещё ждут ответа, видны под парком, пока они есть;
 *     ответить на них можно; нет таких — раздела нет;
 *   — не прочитались — «не смогли прочитать», а не тишина (§4.0);
 *   — во «Входящих» перевозчика ждёт ответа заявка на машину (#2862), и
 *     отвечают на неё прямо там; запросов мест в ящике нет.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';

import CarrierClient from '@/app/hub/carrier/_CarrierClient';
import { INBOX_BY_CATEGORY, INBOX_NOT_HERE, inboxActionFor } from '@/lib/crm/inbox-kinds';

const VEHICLE = { id: 'v1', kind: 'vahtovka', title: 'КамАЗ синяя', seats: 26, notes: null, is_active: true };
const REQUEST = {
  id: 'r1', trip_id: 't1', seats: 2, price: null, status: 'requested', comment: null, contact_phone: null,
  trip_date: '2026-10-20', from_text: 'Петропавловск', to_text: 'Вулкан Горелый', vehicle_title: 'КамАЗ синяя',
  ordered_by_partner_name: null,
};

type Reply = { ok: boolean; status?: number; body: unknown };
let replies: Record<string, Reply> = {};
let calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  calls = [];
  replies = {
    '/api/hub/carrier/vehicles': { ok: true, body: { success: true, data: [VEHICLE] } },
    '/api/hub/carrier/requests?status=requested': { ok: true, body: { success: true, data: [] } },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    const r = replies[String(url)] ?? { ok: true, body: { success: true, data: {} } };
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('кабинет перевозчика — машина целиком', () => {
  it('парк и слова о заказе машины целиком; поездок с местами не завести', async () => {
    render(<CarrierClient />);
    await screen.findByText('КамАЗ синяя');
    expect(screen.getByText(/Машину заказывают целиком/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Парк/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Поездки/ })).toBeNull();
    expect(screen.queryByText(/Завести поездку|выставить .*в витрину|за место/)).toBeNull();
    // Пустых запросов нет — нет и раздела.
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/hub/carrier/requests'))).toBe(true));
    expect(screen.queryByTestId('seat-requests-left')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/hub/carrier/trips'))).toBe(false);
  });

  it('ждущий ответа запрос мест виден под парком, и на него можно ответить', async () => {
    replies['/api/hub/carrier/requests?status=requested'] = { ok: true, body: { success: true, data: [REQUEST] } };
    replies['/api/hub/carrier/requests/r1'] = { ok: true, body: { success: true, data: {} } };
    render(<CarrierClient />);
    const left = await screen.findByTestId('seat-requests-left');
    expect(left.textContent).toMatch(/новых запросов с витрины не будет/);
    expect(within(left).getByText(/Вулкан Горелый/)).toBeTruthy();
    fireEvent.click(within(left).getByRole('button', { name: /Подтвердить/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/hub/carrier/requests/r1' && c.method === 'POST')).toBe(true));
  });

  it('запросы не прочитались — так и сказано, а не тишина', async () => {
    replies['/api/hub/carrier/requests?status=requested'] = { ok: false, status: 503, body: { success: false, error: 'База недоступна' } };
    render(<CarrierClient />);
    const left = await screen.findByTestId('seat-requests-left');
    expect(left.textContent).toMatch(/Не смогли прочитать запросы мест: База недоступна\. Это не значит, что их нет/);
  });
});

describe('«Входящие» перевозчика', () => {
  it('ждёт ответа заявка на машину, отвечают прямо во «Входящих»; строки «ведёт менеджер» больше нет (#2862)', () => {
    expect(INBOX_BY_CATEGORY.transfer).toEqual(['charter_request']);
    expect(INBOX_NOT_HERE.transfer.join(' ')).not.toMatch(/менеджер/);
    const action = inboxActionFor('transfer', 'charter_request');
    expect(action.href).toBeNull();
    expect(action.hint).toMatch(/«Беру» или «Не могу»/);
  });
});
