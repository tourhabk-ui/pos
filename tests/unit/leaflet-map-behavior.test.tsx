/**
 * Сторож поведения LeafletMap на подменённом Leaflet (ревью 22.10, второй
 * круг): прежде правило подгонки держалось только чистой функцией
 * fitDecision, а то, что карта её ПРИМЕНЯЕТ, не проверял никто — пять
 * мутаций LeafletMap оставались зелёными.
 *
 * Держит рендером:
 *   — скрытый контейнер (0×0, вкладка «План» на телефоне): подгонки нет;
 *     контейнер получил размер — подгонка ровно одна (иначе вкладка «Карта»
 *     открывалась пустой на 17-м зуме);
 *   — подгонка оставляет низ панели поверх верха карты (fitClearOf) над
 *     точками: легенда планировщика закрывала север края;
 *   — пины с подписью (дни плана) идут на карту мимо кластера и поверх
 *     точек, выделенный — поверх остальных пинов с подписью;
 *   — цвет пина — из общей таблицы lib/map/marker-colors (её же читает
 *     легенда планировщика);
 *   — отступ верхних углов (topInset) следует за пропом и после
 *     инициализации: вызывающий меряет свою панель уже после монтажа.
 *
 * Третий круг ревью 22.10:
 *   — новый набор маркеров вид не трогает: подгонка одна на инстанс (то, что
 *     раньше держала сверка строки вызова в map-own-position-honest);
 *   — угловая панель (легенда на компьютере): точка легла под неё — подгонка
 *     повторяется с полем по низу панели; под ней пусто — повтора нет;
 *   — плашка «Своё положение не определено» и нижние углы встают над полосой
 *     вызывающего (bottomInset): в изолированной карте её z-index больше не
 *     перекрывает полосу фильтров офлайн-/map.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import React from 'react';

interface FakeMarker {
  coords: [number, number];
  opts: { icon?: { html?: string; className?: string }; zIndexOffset?: number; title?: string };
}

const h = vi.hoisted(() => {
  const state = {
    size: { x: 0, y: 0 },
    fits: [] as Array<{ points: unknown; opts: Record<string, unknown> }>,
    onMap: [] as unknown[],
    clustered: [] as unknown[],
    roCallbacks: [] as Array<() => void>,
    /** Где точка ляжет на экране карты после подгонки (подменяется в тесте). */
    toPixel: ((p: [number, number]) => ({ x: 600 + (p[1] - 158) * 10, y: 400 })) as (p: [number, number]) => { x: number; y: number },
  };
  const layer = () => ({ addTo() { return this; }, remove() {}, on() { return this; }, setUrl() {} });
  const leaflet = {
    Control: { Attribution: { prototype: { options: {} as Record<string, unknown> } } },
    latLng: (lat: number, lng: number) => ({ lat, lng }),
    latLngBounds: () => ({}),
    map: (container: HTMLElement) => {
      for (const v of ['top', 'bottom']) {
        for (const side of ['left', 'right']) {
          const corner = document.createElement('div');
          corner.className = `leaflet-${v} leaflet-${side}`;
          container.appendChild(corner);
        }
      }
      return {
        getContainer: () => container,
        getSize: () => ({ x: state.size.x, y: state.size.y }),
        fitBounds: (points: unknown, opts: Record<string, unknown>) => { state.fits.push({ points, opts }); },
        latLngToContainerPoint: (p: [number, number]) => state.toPixel(p),
        invalidateSize: () => {},
        on: () => {},
        getZoom: () => 6,
        getCenter: () => ({ lat: 53, lng: 158 }),
        remove: () => {},
        addLayer: () => {},
        panTo: () => {},
        zoomIn: () => {},
        zoomOut: () => {},
      };
    },
    control: { zoom: () => layer(), attribution: () => layer() },
    tileLayer: () => layer(),
    markerClusterGroup: () => ({
      clearLayers: () => { state.clustered.length = 0; },
      addLayer: (l: unknown) => { state.clustered.push(l); },
      addLayers: (ls: unknown[]) => { state.clustered.push(...ls); },
    }),
    divIcon: (opts: Record<string, unknown>) => opts,
    marker: (coords: [number, number], opts: Record<string, unknown>) => {
      const m = {
        coords, opts,
        addTo() { state.onMap.push(m); return m; },
        on() { return m; },
        bindPopup() { return m; },
        remove() { const i = state.onMap.indexOf(m); if (i >= 0) state.onMap.splice(i, 1); },
      };
      return m;
    },
    polyline: () => layer(),
    polygon: () => layer(),
    circle: () => layer(),
  };
  return { state, leaflet };
});

vi.mock('leaflet', () => h.leaflet);
vi.mock('leaflet.markercluster', () => ({}));

import LeafletMap, { LABEL_Z } from '@/components/shared/LeafletMap';
import type { MapMarker } from '@/components/shared/leaflet-types';
import { MARKER_HEX } from '@/lib/map/marker-colors';
import { fitPaddingTop } from '@/lib/map/fit-when-sized';

