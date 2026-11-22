// @vitest-environment jsdom
/**
 * Первый экран планирования и экран входа в конструктор (21.11, владелец:
 * «смотрю основные уходы … и планинга», «проверь логи и нужно разобраться с
 * причиной такого поведения»).
 *
 * Держит:
 *   — на /planning популярные маршруты стоят сразу под поиском, до чек-листа:
 *     на телефоне они были за первым экраном, и без набора текста человек не
 *     видел ни одного маршрута;
 *   — у главной кнопки сказано, что конструктор открывается после входа;
 *   — экран входа в конструктор не тупик: план в чате с Кузьмичом, туры и
 *     маршруты без входа;
 *   — ссылку за сметой на /planner держит trip-facts-pages.test.tsx.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { PlannerLoginGate, PLANNER_NO_LOGIN_ASK } from '@/components/planner/PlannerLoginGate';
import { kuzmichAskHref } from '@/lib/kuzmich/ask-link';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('экран входа в конструктор — не тупик', () => {
  it('без входа: план в чате с Кузьмичом, туры, маршруты', () => {
    render(<PlannerLoginGate gate="sign_in" />);
    const hrefOf = (name: RegExp) => screen.getByRole('link', { name }).getAttribute('href');
    expect(hrefOf(/План в чате с Кузьмичом/)).toBe(kuzmichAskHref(PLANNER_NO_LOGIN_ASK));
    expect(hrefOf(/^Туры$/)).toBe('/catalog');
    expect(hrefOf(/^Маршруты$/)).toBe('/routes');
    expect(screen.getByRole('link', { name: /Войти/ })).toBeTruthy();
  });

  it('«не смогли проверить вход» — без обходных ссылок: там надо просто обновить', () => {
    render(<PlannerLoginGate gate="unchecked" />);
    expect(screen.queryByRole('link', { name: /Кузьмичом/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Обновить/ })).toBeTruthy();
  });
});

vi.mock('next/image', () => ({ default: (p: { alt: string }) => <span role="img" aria-label={p.alt} /> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
// Хранилище офлайн-карт в jsdom нет — первый экран от него не зависит.
vi.mock('@/lib/offline/useOfflineRegion', () => ({
  useOfflineRegion: () => ({ status: 'idle', progress: null, regionMeta: null, error: null, download: vi.fn(), remove: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planning',
  useSearchParams: () => new URLSearchParams(),
}));

describe('первый экран /planning', () => {
  it('популярные маршруты — до чек-листа готовности; у кнопки конструктора сказано про вход', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/routes')) {
        return new Response(JSON.stringify({ success: true, data: [{ id: 'r1', title: 'Вулкан Авачинский', difficulty: null }] }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    const { PlanningClient } = await import('@/app/planning/_PlanningClient');
    render(<PlanningClient />);
    const popular = await waitFor(() => screen.getByRole('heading', { name: 'Популярные маршруты' }));
    const readiness = screen.getByRole('heading', { name: 'Готовность к походу' });
    expect(popular.compareDocumentPosition(readiness) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/с турами операторов — после входа/)).toBeTruthy();
  });
});
