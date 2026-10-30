/**
 * Очередь правок прайса перевозчиков на /hub/admin/moderation (#2862 этап C) — рендером.
 * Одобряется то, что видно в карточке: все поля черновика едут с решением.
 * Отказ загрузки не выглядит как пустая очередь.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';

vi.mock('@/components/auth/Protected', () => ({
  Protected: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import ModerationClient from '@/app/hub/admin/moderation/_ModerationClient';
import { formatRub } from '@/lib/transfers/charter-format';

const EDIT_ID = '33333333-3333-4333-8333-333333333333';
const NEW_ID = '44444444-4444-4444-8444-444444444444';
const DRAFT = {
  priceRub: 70000, priceNote: null, conditions: 'при расчёте <наличными>', isActive: false,
  vehicleKind: null, lineKind: null, fromText: null, toText: null, validYear: null,
};
const EDIT = {
  id: EDIT_ID, partnerName: 'Шатун', priceId: '11111111-1111-4111-8111-111111111111',
  live: {
    id: '11111111-1111-4111-8111-111111111111', vehicleKind: 'vahtovka', lineKind: 'destination', fromText: 'Петропавловск', toText: 'Авачинский',
    priceRub: 65000, priceNote: null, conditions: null, validYear: 2026, isActive: true,
  },
  draft: DRAFT,
  createdAt: '2026-10-30T01:00:00.000Z',
};
const NEW_ROW = {
  id: NEW_ID, partnerName: 'Шатун', priceId: null, live: null,
  draft: { priceRub: 15000, priceNote: null, conditions: null, isActive: null, vehicleKind: 'vahtovka', lineKind: 'extra_day', fromText: null, toText: null, validYear: 2026 },
  createdAt: '2026-10-30T02:00:00.000Z',
};

afterEach(() => cleanup());

function serve(status: number, edits: unknown[] = [EDIT, NEW_ROW]) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/admin/content/reviews')) return new Response(JSON.stringify({ success: true, data: { reviews: [] } }));
    if (url.includes('/api/admin/moderation/rental-edits')) return new Response(JSON.stringify({ success: true, data: { edits: [] } }));
    if (url.includes('/api/admin/moderation/charter-price-edits/') && init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ success: true }));
    }
    if (url.includes('/api/admin/moderation/charter-price-edits')) {
      if (status !== 200) return new Response(JSON.stringify({ success: false, error: 'Не смог прочитать правки прайса перевозчиков' }), { status });
      return new Response(JSON.stringify({ success: true, data: { edits } }));
    }
    return new Response('{}', { status: 404 });
  }));
  return posts;
}

describe('модерация прайса перевозчиков', () => {
  it('правка: старая → новая цена, условия текстом, видимость; новая строка — целиком; одобрение несёт все поля', async () => {
    const posts = serve(200);
    render(React.createElement(ModerationClient));
    const cards = await screen.findAllByTestId('charter-price-edit');
    expect(cards).toHaveLength(2);
    const edit = cards[0]!;
    expect(edit.textContent).toContain('Правка строки: Петропавловск — Авачинский (вахтовка)');
    expect(edit.textContent).toContain(`${formatRub(65000)} → ${formatRub(70000)}`);
    expect(edit.textContent).toContain('при расчёте <наличными>');
    expect(edit.textContent).toContain('показана → скрыта');
    const fresh = cards[1]!;
    expect(fresh.textContent).toContain('Новая строка: Доплата за день на месте (вахтовка)');
    expect(fresh.textContent).toContain(formatRub(15000));
    expect(fresh.textContent).toContain('2026');
    expect(document.body.textContent).not.toMatch(/\+7|@/);
    fireEvent.click(within(edit).getByRole('button', { name: 'Одобрить' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toContain(EDIT_ID);
    expect(posts[0]?.body).toEqual({ action: 'approve', seen: DRAFT });
  });

  it('отклонить без причины нельзя; причина уходит в решение', async () => {
    const posts = serve(200, [NEW_ROW]);
    render(React.createElement(ModerationClient));
    const card = await screen.findByTestId('charter-price-edit');
    const reject = within(card).getByRole('button', { name: 'Отклонить' });
    expect(reject).toHaveProperty('disabled', true);
    fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'такое направление уже есть' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Отклонить' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({ action: 'reject', reason: 'такое направление уже есть' });
  });

  it('отказ загрузки не называется пустой очередью', async () => {
    serve(503);
    render(React.createElement(ModerationClient));
    expect(await screen.findByText(/Не смог загрузить правки прайса перевозчиков/)).toBeTruthy();
    expect(screen.queryByText('Правок прайса перевозчиков нет.')).toBeNull();
  });
});
