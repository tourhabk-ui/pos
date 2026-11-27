/**
 * Узкий вход в карту обстановки `/map/compact` — то, что откроет мини-
 * приложение MAX (задача владельца 27.11; «без геолокации» — слово владельца
 * того же дня). Та же карта `/map`, без обвязки сайта.
 *
 * Рендером и вызовом:
 *  - признак пути и страница: узкий режим, место по ссылке, в поиск не идёт;
 *  - в узком входе нет кабинета, «моё место», «Я вернулся», нижней навигации
 *    и помощника; SOS — та же `EmergencyAction`, одна;
 *  - к геолокации узкий вход не обращается вовсе: геофенс `/map` при
 *    монтировании запускает слежение GPS, и это видно в контрольном рендере;
 *  - по таблице docs/CHAT_MINIAPPS_PLAN.md §6.1 молчат Метрика с баннером
 *    согласия, приглашение поставить приложение и фоновая запись места.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { MapFocus } from '@/lib/map/map-target';

const nav = vi.hoisted(() => ({ pathname: '/map/compact' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<unknown>) => {
    const src = String(loader);
    if (src.includes('PlaceMapSheet')) {
      return function SheetStub(p: { initialData: { title: string } }) { return <div data-testid="sheet">{p.initialData.title}</div>; };
    }
    return function NoneStub() { return null; };
  },
}));
vi.mock('next/link', () => ({ default: (p: { href: string; children: React.ReactNode; 'aria-label'?: string }) => <a href={p.href} aria-label={p['aria-label']}>{p.children}</a> }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ isDark: false, toggleTheme: vi.fn() }) }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => <nav data-testid="bottom-nav" /> }));
vi.mock('@/components/shared/EmergencyAction', () => ({
  default: () => <button type="button">SOS</button>,
  EmergencyMiniAppLine: () => <p data-testid="sos-112-line" />,
}));
vi.mock('next/script', () => ({ default: () => null }));
vi.mock('@/components/shared/AssistantButton', () => ({ AssistantButton: () => <div data-testid="assistant" /> }));
vi.mock('@/components/shared/Logo', () => ({ default: () => null }));
vi.mock('@/hooks/use-mesh', () => ({ useMesh: () => ({ peers: [] }) }));
vi.mock('@/hooks/useMapQuakes', () => ({ useMapQuakes: () => ({ quakes: [], state: 'ready' }), MAP_QUAKE_HOURS: 24 }));
vi.mock('@/lib/offline/db', () => ({ getAllOfflineRoutes: async () => [] }));

const pageMocks = vi.hoisted(() => ({ props: null as Record<string, unknown> | null, loadMapFocus: vi.fn() }));
vi.mock('@/lib/map/map-focus', () => ({ loadMapFocus: pageMocks.loadMapFocus }));

import MapPageClient from '@/app/map/_MapPageClient';
import MapCompactPage, { metadata as compactMeta } from '@/app/map/compact/page';
import { MINIAPP_MAP_PATH, isForeignSurface, isMiniAppPath } from '@/lib/embed/widget-frame';
import { installPromptHiddenOn } from '@/components/PWA/InstallPrompt';
import ThirdPartyScripts from '@/components/legal/ThirdPartyScripts';
import { LastPositionTracker } from '@/components/tracking/LastPositionTracker';

let watch: ReturnType<typeof vi.fn>;
let current: ReturnType<typeof vi.fn>;
let permQuery: ReturnType<typeof vi.fn>;
beforeEach(() => {
  watch = vi.fn(() => 1);
  current = vi.fn();
  permQuery = vi.fn(async () => ({ state: 'granted' }));
  Object.defineProperty(window.navigator, 'geolocation', {
    configurable: true, value: { watchPosition: watch, getCurrentPosition: current, clearWatch: vi.fn() },
  });
  Object.defineProperty(window.navigator, 'permissions', { configurable: true, value: { query: permQuery } });
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); nav.pathname = '/map/compact'; pageMocks.loadMapFocus.mockReset(); localStorage.clear(); });

const FOCUS: MapFocus = { state: 'place', place: { id: 'ark-1', title: 'Вулкан Мутновский', locationType: 'volcano', lat: 52.45, lng: 158.2 } };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('признак узкого входа', () => {
  it('/map/compact и вложенные — да; /map и похожие — нет; своя поверхность, не чужая', () => {
    expect(MINIAPP_MAP_PATH).toBe('/map/compact');
    expect(isMiniAppPath('/map/compact')).toBe(true);
    expect(isMiniAppPath('/map/compact/x')).toBe(true);
    for (const p of ['/map', '/map/compactX', '/compact', null, undefined]) expect(isMiniAppPath(p)).toBe(false);
    expect(isForeignSurface('/map/compact', 'vedarai.ru')).toBe(false);
  });
});

describe('страница /map/compact', () => {
  it('отдаёт ту же карту в узком режиме — с местом по ссылке MAX', async () => {
    pageMocks.loadMapFocus.mockResolvedValue(FOCUS);
    const el = await MapCompactPage({ searchParams: Promise.resolve({ WebAppStartParam: 'place-mutnovsky' }) });
    expect(pageMocks.loadMapFocus).toHaveBeenCalledWith('mutnovsky');
    const kids = React.Children.toArray((el.props as { children: React.ReactNode }).children) as React.ReactElement[];
    const client = kids.find((k) => k.type === MapPageClient);
    expect(client?.props).toMatchObject({ compact: true, focus: FOCUS, openSafety: false });
  });

  it('в поиск не идёт, каноническая страница — /map', () => {
    expect(compactMeta.robots).toMatchObject({ index: false });
    expect(compactMeta.alternates?.canonical).toBe('/map');
  });
});

describe('что видно в узком входе', () => {
  it('нет кабинета, «моё место», «Я вернулся», нижней навигации и помощника; SOS — один', async () => {
    render(<MapPageClient mapPackBaseUrl={null} compact focus={FOCUS} />);
    await settle();
    expect(screen.queryByLabelText('Личный кабинет')).toBeNull();
    expect(screen.queryByLabelText('Показать моё местоположение')).toBeNull();
    expect(screen.queryByText('Я вернулся')).toBeNull();
    expect(screen.queryByTestId('bottom-nav')).toBeNull();
    expect(screen.queryByTestId('assistant')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'SOS' })).toHaveLength(1);
    // Рядом с SOS — строка со звонком 112 (план §4, п. 9; tests/unit/miniapp-sos).
    expect(screen.getByTestId('sos-112-line')).toBeTruthy();
    expect(screen.getByTestId('sheet').textContent).toBe('Вулкан Мутновский');
  });

  it('без сети — нет ссылки на офлайн-пакеты и кнопки GPS: полевой контур не выносится', async () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    const { container } = render(<MapPageClient mapPackBaseUrl={null} compact />);
    await settle();
    expect(screen.getByText('Офлайн')).toBeTruthy();
    expect(container.querySelector('a[href="/offline/manage"]')).toBeNull();
    expect(screen.queryByText('GPS')).toBeNull();
    expect(watch).not.toHaveBeenCalled();
    cleanup();
    const full = render(<MapPageClient mapPackBaseUrl={null} />);
    await settle();
    expect(full.container.querySelector('a[href="/offline/manage"]')).not.toBeNull();
    expect(screen.getByText('GPS')).toBeTruthy();
  });

  it('к геолокации не обращается; контроль — обычная /map слежение запускает', async () => {
    render(<MapPageClient mapPackBaseUrl={null} compact />);
    await settle();
    expect(watch).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    cleanup();
    render(<MapPageClient mapPackBaseUrl={null} />);
    await settle();
    expect(watch).toHaveBeenCalled();
    expect(screen.getByLabelText('Личный кабинет')).toBeTruthy();
    expect(screen.queryByTestId('sos-112-line')).toBeNull();
    expect(screen.getByTestId('bottom-nav')).toBeTruthy();
  });
});

describe('общее сайта в мини-приложении молчит', () => {
  it('приглашение поставить приложение — скрыто', () => {
    expect(installPromptHiddenOn('/map/compact')).toBe(true);
    expect(installPromptHiddenOn('/map')).toBe(false);
  });

  it('Метрика и баннер согласия — не рисуются; на /map баннер есть', async () => {
    nav.pathname = '/map/compact';
    const { container, unmount } = render(<ThirdPartyScripts />);
    await settle();
    expect(container.innerHTML).toBe('');
    unmount();
    nav.pathname = '/map';
    const other = render(<ThirdPartyScripts />);
    await settle();
    expect(other.container.innerHTML).not.toBe('');
  });

  it('фоновая запись места — не запускается; на других страницах запускается', async () => {
    nav.pathname = '/map/compact';
    const a = render(<LastPositionTracker />);
    await settle();
    expect(permQuery).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    a.unmount();
    nav.pathname = '/catalog';
    render(<LastPositionTracker />);
    await settle();
    expect(permQuery).toHaveBeenCalled();
  });
});
