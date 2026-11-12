// @vitest-environment jsdom
/**
 * Анимации обстановки на десктопе (12.11, владелец: «и десктопную версию
 * тоже не забывай»). На десктопной главной своя сводка, своя лента «Что
 * меняет план» и навигация в шапке, а не нижнее меню — у каждой своя пара
 * к телефону:
 * - возраст статуса мест под сводкой — та же метка и точка, что у радара,
 *   идёт сам, пульс только у свежих, «не знаем» — словами;
 * - новая строка «Что меняет план» подсвечена один раз, первый визит — нет;
 * - полоска под пунктом шапки стоит под текущим адресом и переезжает по
 *   нажатию, но не по отменённому переходу; `aria-current` — у адреса.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { DeskFreshness } from '@/components/homepage/desk/DeskFreshness';
import { DeskChangeRows } from '@/components/homepage/desk/DeskChangeRows';
import { SEEN_ALERTS_KEY } from '@/lib/safety/new-alerts';
import type { PlanChange } from '@/lib/home/desk-brief';

const pathState = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathState.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, onClick, ...rest }: { href: string; children: React.ReactNode; onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void }) => (
    <a href={href} {...rest} onClick={(e) => { onClick?.(e); e.preventDefault(); }}>{children}</a>
  ),
}));

import { Header, headerNavIndex } from '@/components/layout/Header';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  pathState.pathname = '/';
  try { window.localStorage.clear(); } catch { /* jsdom */ }
});

describe('сводка дня: возраст статуса мест', () => {
  it('первый рендер — по «сейчас» сервера, дальше время идёт само', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T10:05:00Z'));
    const { container } = render(<DeskFreshness updatedAt="2026-11-12T09:57:00Z" serverNow="2026-11-12T10:00:00Z" />);
    // Эффект уже взял своё время: 10:05 − 9:57 = 8 минут.
    expect(screen.getByText('Статус мест: обновлено 8 минут назад')).toBeInTheDocument();
    expect(container.querySelector('[data-freshness="fresh"]')).toHaveAttribute('data-pulse', 'on');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Статус мест: обновлено 9 минут назад')).toBeInTheDocument();
  });

  it('устаревшие — без пульса, «не знаем» — словами и без цвета', () => {
    const { container, rerender } = render(<DeskFreshness updatedAt="2026-11-12T01:00:00Z" serverNow="2026-11-12T10:00:00Z" />);
    expect(container.querySelector('[data-desk-freshness]')).toHaveAttribute('data-desk-freshness', 'stale');
    expect(container.querySelector('[data-freshness]')).toHaveAttribute('data-pulse', 'off');
    rerender(<DeskFreshness updatedAt={null} serverNow="2026-11-12T10:00:00Z" />);
    expect(screen.getByText('Статус мест: обстановка недоступна')).toBeInTheDocument();
    expect(container.querySelector('[data-freshness="unavailable"]')).not.toHaveAttribute('data-pulse');
  });
});

describe('«Что меняет план»: новая строка', () => {
  const row = (what: string, key: string): PlanChange => ({ place: null, what, kind: 'road', kindLabel: 'дороги', term: null, origin: 'МЧС', key });

  it('подсвечивает то, чего этот браузер не показывал, и запоминает', async () => {
    window.localStorage.setItem(SEEN_ALERTS_KEY, JSON.stringify(['old|1']));
    const { container } = render(<DeskChangeRows changes={[row('Перевал закрыт', 'new|2'), row('Паводок', 'old|1')]} />);
    await waitFor(() => expect(container.querySelectorAll('a[data-new="true"]')).toHaveLength(1));
    expect(container.querySelector('a[data-new="true"]')).toHaveTextContent('Перевал закрыт');
    expect(JSON.parse(window.localStorage.getItem(SEEN_ALERTS_KEY) ?? '[]')).toContain('new|2');
  });

  it('первый визит — ничего не подсвечено', async () => {
    const { container } = render(<DeskChangeRows changes={[row('Паводок', 'old|1')]} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelectorAll('a[data-new="true"]')).toHaveLength(0);
  });
});

describe('шапка: полоска под пунктом', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve(null) })));
    // jsdom не раскладывает: пункт i — 80px шириной, с шагом 100px.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'A' ? 80 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      const links = Array.from(this.parentElement?.querySelectorAll(':scope > a') ?? []);
      return links.indexOf(this) * 100;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('пункт текущего адреса — по префиксу', () => {
    expect(headerNavIndex('/catalog/tours/abc')).toBe(0);
    expect(headerNavIndex('/places/avachinsky')).toBe(3);
    expect(headerNavIndex('/')).toBe(-1);
    expect(headerNavIndex('/catalogue')).toBe(-1);
  });

  it('стоит под адресом и переезжает к нажатому', () => {
    pathState.pathname = '/routes';
    const { container } = render(<Header />);
    const nav = container.querySelector('nav') as HTMLElement;
    expect(nav.querySelector('a[aria-current="page"]')).toHaveTextContent('Маршруты');
    const bar = () => nav.querySelector('[data-nav-bar]') as HTMLElement;
    expect(bar()).toHaveAttribute('data-nav-bar', '2');
    expect(bar().style.left).toBe('210px');
    expect(bar().style.width).toBe('60px');
    // Первое появление — без перехода.
    expect(bar().className).toBe('');
    fireEvent.click(within(nav).getByRole('link', { name: 'Карта' }));
    expect(bar()).toHaveAttribute('data-nav-bar', '4');
    expect(bar().style.left).toBe('410px');
    expect(bar().className).toMatch(/motion-reduce:transition-none/);
    // Текущим остаётся адрес, пока страница не сменилась.
    expect(nav.querySelector('a[aria-current="page"]')).toHaveTextContent('Маршруты');
  });

  it('на главной полоски нет; клик с Ctrl её не двигает', () => {
    const { container } = render(<Header />);
    const nav = container.querySelector('nav') as HTMLElement;
    expect(nav.querySelector('[data-nav-bar]')).toBeNull();
    fireEvent.click(within(nav).getByRole('link', { name: 'Туры' }), { ctrlKey: true });
    expect(nav.querySelector('[data-nav-bar]')).toBeNull();
  });
});