class FakeResizeObserver {
  constructor(cb: () => void) { h.state.roCallbacks.push(cb); }
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  h.state.size = { x: 0, y: 0 };
  h.state.fits = [];
  h.state.onMap = [];
  h.state.clustered = [];
  h.state.roCallbacks = [];
  h.state.toPixel = (p) => ({ x: 600 + (p[1] - 158) * 10, y: 400 });
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MARKERS: MapMarker[] = [
  { id: 'dot', coords: [53.25, 158.83], title: 'Вулкан Авачинский', color: 'purple', suppressBalloon: true },
  { id: 'day_1_7', coords: [53.01, 158.65], title: '1. Прилёт · 7. Вылет', color: 'darkBlue', label: '1·7', suppressBalloon: true },
  { id: 'day_2', coords: [54.43, 160.14], title: '2. Долина гейзеров', color: 'darkBlue', label: '2', emphasis: true, suppressBalloon: true },
];

const markersOnMap = () => h.state.onMap as FakeMarker[];
const resize = () => act(() => { for (const cb of h.state.roCallbacks) cb(); });

async function mounted(ui: React.ReactElement) {
  const r = render(ui);
  // Карта завелась — Leaflet создал углы контролов в контейнере.
  await waitFor(() => expect(r.container.querySelector('.leaflet-top.leaflet-right')).toBeTruthy());
  return r;
}

describe('подгонка вида ждёт размера контейнера', () => {
  it('0×0 — подгонки нет; размер появился — ровно одна', async () => {
    await mounted(<LeafletMap markers={MARKERS} height="300px" />);
    // Маркеры нарисованы (дни плана на карте), а подгонки на нулевом размере нет.
    await waitFor(() => expect(markersOnMap().length).toBeGreaterThan(0));
    expect(h.state.fits).toHaveLength(0);

    h.state.size = { x: 375, y: 700 };
    resize();
    expect(h.state.fits).toHaveLength(1);
    // Подгонка одна на инстанс: следующий ресайз вид не трогает.
    resize();
    expect(h.state.fits).toHaveLength(1);
  });

  it('панель поверх верха карты — точки встают ниже её нижнего края', async () => {
    const panel = document.createElement('div');
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(
      { top: 12, bottom: 200, left: 12, right: 319, width: 307, height: 188, x: 12, y: 12, toJSON: () => ({}) } as DOMRect,
    );
    const { container } = await mounted(<LeafletMap markers={MARKERS} height="700px" fitClearOf={{ current: panel }} />);
    const mapBox = container.querySelector('.leaflet-top')?.parentElement as HTMLElement;
    vi.spyOn(mapBox, 'getBoundingClientRect').mockReturnValue(
      { top: 0, bottom: 700, left: 0, right: 375, width: 375, height: 700, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    await waitFor(() => expect(markersOnMap().length).toBeGreaterThan(0));
    h.state.size = { x: 375, y: 700 };
    resize();
    expect(h.state.fits).toHaveLength(1);
    const opts = h.state.fits[0].opts as { paddingTopLeft?: [number, number] };
    expect(opts.paddingTopLeft?.[1]).toBe(fitPaddingTop(
      { top: 12, bottom: 200, left: 12, right: 319 }, { top: 0, bottom: 700, left: 0, right: 375 }, 50,
    ));
    expect(opts.paddingTopLeft?.[1]).toBeGreaterThan(200);
  });
});

describe('подгонка одна на инстанс и обходит угловую панель', () => {
  const rect = (r: { top: number; bottom: number; left: number; right: number }) =>
    ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect);

  it('новый набор маркеров вид не трогает — подгонка уже была', async () => {
    h.state.size = { x: 375, y: 700 };
    const { rerender } = await mounted(<LeafletMap markers={MARKERS} height="300px" />);
    await waitFor(() => expect(h.state.fits.length).toBeGreaterThan(0));
    const before = h.state.fits.length;
    rerender(<LeafletMap markers={[...MARKERS, { id: 'gps', coords: [52.9, 158.5], title: 'След', suppressBalloon: true }]} height="300px" />);
    await waitFor(() => expect(markersOnMap().length + h.state.clustered.length).toBe(4));
    expect(h.state.fits.length).toBe(before);
  });

  /** Карта 800×800 на компьютере, легенда в углу 384×116 (замер ревью 22.10). */
  async function withCornerPanel() {
    const panel = document.createElement('div');
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(rect({ top: 88, bottom: 204, left: 12, right: 396 }));
    const r = await mounted(<LeafletMap markers={MARKERS} height="800px" fitClearOf={{ current: panel }} />);
    const mapBox = r.container.querySelector('.leaflet-top')?.parentElement as HTMLElement;
    vi.spyOn(mapBox, 'getBoundingClientRect').mockReturnValue(rect({ top: 76, bottom: 876, left: 0, right: 800 }));
    await waitFor(() => expect(markersOnMap().length).toBeGreaterThan(0));
    h.state.size = { x: 800, y: 800 };
    resize();
  }

  it('точка легла под угловую панель — подгонка повторена с полем по низу панели', async () => {
    // Самая северная точка (Долина гейзеров) — под правым краем легенды.
    h.state.toPixel = (p) => (p[0] > 54 ? { x: 387, y: 94 } : { x: 600, y: 500 });
    await withCornerPanel();
    const tops = h.state.fits.map(f => (f.opts as { paddingTopLeft?: [number, number] }).paddingTopLeft?.[1]);
    expect(tops).toEqual([50, 153]);
    // Положения точек читаются сразу после подгонки — значит, без анимации.
    expect(h.state.fits.every(f => f.opts.animate === false)).toBe(true);
  });

  it('под угловой панелью пусто — подгонка одна, вид не сжат', async () => {
    h.state.toPixel = () => ({ x: 600, y: 500 });
    await withCornerPanel();
    const tops = h.state.fits.map(f => (f.opts as { paddingTopLeft?: [number, number] }).paddingTopLeft?.[1]);
    expect(tops).toEqual([50]);
  });
});

describe('плашка об отказе геолокации — над полосой вызывающего', () => {
  beforeEach(() => {
    // Геолокация отвечает отказом: доступа нет.
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (_ok: unknown, fail: (e: unknown) => void) => { setTimeout(() => fail({ code: 1 }), 0); return 1; },
        clearWatch: () => {},
      },
    });
  });
  afterEach(() => {
    // Сначала размонтировать: карта при уходе снимает слежение (clearWatch).
    cleanup();
    Reflect.deleteProperty(navigator, 'geolocation');
  });

