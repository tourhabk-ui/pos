/**
 * Оболочка /kuzmich на телефоне (аудит 24.10): новый чат, чипы после
 * восстановления истории, короткий плейсхолдер, таб-бар как на главной.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/kuzmich',
}));
vi.mock('next/image', () => ({
  default: (props: { alt?: string }) => <span role="img" aria-label={props.alt ?? ''} />,
}));

import KuzmichClient from '@/app/kuzmich/_KuzmichClient';
import KuzmichPage from '@/app/kuzmich/page';

vi.mock('@/components/layout/Header', () => ({ Header: () => <header /> }));

const HISTORY = {
  data: {
    messages: [
      { role: 'user', content: 'Что посмотреть за 5 дней?' },
      { role: 'assistant', content: 'День 1 — берег' },
    ],
  },
};

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const json = u.includes('/api/ai/chat') ? HISTORY : { success: true, data: {} };
    return { ok: true, json: async () => json } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('чат Кузьмича', () => {
  it('после загрузки истории чипы на месте, плейсхолдер короткий', async () => {
    render(<KuzmichClient />);
    await screen.findByText('Что посмотреть за 5 дней?');
    expect(screen.getByRole('button', { name: /Что посмотреть за 5 дней/ })).toBeTruthy();
    expect(screen.getByPlaceholderText('Куда и на сколько дней')).toBeTruthy();
  });

  it('«Новый чат» стирает историю и пишет новый ключ сессии', async () => {
    render(<KuzmichClient />);
    await screen.findByText('День 1 — берег');
    fireEvent.click(screen.getByRole('button', { name: 'Новый чат' }));
    expect(screen.queryByText('День 1 — берег')).toBeNull();
    expect(localStorage.getItem('th_kuzmich_session')).toBeTruthy();
    expect(screen.getByText('Быстрые запросы:')).toBeTruthy();
  });
});

describe('страница /kuzmich', () => {
  it('нижний таб-бар с Кузьмичом, как на главной', async () => {
    render(<KuzmichPage />);
    const nav = screen.getByRole('navigation', { name: 'Основная навигация' });
    await waitFor(() => expect(nav.querySelector('a[href="/kuzmich"]')).toBeTruthy());
    expect(nav.querySelector('a[href="/"]')).toBeTruthy();
    expect(nav.querySelector('a[href="/catalog"]')).toBeTruthy();
  });
});
