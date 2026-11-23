// @vitest-environment jsdom
/**
 * Место без маршрутов каталога — всё равно цель (скрин владельца 24.11).
 *
 * «Урочище Аквариум»: карточка места построила путь — пешком 16 ч 9 мин, на
 * машине 74,6 км по дорожному графу, — а «Пройти сюда с компасом и GPS»
 * открывал экран «На маршруте» с «Пути к „Урочище Аквариум“ — Ничего не
 * нашлось». Ссылка несла только имя, экран искал по нему маршруты каталога, а
 * через урочище не проходит ни один. Цель же была известна — сама точка
 * места, и путь до точки экран строит тем же build(), что для булавки.
 *
 * Там же строка приборов без конца писала «Ищем спутники…», а выбор старта —
 * «Определяем вашу позицию…», хотя карта рядом ставила синюю точку: браузер
 * компьютера отвечал сетевой догадкой, экран её отбрасывал (верно) и молчал
 * об этом (неверно).
 *
 * Держит вызовом: ссылка несёт id места; место читается из базы, а не из
 * адреса; без маршрутов каталога место встаёт целью, с маршрутами — берётся
 * место выдачи с его треками; автовыбор ждёт и поиск, и чтение места.
 * Рендером: экран по такой ссылке показывает место целью и говорит о грубой
 * точке словами.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  trailLinkForPlace, linkedPlaceIdFrom, linkedPlaceFromApi, withLinkedPlace,
  autoDestination, TRAIL_PLACE_PARAM, type DestinationOption, type LinkedPlace,
} from '@/lib/on-route/destination';
import {
  coarseFixStatus, coarseFixOriginText, coarseFixAccuracyWords, GPS_ACCURACY_IMPLAUSIBLE_M,
} from '@/lib/on-route/fix-quality';

const ARK = '3f2b8c1e-6a4d-4c1b-9e2f-7d5a1b0c9e11';
const AQUARIUM: LinkedPlace = { title: 'Урочище Аквариум', lat: 53.4012, lon: 158.2215, query: 'Урочище Аквариум' };

describe('ссылка с карточки места', () => {
  it('несёт имя для поиска и id места для цели', () => {
    const href = trailLinkForPlace({ id: ARK, name: 'Урочище Аквариум' });
    const url = new URL(href, 'https://vedarai.ru');
    expect(url.pathname).toBe('/planning');
    expect(url.searchParams.get('mode')).toBe('trail');
    expect(url.searchParams.get('q')).toBe('Урочище Аквариум');
    expect(url.searchParams.get('auto')).toBe('1');
    expect(url.searchParams.get(TRAIL_PLACE_PARAM)).toBe(ARK);
  });

  it('id чужой формы в адрес API не идёт', () => {
    expect(linkedPlaceIdFrom(ARK)).toBe(ARK);
    expect(linkedPlaceIdFrom(null)).toBeNull();
    expect(linkedPlaceIdFrom('../admin')).toBeNull();
    expect(linkedPlaceIdFrom('abc')).toBeNull();
    expect(linkedPlaceIdFrom(`${ARK}?x=1`)).toBeNull();
  });
});

describe('место читается из ответа базы', () => {
  const ok = { success: true, data: { id: ARK, name: 'Урочище Аквариум', lat: 53.4012, lng: 158.2215 } };

  it('полный ответ — место для цели', () => {
    expect(linkedPlaceFromApi(ok, ' Урочище Аквариум ')).toEqual(AQUARIUM);
  });

  it('отказ, неполный ответ, координата вне шара — null, а не точка-заглушка', () => {
    expect(linkedPlaceFromApi({ success: false, error: 'Место не найдено' }, 'x')).toBeNull();
    expect(linkedPlaceFromApi(null, 'x')).toBeNull();
    expect(linkedPlaceFromApi({ success: true, data: { name: 'X', lat: 53 } }, 'x')).toBeNull();
    expect(linkedPlaceFromApi({ success: true, data: { name: '', lat: 53, lng: 158 } }, 'x')).toBeNull();
    expect(linkedPlaceFromApi({ success: true, data: { name: 'X', lat: 153, lng: 158 } }, 'x')).toBeNull();
  });
});

const withTracks: DestinationOption = {
  destination: { kind: 'place', id: '901', title: 'Урочище Аквариум', lat: 53.4012, lon: 158.2215 },
  routeOptions: [{ id: 'r1', title: 'Река Левая Авача', distanceKm: 12, lineGrade: null, difficulty: null, elevationGainM: null, waypointNames: [] }],
};
const namesake: DestinationOption = {
  destination: { kind: 'place', id: '902', title: 'Аквариум', lat: 52.1, lon: 157.9 },
  routeOptions: [{ id: 'r2', title: 'Другой', distanceKm: 3, lineGrade: null, difficulty: null, elevationGainM: null, waypointNames: [] }],
};

describe('место из ссылки среди выдачи', () => {
  it('маршрутов каталога нет — место встаёт целью без готовых треков', () => {
    const [first] = withLinkedPlace([], AQUARIUM, 'Урочище Аквариум');
    expect(first.destination).toEqual({ kind: 'coordinate', lat: 53.4012, lon: 158.2215, title: 'Урочище Аквариум' });
    expect(first.routeOptions).toEqual([]);
  });

  it('то же место нашлось в выдаче — берётся оно, с треками, и стоит первым', () => {
    const list = withLinkedPlace([namesake, withTracks], AQUARIUM, 'Урочище Аквариум');
    expect(list).toEqual([withTracks, namesake]);
  });

  it('тёзка в выдаче — не то место: впереди встаёт место из ссылки', () => {
    const list = withLinkedPlace([namesake], AQUARIUM, 'Урочище Аквариум');
    expect(list[0].destination.kind).toBe('coordinate');
    expect(list[1]).toBe(namesake);
  });

  it('набрали другое — место из ссылки ни при чём', () => {
    expect(withLinkedPlace([namesake], AQUARIUM, 'Авачинский')).toEqual([namesake]);
    expect(withLinkedPlace([namesake], null, 'Урочище Аквариум')).toEqual([namesake]);
  });
});

describe('автовыбор цели по ссылке', () => {
  const base = { destinations: [] as DestinationOption[], linked: AQUARIUM, query: 'Урочище Аквариум' };

  it('ждёт ответа поиска и чтения места', () => {
    expect(autoDestination({ ...base, linkedPhase: 'ok', searchDone: false })).toBeNull();
    expect(autoDestination({ ...base, destinations: [withTracks], linked: null, linkedPhase: 'loading', searchDone: true })).toBeNull();
  });

  it('«Урочище Аквариум»: маршрутов нет — целью само место', () => {
    const picked = autoDestination({ ...base, linkedPhase: 'ok', searchDone: true });
    expect(picked?.destination).toMatchObject({ kind: 'coordinate', title: 'Урочище Аквариум' });
  });

  it('у места есть треки — выбирается оно с треками, а не голая точка', () => {
    expect(autoDestination({ ...base, destinations: [namesake, withTracks], linkedPhase: 'ok', searchDone: true })).toBe(withTracks);
  });

  it('старая ссылка без id — как до правки: первое место выдачи; пусто — выбора нет', () => {
    expect(autoDestination({ destinations: [withTracks], linked: null, linkedPhase: 'none', searchDone: true, query: 'x' })).toBe(withTracks);
    expect(autoDestination({ destinations: [], linked: null, linkedPhase: 'failed', searchDone: true, query: 'x' })).toBeNull();
  });
});

describe('слова о грубой точке', () => {
  it('точность словами, «ищем» не обещается', () => {
    expect(coarseFixAccuracyWords(64_642)).toBe('±65 км');
    expect(coarseFixAccuracyWords(800)).toBe('±800 м');
    expect(coarseFixStatus(64_642)).toBe('Спутников нет — место известно примерно, ±65 км');
    expect(coarseFixStatus(64_642)).not.toMatch(/Ищем/);
    expect(coarseFixOriginText(64_642)).toMatch(/укажите старт на карте/);
  });
});

/* ─── Экран по ссылке с карточки — рендером ───────────────────────────────── */