  const plaque = () => document.querySelector('[role="status"]') as HTMLElement | null;

  it('bottomInset поднимает плашку и нижние углы; без него — у самого низа', async () => {
    const { container, rerender } = await mounted(
      <LeafletMap markers={[]} height="600px" showUserLocation bottomInset={80} />,
    );
    await waitFor(() => expect(plaque()?.textContent).toMatch(/Своё положение не определено/));
    expect(plaque()?.style.bottom).toBe('92px');
    const corner = (sel: string) => (container.querySelector(sel) as HTMLElement).style.paddingBottom;
    expect(corner('.leaflet-bottom.leaflet-left')).toBe('80px');
    expect(corner('.leaflet-bottom.leaflet-right')).toBe('80px');
    // Полоса ушла (bottomInset 0) — плашка и углы на прежнем месте.
    rerender(<LeafletMap markers={[]} height="600px" showUserLocation bottomInset={0} />);
    expect(plaque()?.style.bottom).toBe('12px');
    expect(corner('.leaflet-bottom.leaflet-right')).toBe('');
  });
});

describe('пины с подписью — мимо кластера и поверх точек', () => {
  it('дни плана на карте, точка — в кластере; выделенный день выше остальных', async () => {
    h.state.size = { x: 375, y: 700 };
    await mounted(<LeafletMap markers={MARKERS} height="300px" />);
    await waitFor(() => expect(markersOnMap()).toHaveLength(2));

    const labelled = markersOnMap();
    expect(labelled.every(m => m.opts.icon?.className === 'kh-label-pin')).toBe(true);
    const z = (title: string) => labelled.find(m => m.opts.title === title)?.opts.zIndexOffset;
    expect(z('1. Прилёт · 7. Вылет')).toBe(LABEL_Z.normal);
    expect(z('2. Долина гейзеров')).toBe(LABEL_Z.emphasis);
    expect(LABEL_Z.emphasis).toBeGreaterThan(LABEL_Z.normal);
    expect(LABEL_Z.normal).toBeGreaterThan(0);

    const clustered = h.state.clustered as FakeMarker[];
    expect(clustered).toHaveLength(1);
    expect(clustered[0].opts.icon?.className).toBe('kh-marker');
  });

  it('подпись «1·7» видна целиком, цвет пина — из общей таблицы', async () => {
    h.state.size = { x: 375, y: 700 };
    await mounted(<LeafletMap markers={MARKERS} height="300px" />);
    await waitFor(() => expect(markersOnMap()).toHaveLength(2));
    const both = markersOnMap().find(m => m.opts.title === '1. Прилёт · 7. Вылет');
    expect(both?.opts.icon?.html).toContain('>1·7</div>');
    expect(both?.opts.icon?.html).toContain(`background:${MARKER_HEX.darkBlue}`);
    const dot = (h.state.clustered as FakeMarker[])[0];
    expect(dot.opts.icon?.html).toContain(MARKER_HEX.purple);
  });
});

describe('отступ верхних углов следует за пропом', () => {
  it('высота панели пришла после монтажа — углы сдвигаются, ноль — отступ снят', async () => {
    const { container, rerender } = await mounted(<LeafletMap markers={[]} height="300px" topInset={0} />);
    const right = () => (container.querySelector('.leaflet-top.leaflet-right') as HTMLElement).style.paddingTop;
    const left = () => (container.querySelector('.leaflet-top.leaflet-left') as HTMLElement).style.paddingTop;
    expect(right()).toBe('');
    rerender(<LeafletMap markers={[]} height="300px" topInset={104} />);
    expect(right()).toBe('104px');
    expect(left()).toBe('104px');
    rerender(<LeafletMap markers={[]} height="300px" topInset={0} />);
    expect(right()).toBe('');
  });
});
