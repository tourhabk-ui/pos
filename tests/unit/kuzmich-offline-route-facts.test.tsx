/**
 * Факты маршрута в телефоне — Кузьмич без сети отвечает по ним (карт-бланш
 * владельца 27.11, шаг 2). Разбор ответа сервера, запись вместе с картой,
 * ответ по фактам — вызовом; страница /kuzmich без сети — рендером.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({
  saved: 1,
  files: [{ url: 'https://s3/p/1.pmtiles', kind: 'cell', pack: 'c1' }],
}));

vi.mock('@/lib/offline/pack-files', () => ({
  planPackFiles: () => ({ files: h.files }),
}));
vi.mock('@/lib/offline/pack-download', () => ({
  measurePackFiles: async (files: unknown[]) => files.map((f) => ({ ...(f as object), bytes: 1_000_000, status: 200 })),
  totalMb: () => ({ mb: 1, unknown: 0 }),
  downloadPackFiles: async () => ({ saved: h.saved, failed: h.saved ? [] : [{ kind: 'cell', why: 'HTTP 500' }], bytes: h.saved * 1_000_000 }),
}));
vi.mock('next/image', () => ({ default: (p: { alt: string }) => <span role="img" aria-label={p.alt} /> }));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  usePathname: () => '/ai-assistant',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ isDark: false, toggleTheme: vi.fn() }) }));

import {
  ROUTE_FACTS_PREFIX, parseRouteFacts, readSavedRouteFacts, routeFactsFromBundle, routeFactsKey, saveRouteFacts,
  type RouteFacts,
} from '@/lib/offline/route-facts';
import { planRouteMap, saveRouteMap } from '@/lib/offline/route-map-save';
import { offlineBundleWaypoints } from '@/lib/offline/bundle-sql';
import { offlineKuzmichAnswer, routeFactsAnswer, OFFLINE_PROTOCOL_LEAD } from '@/lib/kuzmich/offline-answer';
import KuzmichClient from '@/app/kuzmich/_KuzmichClient';
import AIAssistantPage from '@/app/ai-assistant/_AIAssistantClient';

/** Ответ /api/routes/[id]/offline-bundle — в той форме, что отдаёт роут. */
const BUNDLE = {
  route: {
    id: 'r-mut', title: 'Вулкан Мутновский', description: '…', lat: 52.4, lng: 158.2, difficulty: 'medium',
    distance_km: 14, elevation_gain_m: 900, duration_hours: 8, season: 'summer',
    hazards: ['фумаролы', 'снежники'], equipment: ['треккинговые ботинки', 'ветровка'],
    mchs_registration_required: true, mchs_phone: '+7 4152 00-00-00', park_name: 'Вулканы Камчатки',
  },
  // Медпомощь — у мест маршрута (lib/offline/bundle-sql.ts); без записи — null.
  waypoints: [
    { position: 0, name: 'Парковка', lat: 52.45, lng: 158.19, nearest_medical_km: 48.6 },
    { position: 1, name: 'Кратер', lat: 52.45, lng: 158.2, nearest_medical_km: null },
    { position: 2, name: 'Дачные источники', lat: 52.44, lng: 158.18, nearest_medical_km: 7.25 },
  ],
  alerts: [{ type: 'road', severity: 2, title: 'Дорога к вулкану закрыта', until: '2026-12-01T00:00:00Z' }],
  built_at: '2026-11-27T01:00:00.000Z',
  route_bounds: { south: 52.3, west: 158.1, north: 52.5, east: 158.3 },
};

const card = (over: Partial<RouteFacts> = {}): RouteFacts => ({
  ...(routeFactsFromBundle(BUNDLE) as RouteFacts),
  savedAt: Date.UTC(2026, 10, 27, 2, 0),
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  h.saved = 1;
});