vi.mock('next/image', () => ({ default: (p: { alt: string }) => <span role="img" aria-label={p.alt} /> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/offline/useOfflineRegion', () => ({
  useOfflineRegion: () => ({ status: 'idle', progress: null, regionMeta: null, error: null, download: vi.fn(), remove: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planning',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

/** Браузер компьютера: ответ есть, но сетевая догадка в масштабе города. */
function coarseGeolocation(accuracy: number) {
  const pos = {
    coords: { latitude: 53.0167, longitude: 158.65, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
    timestamp: Date.now(),
    toJSON: () => ({}),
  } as GeolocationPosition;
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value: {
      getCurrentPosition: (ok: PositionCallback) => { setTimeout(() => ok(pos), 0); },
      watchPosition: (ok: PositionCallback) => { setTimeout(() => ok(pos), 0); return 1; },
      clearWatch: () => {},
    },
    configurable: true,
  });
}

describe('экран «На маршруте» по ссылке с карточки', () => {
  it('место без маршрутов каталога — цель, а грубая точка названа словами', { timeout: 30_000 }, async () => {
    expect(64_000).toBeGreaterThan(GPS_ACCURACY_IMPLAUSIBLE_M);
    coarseGeolocation(64_000);
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      asked.push(u);
      if (u.startsWith('/api/routes/search')) return new Response(JSON.stringify({ routes: [] }));
      if (u.startsWith(`/api/places/${ARK}`)) {
        return new Response(JSON.stringify({ success: true, data: { id: ARK, name: 'Урочище Аквариум', lat: 53.4012, lng: 158.2215 } }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    window.history.replaceState(null, '', trailLinkForPlace({ id: ARK, name: 'Урочище Аквариум' }));

    const { PlanningClient } = await import('@/app/planning/_PlanningClient');
    render(<PlanningClient />);

    // Цель выбрана сама — место, а не «Ничего не нашлось».
    await waitFor(() => expect(screen.getAllByText('Путь не найден в каталоге').length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(screen.queryByText(/Ничего не нашлось/)).toBeNull();
    expect(screen.getAllByText('Урочище Аквариум').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Готовых треков к этой точке нет/).length).toBeGreaterThan(0);
    // Строка приборов — что знает браузер, а не «ищем».
    expect(screen.getByText(coarseFixStatus(64_000))).toBeTruthy();
    expect(screen.queryByText('Ищем спутники…')).toBeNull();
    // Координата цели — из ответа базы по id.
    expect(asked.some(u => u.startsWith(`/api/places/${ARK}?view=0`))).toBe(true);

    // Грубая точка: не «ищем» и не «определяем», а что знает браузер.
    await waitFor(() => expect(screen.getAllByText(coarseFixOriginText(64_000)).length).toBeGreaterThan(0));
    expect(screen.queryByText('Определяем вашу позицию…')).toBeNull();
  });

  it('место с карточки не прочиталось — так и сказано, а не «ничего не нашлось»', { timeout: 30_000 }, async () => {
    coarseGeolocation(64_000);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/routes/search')) return new Response(JSON.stringify({ routes: [] }));
      if (u.startsWith('/api/places/')) return new Response(JSON.stringify({ success: false }), { status: 500 });
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    window.history.replaceState(null, '', trailLinkForPlace({ id: ARK, name: 'Урочище Аквариум' }));

    const { PlanningClient } = await import('@/app/planning/_PlanningClient');
    render(<PlanningClient />);
    await waitFor(() => expect(screen.getAllByText(/Место с карточки не прочиталось/).length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(screen.queryByText(/Ничего не нашлось/)).toBeNull();
  });
});
