/**
 * SOS внутри мини-приложения MAX (слово владельца 27.11: «1 да 2 да, делай
 * шаг с SOS в MAX»; docs/CHAT_MINIAPPS_PLAN.md §4, п. 9).
 *
 * Пока проба на телефоне не подтвердила в WebView мессенджера геолокацию,
 * звонок и service worker, кнопка SOS в узком входе `/map/compact` открывает
 * `/sos` во внешнем браузере через мост MAX, а рядом — простая ссылка на 112 с
 * подписью «в мессенджере место может не передаться». Своей кнопки нет.
 *
 * Сторож держит поведение:
 *  - мост: «внутри MAX» — непустая `initData`, а не наличие объекта (скрипт
 *    грузится и в обычном браузере); нет метода или он бросил — «не вышло»;
 *  - кнопка: внутри MAX на узком входе — внешний браузер; без моста, вне
 *    узкого входа и без сети — прежний путь;
 *  - строка 112 — рендером; мост грузится только на узком входе, и CSP
 *    разрешает его только там.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/map/compact', useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({
  default: ({ href, onClick, children, ...rest }: { href: string; onClick?: React.MouseEventHandler<HTMLAnchorElement>; children: React.ReactNode }) =>
    <a href={href} onClick={onClick} {...rest}>{children}</a>,
}));
vi.mock('next/script', () => ({ default: (p: { src: string }) => <script data-src={p.src} /> }));
vi.mock('@/lib/map/map-focus', () => ({ loadMapFocus: vi.fn() }));
vi.mock('@/app/map/_MapPageClient', () => ({ default: () => <div data-testid="map-client" /> }));

import { EmergencyAction, EmergencyMiniAppLine, MINIAPP_SOS_NOTE } from '@/components/shared/EmergencyAction';
import { MAX_BRIDGE_SRC, miniAppBridge } from '@/lib/miniapp/bridge';
import MapCompactPage from '@/app/map/compact/page';

const win = window as unknown as { WebApp?: unknown };
let openLink: ReturnType<typeof vi.fn>;
beforeEach(() => {
  openLink = vi.fn();
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
});
afterEach(() => {
  cleanup();
  delete win.WebApp;
  router.push.mockReset();
  window.history.pushState({}, '', '/');
});

const inMax = () => { win.WebApp = { initData: 'query_id=1&auth_date=1&hash=x', openLink }; };
const at = (path: string) => window.history.pushState({}, '', path);
const press = () => fireEvent.click(screen.getByRole('link', { name: /SOS/ }));

describe('мост MAX', () => {
  it('вне MAX — null: нет объекта, пустая initData, нет openLink', () => {
    expect(miniAppBridge({})).toBeNull();
    expect(miniAppBridge({ WebApp: { initData: '', openLink } })).toBeNull();
    expect(miniAppBridge({ WebApp: { initData: 'a=1' } })).toBeNull();
    expect(miniAppBridge(undefined)).toBeNull();
  });

  it('внутри MAX — открывает ссылку; метод бросил — «не вышло», а не тишина', () => {
    const b = miniAppBridge({ WebApp: { initData: 'a=1', openLink } });
    expect(b?.openLink('https://vedarai.ru/sos')).toBe(true);
    expect(openLink).toHaveBeenCalledWith('https://vedarai.ru/sos');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = miniAppBridge({ WebApp: { initData: 'a=1', openLink: () => { throw new Error('no host'); } } });
    expect(broken?.openLink('https://vedarai.ru/sos')).toBe(false);
  });
});

describe('кнопка SOS', () => {
  it('внутри MAX на узком входе — /sos во внешнем браузере, переход в WebView не идёт', () => {
    at('/map/compact');
    inMax();
    render(<EmergencyAction />);
    const notPrevented = press();
    expect(openLink).toHaveBeenCalledWith(`${window.location.origin}/sos`);
    expect(notPrevented).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('узкий вход в обычном браузере (моста нет) — обычная ссылка на /sos', () => {
    at('/map/compact');
    render(<EmergencyAction />);
    expect(press()).toBe(true);
    expect(screen.getByRole('link', { name: /SOS/ }).getAttribute('href')).toBe('/sos');
  });

  it('мост открыть не смог — обычная ссылка, а не пустое нажатие', () => {
    at('/map/compact');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    win.WebApp = { initData: 'a=1', openLink: () => { throw new Error('no host'); } };
    render(<EmergencyAction />);
    expect(press()).toBe(true);
  });

  it('вне узкого входа мост не трогается', () => {
    at('/map');
    inMax();
    render(<EmergencyAction />);
    expect(press()).toBe(true);
    expect(openLink).not.toHaveBeenCalled();
  });

  it('без сети — прежняя офлайн-ветка, даже внутри MAX', () => {
    at('/map/compact');
    inMax();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    const fallback = vi.fn();
    render(<EmergencyAction onOfflineFallback={fallback} />);
    expect(press()).toBe(false);
    expect(fallback).toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
  });
});

describe('строка 112 и мост на узком входе', () => {
  it('рядом с SOS — простая ссылка на 112 и подпись про место', () => {
    render(<EmergencyMiniAppLine />);
    const call = screen.getByRole('link', { name: 'Позвонить 112' });
    expect(call.getAttribute('href')).toBe('tel:112');
    expect(screen.getByText(new RegExp(MINIAPP_SOS_NOTE)).textContent).toMatch(/Кнопка SOS откроет страницу помощи в браузере/);
  });

  it('страница узкого входа подключает мост MAX', async () => {
    const el = await MapCompactPage({ searchParams: Promise.resolve({}) });
    const { container } = render(el);
    expect(container.querySelector(`script[data-src="${MAX_BRIDGE_SRC}"]`)).not.toBeNull();
  });

  it('CSP: мост разрешён только узкому входу, остальное — как у страниц сайта', async () => {
    const cfg = (await import('../../next.config.js')) as unknown as { default?: { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> }; headers?: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    const headers = await (cfg.headers ? cfg.headers() : cfg.default!.headers());
    const csp = (source: string) => headers.find((b) => b.source === source)?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    const page = csp('/:path((?!widget/).*)');
    const compact = csp('/map/compact');
    expect(page).not.toMatch(/st\.max\.ru/);
    expect(compact).toMatch(/script-src [^;]* https:\/\/st\.max\.ru;/);
    expect(compact.replace(' https://st.max.ru;', ';')).toBe(page);
    expect(headers.findIndex((b) => b.source === '/map/compact')).toBeGreaterThan(headers.findIndex((b) => b.source === '/:path((?!widget/).*)'));
  });
});
