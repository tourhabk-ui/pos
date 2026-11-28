/**
 * Карта обстановки по ссылке (задача владельца 27.11 «Карта обстановки
 * Ведара: точки с координатами и вход из MAX», шаг 1 — без мини-приложения).
 *
 * Сторож держит поведение, а не текст:
 *  - правило цели ссылки — вызовом: `?place=`, `?show=safety`, payload MAX
 *    (`WebAppStartParam`: `map`, `map-safety`, `place-…`, `volcano-…`), битое —
 *    обзор края, а не ошибка;
 *  - страница `/map` — вызовом серверного компонента: место ищется в базе, на
 *    карту уходит найденное или честное «не найдено»/«не загрузилось»;
 *  - строка «место по ссылке открыть нельзя», панель угроз открыта сразу по
 *    ссылке «обстановка», опасности в листе места — рендером.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import {
  MAP_SAFETY_HREF, MAP_START_PAYLOADS, mapPlaceHref, mapTargetFromSearch, mapTargetFromStartParam, maxStartAppLink,
  type MapFocus,
} from '@/lib/map/map-target';

vi.mock('next/image', () => ({ default: (p: { alt: string }) => <span role="img" aria-label={p.alt} /> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/map',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth/session-state', () => ({ sessionState: () => Promise.resolve(false) }));

const captured: { props: Record<string, unknown> | null } = { props: null };
vi.mock('@/app/map/_MapPageClient', () => ({
  default: (props: Record<string, unknown>) => { captured.props = props; return <div data-testid="map-client" />; },
}));
vi.mock('@/components/map/MapPlacesIndex', () => ({ MapPlacesIndexSection: () => null }));
const focusMock = vi.hoisted(() => ({ loadMapFocus: vi.fn() }));
vi.mock('@/lib/map/map-focus', () => focusMock);

import MapPage from '@/app/map/page';
import { MapFocusNotice, MAP_FOCUS_FAILED, MAP_FOCUS_NOT_FOUND } from '@/components/map/MapFocusNotice';
import { MapThreatChip } from '@/components/map/MapThreatChip';
import { PlaceMapSheet, SHEET_HAZARDS_FAILED, SHEET_HAZARDS_LOADING, SHEET_HAZARDS_NONE } from '@/components/map/PlaceMapSheet';

afterEach(() => { cleanup(); vi.restoreAllMocks(); focusMock.loadMapFocus.mockReset(); captured.props = null; });

describe('цель ссылки на карту', () => {
  it('payload мини-приложения MAX: обзор, обстановка, место и вулкан', () => {
    expect(mapTargetFromStartParam('map')).toEqual({ kind: 'overview' });
    expect(mapTargetFromStartParam('map-safety')).toEqual({ kind: 'safety' });
    expect(mapTargetFromStartParam('place-mutnovsky')).toEqual({ kind: 'place', ref: 'mutnovsky' });
    expect(mapTargetFromStartParam('volcano-11111111-2222-4333-8444-555555555555'))
      .toEqual({ kind: 'place', ref: '11111111-2222-4333-8444-555555555555' });
    expect(MAP_START_PAYLOADS.place('mutnovsky')).toBe('place-mutnovsky');
  });

  it('чужое и битое — null: знаки вне [A-Za-z0-9_-], пустое место, длиннее 512, незнакомое слово', () => {
    for (const bad of ['', 'place-', 'place-a/b', 'place-<x>', 'места', 'x'.repeat(513), 'feed', `place-${'a'.repeat(121)}`, null, undefined]) {
      expect(mapTargetFromStartParam(bad)).toBeNull();
    }
  });

  it('адрес /map: place раньше payload MAX, payload раньше show=safety, иначе обзор', () => {
    expect(mapTargetFromSearch({ place: 'mutnovsky', WebAppStartParam: 'map-safety' })).toEqual({ kind: 'place', ref: 'mutnovsky' });
    expect(mapTargetFromSearch({ WebAppStartParam: 'place-avacha', show: 'safety' })).toEqual({ kind: 'place', ref: 'avacha' });
    expect(mapTargetFromSearch({ WebAppStartParam: 'map-safety' })).toEqual({ kind: 'safety' });
    expect(mapTargetFromSearch({ show: 'safety' })).toEqual({ kind: 'safety' });
    expect(mapTargetFromSearch({ place: ['a1', 'b2'] })).toEqual({ kind: 'place', ref: 'a1' });
    expect(mapTargetFromSearch({ place: '../etc', WebAppStartParam: 'нет' })).toEqual({ kind: 'overview' });
    expect(mapTargetFromSearch({})).toEqual({ kind: 'overview' });
  });

  it('ссылки: на место, на обстановку и в мини-приложение MAX — только с допустимыми знаками', () => {
    expect(mapPlaceHref('mutnovsky')).toBe('/map?place=mutnovsky');
    expect(mapPlaceHref('a b')).toBe('/map');
    expect(MAP_SAFETY_HREF).toBe('/map?show=safety');
    expect(maxStartAppLink('vedar_bot', 'place-mutnovsky')).toBe('https://max.ru/vedar_bot?startapp=place-mutnovsky');
    expect(maxStartAppLink('vedar_bot', 'место')).toBeNull();
    expect(maxStartAppLink('bad/bot', 'map')).toBeNull();
  });
});

describe('страница /map по ссылке', () => {
  const page = async (params: Record<string, string>) => {
    render(await MapPage({ searchParams: Promise.resolve(params) }));
    return captured.props;
  };

  it('ссылка на место — место из базы уходит на карту', async () => {
    const focus: MapFocus = { state: 'place', place: { id: 'ark-1', title: 'Вулкан Мутновский', locationType: 'volcano', lat: 52.45, lng: 158.2 } };
    focusMock.loadMapFocus.mockResolvedValue(focus);
    const props = await page({ place: 'mutnovsky' });
    expect(focusMock.loadMapFocus).toHaveBeenCalledWith('mutnovsky');
    expect(props).toMatchObject({ focus, openSafety: false });
  });

  it('payload MAX про вулкан — то же место', async () => {
    focusMock.loadMapFocus.mockResolvedValue({ state: 'not_found' });
    const props = await page({ WebAppStartParam: 'volcano-koryaksky' });
    expect(focusMock.loadMapFocus).toHaveBeenCalledWith('koryaksky');
    expect(props).toMatchObject({ focus: { state: 'not_found' } });
  });

  it('ссылка «обстановка» — панель угроз открыта, база не трогается', async () => {
    const props = await page({ show: 'safety' });
    expect(props).toMatchObject({ focus: null, openSafety: true });
    expect(focusMock.loadMapFocus).not.toHaveBeenCalled();
  });

  it('просто /map — обзор края, как раньше', async () => {
    const props = await page({});
    expect(props).toMatchObject({ focus: null, openSafety: false });
    expect(focusMock.loadMapFocus).not.toHaveBeenCalled();
  });
});

describe('что видит человек', () => {
  it('место не найдено и не загрузилось — разные строки; найдено или ссылки нет — строки нет', () => {
    const { rerender } = render(<MapFocusNotice focus={{ state: 'not_found' }} />);
    expect(screen.getByRole('status').textContent).toBe(MAP_FOCUS_NOT_FOUND);
    rerender(<MapFocusNotice focus={{ state: 'failed' }} />);
    expect(screen.getByRole('status').textContent).toBe(MAP_FOCUS_FAILED);
    rerender(<MapFocusNotice focus={null} />);
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<MapFocusNotice focus={{ state: 'place', place: { id: 'a', title: 'A', locationType: null, lat: 1, lng: 2 } }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ссылка «обстановка» — панель угроз по районам раскрыта сразу; без неё — свёрнута', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      success: true, data: { level: 'calm', unavailable: false, alerts: [] },
    })));
    const { unmount } = render(<MapThreatChip defaultOpen />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Угрозы по районам' })).toBeTruthy();
    unmount();
    render(<MapThreatChip />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });

  const sheet = () => render(
    <PlaceMapSheet
      initialData={{ id: 'ark-1', title: 'Вулкан Мутновский', locationType: 'volcano', lat: 52.45, lng: 158.2, description: '' }}
      userPos={null} isOffline={false} onClose={() => {}} distLabel={null}
    />,
  );
  const detail = (safety: unknown) => new Response(JSON.stringify({
    success: true, data: { photoUrl: null, routes: [], description: null, safety },
  }));

  it('лист места называет опасности из карточки места', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => detail({ hazardTypes: ['rockfall', 'thermal'] }));
    sheet();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const line = screen.getByTestId('sheet-hazards').textContent ?? '';
    expect(line).toMatch(/^Опасности: .+, .+\.$/);
    expect(line).not.toBe(SHEET_HAZARDS_NONE);
  });

  it('опасностей не записано — «не записаны, это не значит, что их нет»', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => detail({ hazardTypes: [] }));
    sheet();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId('sheet-hazards').textContent).toBe(SHEET_HAZARDS_NONE);
  });

  it('лист переиспользован для другого места — опасности прежнего под новым названием не показываются', async () => {
    let answer: (r: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => detail({ hazardTypes: ['rockfall'] }))
      .mockImplementationOnce(() => new Promise<Response>((r) => { answer = r; }));
    const props = { userPos: null, isOffline: false, onClose: () => {}, distLabel: null };
    const { rerender } = render(<PlaceMapSheet {...props}
      initialData={{ id: 'ark-1', title: 'Вулкан Мутновский', locationType: 'volcano', lat: 52.45, lng: 158.2, description: '' }} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId('sheet-hazards').textContent).toMatch(/^Опасности: /);
    rerender(<PlaceMapSheet {...props}
      initialData={{ id: 'ark-2', title: 'Озеро', locationType: 'lake', lat: 53.1, lng: 158.4, description: '' }} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('sheet-hazards').textContent).toBe(SHEET_HAZARDS_LOADING);
    await act(async () => { answer(detail({ hazardTypes: [] })); await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId('sheet-hazards').textContent).toBe(SHEET_HAZARDS_NONE);
  });

  it('карточка не загрузилась — так и сказано, а не тишина и не «опасностей нет»', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sheet();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId('sheet-hazards').textContent).toBe(SHEET_HAZARDS_FAILED);
  });
});
