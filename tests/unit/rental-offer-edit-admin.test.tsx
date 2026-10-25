/**
 * Одобрение правки прайса — на /hub/admin/moderation.
 * Отказ загрузки не выглядит как пустая очередь.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { formatRub } from '@/lib/transfers/charter-format';

vi.mock('@/components/auth/Protected', () => ({
  Protected: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import ModerationClient from '@/app/hub/admin/moderation/_ModerationClient';

const EDIT = {
  id: '33333333-3333-4333-8333-333333333333',
  partnerName: 'Лагуна Прокат',
  title: 'Suzuki Jimny',
  livePrice: 7000,
  priceIsFrom: false,
  liveConditions: null,
  draftPrice: 8500,
  draftConditions: 'пробег <без> лимита',
  createdAt: '2026-10-24T01:00:00.000Z',
};

afterEach(() => cleanup());

function serve(editsStatus: number) {
  const posts: { url: string; body: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/admin/content/reviews')) {
      return new Response(JSON.stringify({ success: true, data: { reviews: [] } }));
    }
    if (url.includes('/api/admin/moderation/rental-edits/') && init?.method === 'POST') {
      posts.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ success: true }));
    }
    if (url.includes('/api/admin/moderation/rental-edits')) {
      if (editsStatus !== 200) {
        return new Response(JSON.stringify({ success: false, error: 'Не смог прочитать правки прайса' }), { status: editsStatus });
      }
      return new Response(JSON.stringify({ success: true, data: { edits: [EDIT] } }));
    }
    return new Response('{}', { status: 404 });
  }));
  return posts;
}

describe('модерация правки прайса', () => {
  it('показывает старую и новую цену, описание текстом, и одобряет', async () => {
    const posts = serve(200);
    render(React.createElement(ModerationClient));
    expect(await screen.findByText('Лагуна Прокат')).toBeTruthy();
    expect(screen.getByText('Suzuki Jimny')).toBeTruthy();
    expect(screen.getByText('пробег <без> лимита')).toBeTruthy();
    expect(screen.getByText(/описания нет/)).toBeTruthy();
    const price = screen.getByText(/Цена за сутки/).parentElement?.textContent ?? '';
    expect(price).toContain(formatRub(7000));
    expect(price).toContain(formatRub(8500));
    expect(document.body.textContent).not.toMatch(/\+7|@/);
    fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toContain(EDIT.id);
    expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({
      action: 'approve', seenPrice: 8500, seenConditions: 'пробег <без> лимита',
    });
  });

  it('черновик изменился — причина видна и карточка показывает новую правку', async () => {
    let listed = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/admin/content/reviews')) {
        return new Response(JSON.stringify({ success: true, data: { reviews: [] } }));
      }
      if (url.includes('/api/admin/moderation/rental-edits/') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          success: false, code: 'changed',
          error: 'Прокатчик изменил черновик, пока карточка была открыта. Прайс не изменён — проверьте новую правку.',
        }), { status: 409 });
      }
      listed += 1;
      const edit = listed === 1 ? EDIT : { ...EDIT, draftPrice: 80000 };
      return new Response(JSON.stringify({ success: true, data: { edits: [edit] } }));
    }));
    render(React.createElement(ModerationClient));
    fireEvent.click(await screen.findByRole('button', { name: 'Одобрить' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Прайс не изменён');
    await waitFor(() => {
      const price = screen.getByText(/Цена за сутки/).parentElement?.textContent ?? '';
      expect(price).toContain(formatRub(80000));
    });
  });

  it('отклонить без причины нельзя', async () => {
    const posts = serve(200);
    render(React.createElement(ModerationClient));
    const reject = await screen.findByRole('button', { name: 'Отклонить' });
    expect(reject).toHaveProperty('disabled', true);
    fireEvent.click(reject);
    expect(posts).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'не та' } });
    expect(screen.getByRole('button', { name: 'Отклонить' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({ action: 'reject', reason: 'не та' });
  });

  it('отказ загрузки не называется пустой очередью', async () => {
    serve(503);
    render(React.createElement(ModerationClient));
    expect(await screen.findByText(/Не смог загрузить правки прайса/)).toBeTruthy();
    expect(screen.queryByText('Правок прайса проката нет.')).toBeNull();
  });
});
