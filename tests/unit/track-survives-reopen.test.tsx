// @vitest-environment jsdom
/**
 * Запись трека переживает повторное открытие экрана (скрин владельца 12.10:
 * «при повторном открытии не сохраняется трек»).
 *
 * Черновик на диске не различал «человек нажал Остановить» и «экран
 * перезапустили посреди записи». Экран маршрута принимал любой черновик за
 * готовый трек: при открытии со связью отправлял обрывок и стирал его с
 * телефона, а запись не продолжалась.
 *
 * Сторож держит поведение хука, а не текст: прерванная запись продолжается
 * и не отдаётся на отправку; остановленная — отдаётся и не продолжается;
 * остановка кладёт на диск отметку и весь хвост.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldTrackDraft } from '@/lib/offline/db';

const disk: { draft: FieldTrackDraft | undefined } = { draft: undefined };

vi.mock('@/lib/offline/db', () => ({
  saveTrackDraft: vi.fn(async (d: FieldTrackDraft) => { disk.draft = structuredClone(d); }),
  getTrackDraft: vi.fn(async () => (disk.draft ? structuredClone(disk.draft) : undefined)),
  clearTrackDraft: vi.fn(async () => { disk.draft = undefined; }),
}));

import { useTrackRecorder } from '@/hooks/useTrackRecorder';

type Watcher = (pos: GeolocationPosition) => void;
let watchers: Watcher[] = [];
const watchPosition = vi.fn((ok: Watcher) => { watchers.push(ok); return watchers.length; });
const clearWatch = vi.fn();

function fix(lat: number, lng: number, t: number): GeolocationPosition {
  return {
    coords: {
      latitude: lat, longitude: lng, accuracy: 5, altitude: 100,
      altitudeAccuracy: null, heading: null, speed: null,
      toJSON: () => ({}),
    },
    timestamp: t,
    toJSON: () => ({}),
  } as GeolocationPosition;
}

/** Двенадцать точек по ~22 м на север: каждая принимается рекордером. */
function walk(from: number, n: number, t0: number) {
  for (let i = 0; i < n; i++) {
    const p = fix(53.0 + (from + i) * 0.0002, 158.6, t0 + (from + i) * 20_000);
    act(() => { watchers[watchers.length - 1]!(p); });
  }
}

const T0 = Date.UTC(2026, 9, 12, 2, 0, 0);

beforeEach(() => {
  disk.draft = undefined;
  watchers = [];
  watchPosition.mockClear();
  clearWatch.mockClear();
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value: { watchPosition, clearWatch },
    configurable: true,
  });
});

describe('прерванная запись продолжается после повторного открытия', () => {
  it('черновик без отметки остановки — запись идёт дальше, точки на месте, на отправку не отдаётся', async () => {
    disk.draft = {
      id: 'current', name: 'Зеленовские озерки', startedAt: T0,
      points: [[53.0, 158.6, 100, T0], [53.0002, 158.6, 101, T0 + 20_000], [53.0004, 158.6, 102, T0 + 40_000]],
      dropped: {}, lengthM: 44,
    };
    const { result } = renderHook(() => useTrackRecorder());
    await waitFor(() => expect(result.current.recording).toBe(true));

    expect(result.current.continued).toBe(true);
    expect(result.current.restored).toBe(false);
    expect(result.current.summary.points).toBe(3);
    expect(watchPosition).toHaveBeenCalledTimes(1);
    // Идущая работа — не готовый трек: дожиму отдавать нечего.
    expect(result.current.packageDraft()).toBeNull();

    // Новые точки ложатся в ТУ ЖЕ запись, а не в новую.
    walk(3, 5, T0);
    expect(result.current.summary.points).toBe(8);
  });

  it('остановленный черновик ждёт отправки и сам не продолжается', async () => {
    disk.draft = {
      id: 'current', name: 'Зеленовские озерки', startedAt: T0,
      points: [[53.0, 158.6, 100, T0], [53.0002, 158.6, 101, T0 + 20_000]],
      dropped: {}, lengthM: 22, stoppedAt: T0 + 30_000,
    };
    const { result } = renderHook(() => useTrackRecorder());
    await waitFor(() => expect(result.current.restored).toBe(true));

    expect(result.current.recording).toBe(false);
    expect(watchPosition).not.toHaveBeenCalled();
    const pkg = result.current.packageDraft();
    expect(pkg).not.toBeNull();
    expect(pkg!.gpx).toContain('<trkpt');
  });
});

describe('остановка', () => {
  it('кладёт на диск отметку остановки и все точки, включая хвост между сбросами', async () => {
    const { result } = renderHook(() => useTrackRecorder());
    // Дать хуку дочитать пустой диск.
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.start('Выход'));
    expect(result.current.continued).toBe(false);
    // 7 точек: сброс по пятой, две последние жили бы только в памяти.
    walk(0, 7, T0);

    let done: Awaited<ReturnType<typeof result.current.stop>> = null;
    await act(async () => { done = await result.current.stop(); });

    expect(done).not.toBeNull();
    expect(disk.draft?.stoppedAt).toBeTypeOf('number');
    expect(disk.draft?.points.length).toBe(7);
    // Остановленная запись теперь отдаётся дожиму.
    expect(result.current.packageDraft()).not.toBeNull();
  });

  it('после остановки повторный старт дописывает не досланную запись, а не затирает её', async () => {
    const { result } = renderHook(() => useTrackRecorder());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.start('Выход'));
    walk(0, 4, T0);
    await act(async () => { await result.current.stop(); });

    act(() => result.current.start('Выход'));
    expect(result.current.continued).toBe(true);
    expect(result.current.summary.points).toBe(4);
    expect(result.current.packageDraft()).toBeNull();
  });

  it('меньше двух точек — запись не хранится и не продолжается следующей', async () => {
    const { result } = renderHook(() => useTrackRecorder());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.start('Выход'));
    walk(0, 1, T0);
    await act(async () => { await result.current.stop(); });

    expect(disk.draft).toBeUndefined();
    act(() => result.current.start('Выход'));
    expect(result.current.continued).toBe(false);
  });
});

describe('экран маршрута не стирает след продолжаемой записи', () => {
  it('обнуление следа — только когда запись начата заново, не продолжена', () => {
    const src = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');
    const at = src.indexOf('recordingRef.current = recorder.recording');
    expect(at, 'эффект следа за кнопкой записи не найден').toBeGreaterThan(0);
    const block = src.slice(at, at + 400);
    expect(block).toMatch(/recorder\.recording && !was && !recorder\.continued/);
  });
});