describe('карточка из ответа сервера', () => {
  it('берёт факты маршрута и предупреждения, без координат человека', () => {
    const f = routeFactsFromBundle(BUNDLE)!;
    expect(f).toMatchObject({
      id: 'r-mut', title: 'Вулкан Мутновский', builtAt: '2026-11-27T01:00:00.000Z', savedAt: 0,
      hazards: ['фумаролы', 'снежники'], equipment: ['треккинговые ботинки', 'ветровка'],
      mchsRequired: true, mchsPhone: '+7 4152 00-00-00', parkName: 'Вулканы Камчатки',
      alerts: [{ title: 'Дорога к вулкану закрыта', until: '2026-12-01T00:00:00Z' }],
      // Ближе — первой; точка без записи в список не идёт.
      medical: [{ place: 'Дачные источники', km: 7.25 }, { place: 'Парковка', km: 48.6 }],
    });
  });

  it('карточка, сохранённая до медпомощи, читается: медпомощи — пусто, а не ошибка', () => {
    const old = { ...card(), medical: undefined } as unknown as RouteFacts;
    localStorage.setItem(routeFactsKey('r-old'), JSON.stringify({ ...old, id: 'r-old' }));
    expect(parseRouteFacts(localStorage.getItem(routeFactsKey('r-old')))?.medical).toEqual([]);
  });

  it('точки пакета: расстояние из базы числом, нет записи — null, а не ноль километров', () => {
    const rows = [
      { position: 0, place_name: 'Старт', lat: '52.4', lng: '158.2', nearest_medical_km: '12.50' },
      { position: 1, place_name: 'Кратер', lat: '52.5', lng: '158.3', nearest_medical_km: null },
      { position: 2, place_name: 'Хижина', lat: '52.6', lng: '158.4', nearest_medical_km: 'нет' },
      { position: 3, place_name: 'Озеро', lat: '52.7', lng: '158.5', nearest_medical_km: '' },
    ];
    expect(offlineBundleWaypoints(rows).map((w) => [w.name, w.lat, w.nearest_medical_km]))
      .toEqual([['Старт', 52.4, 12.5], ['Кратер', 52.5, null], ['Хижина', 52.6, null], ['Озеро', 52.7, null]]);
  });

  it('неизвестное — не выдумывается: NULL-поля — пусто, нет флага МЧС — null', () => {
    const f = routeFactsFromBundle({ route: { id: 7, title: 'Тропа', hazards: null, equipment: null, mchs_registration_required: null } })!;
    expect(f).toMatchObject({ id: '7', hazards: [], equipment: [], mchsRequired: null, mchsPhone: null, alerts: [] });
    expect(routeFactsFromBundle({ route: { id: 1 } })).toBeNull();
    expect(routeFactsFromBundle({})).toBeNull();
  });

  it('сохранённая карточка читается обратно, битая и чужая — нет', () => {
    expect(saveRouteFacts(routeFactsFromBundle(BUNDLE)!, 1000)).toBe(true);
    expect(parseRouteFacts(localStorage.getItem(routeFactsKey('r-mut')))?.savedAt).toBe(1000);
    localStorage.setItem(`${ROUTE_FACTS_PREFIX}x`, '{не json');
    localStorage.setItem(`${ROUTE_FACTS_PREFIX}y`, JSON.stringify({ id: 'y' }));
    saveRouteFacts({ ...routeFactsFromBundle(BUNDLE)!, id: 'r2', title: 'Второй' }, 2000);
    expect(readSavedRouteFacts().map((f) => f.id)).toEqual(['r2', 'r-mut']);
  });
});

describe('карточка ложится в телефон вместе с картой', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(BUNDLE))));
    vi.stubGlobal('caches', {});
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true, value: { ready: Promise.resolve({ active: {} }) },
    });
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('план несёт факты, удачное сохранение карты кладёт их', async () => {
    const planned = await planRouteMap('r-mut', []);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.facts?.title).toBe('Вулкан Мутновский');
    expect(localStorage.getItem(routeFactsKey('r-mut'))).toBeNull();
    const res = await saveRouteMap('r-mut', planned.plan, () => {});
    expect(res.ok).toBe(true);
    const f = parseRouteFacts(localStorage.getItem(routeFactsKey('r-mut')));
    expect(f?.equipment).toEqual(['треккинговые ботинки', 'ветровка']);
    expect(f!.savedAt).toBeGreaterThan(0);
  });

  it('карта не сохранилась — фактов «сохранённого маршрута» нет', async () => {
    const planned = await planRouteMap('r-mut', []);
    if (!planned.ok) throw new Error('план не посчитан');
    h.saved = 0;
    const res = await saveRouteMap('r-mut', planned.plan, () => {});
    expect(res.ok).toBe(false);
    expect(localStorage.getItem(routeFactsKey('r-mut'))).toBeNull();
  });
});

