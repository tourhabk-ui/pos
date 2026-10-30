/**
 * Прайс и парк перевозчика в кабинете на сайте (#2862 этап C) — рендером.
 *
 *  - строки прайса с живой ценой, черновик на модерации — рядом; отказ — с
 *    причиной модератора;
 *  - «Изменить» → форма → POST /api/hub/carrier/prices только с тем, что
 *    заполнено, и с priceId; «Добавить строку» → POST без priceId;
 *  - не прочитался прайс — «не смогли прочитать», не тишина (§4.0);
 *  - машина: «Снять с линии» → PATCH /api/hub/carrier/vehicles/[id]
 *    { is_active: false }; число мест можно не записывать (null).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';

import CarrierClient from '@/app/hub/carrier/_CarrierClient';
import { formatRub } from '@/lib/transfers/charter-format';

const PRICE = '11111111-1111-4111-8111-111111111111';
const VEHICLE = { id: 'v1', kind: 'vahtovka', title: 'КамАЗ синяя', seats: 26, notes: null, is_active: true };
const ROW = {
  id: PRICE, vehicleKind: 'vahtovka', lineKind: 'destination', fromText: 'Петропавловск', toText: 'Авачинский перевал',
  priceRub: 65000, priceNote: 'плюс переправы', conditions: null, validYear: 2026, isActive: true,
};
const PENDING = {
  id: 'd1', priceId: PRICE, priceRub: 70000, priceNote: null, conditions: null, isActive: null,
  vehicleKind: null, lineKind: null, fromText: null, toText: null, validYear: null,
  status: 'pending', reason: null, createdAt: '2026-10-30T00:00:00Z', moderatedAt: null,
};
const REJECTED = {
  ...PENDING, id: 'd2', priceRub: 1, status: 'rejected', reason: 'опечатка в цене', moderatedAt: '2026-10-29T10:00:00Z',
};

type Reply = { ok: boolean; status?: number; body: unknown };
let replies: Record<string, Reply> = {};
let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  replies = {
    '/api/hub/carrier/vehicles': { ok: true, body: { success: true, data: [VEHICLE] } },
    '/api/hub/carrier/requests?status=requested': { ok: true, body: { success: true, data: [] } },
    '/api/hub/carrier/prices': { ok: true, body: { success: true, data: { rows: [ROW], drafts: [PENDING, REJECTED] } } },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : undefined });
    const key = method === 'GET' ? String(url) : `${method} ${String(url)}`;
    const r = replies[key] ?? replies[String(url)] ?? { ok: true, body: { success: true, data: {}, message: 'ок' } };
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('прайс перевозчика в кабинете', () => {
  it('строка с живой ценой, черновик на модерации рядом, причина отказа — словами модератора', async () => {
    render(<CarrierClient />);
    const board = await screen.findByTestId('charter-price-board');
    const row = within(board).getByTestId('price-row');
    expect(row.textContent).toContain('Петропавловск — Авачинский перевал (вахтовка)');
    expect(row.textContent).toContain(`${formatRub(65000)} за машину`);
    expect(row.textContent).toContain('плюс переправы');
    expect(row.textContent).toContain(`Черновик на модерации: цена ${formatRub(70000)}`);
    const history = within(board).getByTestId('price-drafts-history');
    expect(history.textContent).toContain('отклонено');
    expect(history.textContent).toContain('причина: опечатка в цене');
    expect(board.textContent).toContain('пока её не одобрит администратор');
  });

  it('«Изменить» отправляет черновик только с заполненным и с priceId', async () => {
    replies['POST /api/hub/carrier/prices'] = { ok: true, status: 201, body: { success: true, message: 'Черновик записан' } };
    render(<CarrierClient />);
    const board = await screen.findByTestId('charter-price-board');
    fireEvent.click(within(board).getByRole('button', { name: /Изменить/ }));
    fireEvent.change(within(board).getByLabelText(/Новая цена/), { target: { value: '72000' } });
    fireEvent.change(within(board).getByLabelText(/На сайте/), { target: { value: 'hide' } });
    fireEvent.click(within(board).getByRole('button', { name: /Отправить на модерацию/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/hub/carrier/prices')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/hub/carrier/prices');
    expect(post?.body).toEqual({ priceId: PRICE, priceRub: 72000, isActive: false });
    // После записи прайс перечитан.
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/hub/carrier/prices').length).toBeGreaterThan(1));
  });

  it('«Добавить строку» — черновик новой строки без priceId; у тарифа направления нет', async () => {
    replies['POST /api/hub/carrier/prices'] = { ok: true, status: 201, body: { success: true, message: 'Черновик новой строки записан' } };
    render(<CarrierClient />);
    const board = await screen.findByTestId('charter-price-board');
    fireEvent.click(within(board).getByRole('button', { name: /Добавить строку прайса/ }));
    const form = within(board).getByTestId('new-price-form');
    fireEvent.change(within(form).getByLabelText(/За что цена/), { target: { value: 'per_hour' } });
    expect(within(form).queryByLabelText(/Куда/)).toBeNull();
    fireEvent.change(within(form).getByLabelText(/Цена, ₽ за машину/), { target: { value: '4500' } });
    fireEvent.change(within(form).getByLabelText(/Год прайса/), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: /Отправить на модерацию/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      vehicleKind: 'vahtovka', lineKind: 'per_hour', fromText: null, toText: null, priceRub: 4500, priceNote: null, conditions: null, validYear: null,
    });
  });

  it('прайс не прочитался — так и сказано, не «строк нет»', async () => {
    replies['/api/hub/carrier/prices'] = { ok: false, status: 503, body: { success: false, error: 'База недоступна' } };
    render(<CarrierClient />);
    const board = await screen.findByTestId('charter-price-board');
    await waitFor(() => expect(board.textContent).toContain('Не смогли прочитать прайс: База недоступна. Это не значит, что его нет.'));
    expect(board.textContent).not.toContain('Строк прайса пока нет');
  });
});

describe('парк перевозчика в кабинете', () => {
  it('«Снять с линии» — PATCH машины; форма правки шлёт места и заметку, пустые места — null', async () => {
    render(<CarrierClient />);
    const row = await screen.findByTestId('vehicle-row');
    fireEvent.click(within(row).getByRole('button', { name: 'Снять с линии' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/hub/carrier/vehicles/v1', body: { is_active: false } });

    fireEvent.click(within(row).getByRole('button', { name: /Изменить/ }));
    fireEvent.change(within(row).getByLabelText(/Мест/), { target: { value: '' } });
    fireEvent.change(within(row).getByLabelText(/Заметка/), { target: { value: 'лебёдка' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({ seats: null, notes: 'лебёдка' });
  });

  it('снятая машина подписана и предлагает вернуть', async () => {
    replies['/api/hub/carrier/vehicles'] = { ok: true, body: { success: true, data: [{ ...VEHICLE, is_active: false }] } };
    render(<CarrierClient />);
    const row = await screen.findByTestId('vehicle-row');
    expect(row.textContent).toContain('снята с линии');
    expect(within(row).getByRole('button', { name: 'Вернуть на линию' })).toBeTruthy();
  });
});