describe('ответ Кузьмича по сохранённым фактам', () => {
  it('«что взять» — снаряжение из карточки, дата сохранения и оговорка', () => {
    const t = routeFactsAnswer('Что взять с собой?', [card()])!;
    expect(t).toContain('по сохранённому в телефоне маршруту «Вулкан Мутновский» (сохранён 27.11.2026)');
    expect(t).toContain('— Снаряжение: треккинговые ботинки, ветровка.');
    expect(t).toContain('обстановка могла измениться');
    expect(t).toContain('112');
  });

  it('несколько тем сразу; МЧС, предупреждения и парк — словами карточки', () => {
    const t = routeFactsAnswer('нужна регистрация в МЧС и что закрыто?', [card()])!;
    expect(t).toContain('— Регистрация в МЧС: обязательна. Телефон МЧС для консультации: +7 4152 00-00-00.');
    expect(t).toContain('— Предупреждения на дату сохранения: Дорога к вулкану закрыта (до 2026-12-01).');
    expect(routeFactsAnswer('какой парк?', [card()])).toContain('природном парке «Вулканы Камчатки»');
  });

  it('незаписанное — «не записано», а не «нет»: опасности и МЧС', () => {
    const t = routeFactsAnswer('какие опасности и нужна ли регистрация?', [card({ hazards: [], mchsRequired: false, mchsPhone: null })])!;
    expect(t).toContain('Опасности в сохранённых данных не записаны — это не значит, что их нет.');
    expect(t).toContain('обязательной не отмечена — это не значит, что она не нужна');
    expect(routeFactsAnswer('регистрация?', [card({ mchsRequired: null, mchsPhone: null })]))
      .toContain('Регистрация в МЧС: в сохранённых данных не записано.');
  });

  it('несколько маршрутов: названный — по нему, неназванный — просьба назвать, без догадки', () => {
    const two = [card(), card({ id: 'r-av', title: 'Вулкан Авачинский', equipment: ['кошки'] })];
    expect(routeFactsAnswer('что взять на Авачинский?', two)).toContain('— Снаряжение: кошки.');
    const ask = routeFactsAnswer('что взять?', two)!;
    expect(ask).toContain('Назовите, о каком спрашиваете');
    expect(ask).not.toContain('Снаряжение');
  });

  it('общее слово названия маршрут не выбирает: «вулкан» — не «Вулкан Мутновский»', () => {
    const two = [card(), card({ id: 'r-kur', title: 'Озеро Курильское', equipment: ['репеллент'] })];
    const t = routeFactsAnswer('что взять на вулкан?', two)!;
    expect(t).toContain('Назовите');
    expect(t).not.toContain('Снаряжение');
  });

  it('медпомощь — по местам маршрута, ближе первой; не записано — так и сказано, с 112', () => {
    const t = routeFactsAnswer('где ближайшая больница?', [card()])!;
    expect(t).toContain('— Ближайшая медпомощь по данным мест маршрута: от «Дачные источники» — 7,3 км, от «Парковка» — 49 км.');
    expect(routeFactsAnswer('далеко до врача?', [card({ medical: [] })]))
      .toContain('Расстояние до медпомощи в сохранённых данных не записано. При беде — 112.');
  });

  it('вопрос про сохранённый маршрут, а ответа в нём нет — «в сохранённом этого нет», не молчание', () => {
    const t = offlineKuzmichAnswer('Какая погода на Мутновском?', [], [card()]);
    expect(t).toMatch(/^В сохранённом в телефоне маршруте «Вулкан Мутновский» ответа на это нет: там записаны опасности, снаряжение, регистрация в МЧС, медпомощь и предупреждения\./);
    expect(t).toContain('112');
    expect(offlineKuzmichAnswer('Какая погода?', [], [card()])).not.toContain('В сохранённом');
  });

  it('вопрос не про маршрут или маршрутов нет — фактов в ответе нет', () => {
    expect(routeFactsAnswer('Какая погода?', [card()])).toBeNull();
    expect(routeFactsAnswer('Что взять?', [])).toBeNull();
  });

  it('памятка беды раньше фактов маршрута', () => {
    expect(offlineKuzmichAnswer('медведь рядом, что взять?', [], [card()]).startsWith(OFFLINE_PROTOCOL_LEAD)).toBe(true);
    expect(offlineKuzmichAnswer('что взять с собой?', [], [card()])).toContain('Снаряжение');
  });
});

describe('страница /kuzmich без сети отвечает по сохранённому маршруту', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('карточка в телефоне — ответ из неё, запрос не уходит', async () => {
    saveRouteFacts(routeFactsFromBundle(BUNDLE)!, Date.UTC(2026, 10, 27, 2, 0));
    const posts: string[] = [];
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(String(url)); return Promise.reject(new TypeError('Failed to fetch')); }
      return Promise.resolve(new Response(JSON.stringify({ data: { messages: [] } })));
    }));
    render(<KuzmichClient />);
    const box = await screen.findByPlaceholderText(/Спросите про тур/);
    fireEvent.change(box, { target: { value: 'Нужна ли регистрация в МЧС?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/Регистрация в МЧС: обязательна/)).toBeTruthy();
    expect(screen.getByText(/по сохранённому в телефоне маршруту «Вулкан Мутновский»/)).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it('/ai-assistant — тоже по карточке', async () => {
    saveRouteFacts(routeFactsFromBundle(BUNDLE)!, Date.UTC(2026, 10, 27, 2, 0));
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    render(<AIAssistantPage />);
    const box = await screen.findByPlaceholderText('Спросите Кузьмича...');
    fireEvent.change(box, { target: { value: 'какие опасности?' } });
    fireEvent.submit(box.closest('form')!);
    expect(await screen.findByText(/Опасности: фумаролы, снежники/)).toBeTruthy();
  });
});
