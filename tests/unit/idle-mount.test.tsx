/**
 * Карта обзора /map стартует, когда браузер освободился (14.10) — рендером
 * IdleMount (правило 13.10) и запретом для полевого экрана.
 *
 * Прогоны 9–12 переписи: на /map больше трети работы главного потока —
 * сборка шейдеров и WebGL в MapLibre, и шапка, чипы и окно согласия ждали
 * карту 2,9–5,7 с. Теперь карта монтируется в простое, не позже потолка, а код
 * её качается сразу. Полевой экран /planning так не делает: там карта — прибор.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdleMount, MAP_IDLE_MAX_WAIT_MS } from '@/components/map/IdleMount';

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};
const w = window as IdleWindow;

afterEach(() => {
  cleanup();
  delete w.requestIdleCallback;
  delete w.cancelIdleCallback;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const view = () => (
  <IdleMount placeholder={<div>подложка</div>}>
    <div>карта</div>
  </IdleMount>
);

describe('IdleMount: тяжёлое — после остального', () => {
  it('сначала подложка, карта — когда браузер освободился; потолок ожидания — две секунды', () => {
    let idle: (() => void) | null = null;
    const opts: Array<{ timeout: number } | undefined> = [];
    w.requestIdleCallback = (cb, o) => { idle = cb; opts.push(o); return 7; };
    w.cancelIdleCallback = vi.fn();
    render(view());
    expect(screen.getByText('подложка')).toBeTruthy();
    expect(screen.queryByText('карта')).toBeNull();
    expect(opts).toEqual([{ timeout: MAP_IDLE_MAX_WAIT_MS }]);
    expect(MAP_IDLE_MAX_WAIT_MS).toBe(2_000);
    act(() => { idle?.(); });
    expect(screen.getByText('карта')).toBeTruthy();
    expect(screen.queryByText('подложка')).toBeNull();
  });

  it('ушли со страницы раньше простоя — ожидание снято, монтировать некого', () => {
    const cancel = vi.fn();
    w.requestIdleCallback = () => 42;
    w.cancelIdleCallback = cancel;
    const { unmount } = render(view());
    unmount();
    expect(cancel).toHaveBeenCalledWith(42);
  });

  it('без requestIdleCallback (Safari) — после кадра отрисовки, не навсегда', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    render(view());
    expect(screen.getByText('подложка')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(20); });
    expect(screen.getByText('карта')).toBeTruthy();
  });
});

describe('где карта ждёт простоя, а где нет', () => {
  const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('полевой экран карту не откладывает: там она прибор, а не витрина', () => {
    const field = code('app/planning/_PlanningClient.tsx');
    expect(field).not.toMatch(/IdleMount|useIdleStart/);
  });

  it('обзор /map ждёт простоя, а код карты качает сразу', () => {
    const page = code('app/map/_MapPageClient.tsx');
    // Импорт без употребления уронил бы линтер — значит, обёртка на странице есть.
    expect(page).toMatch(/from '@\/components\/map\/IdleMount'/);
    // Предзагрузка кода — тем же import(), что у next/dynamic: чанк один.
    expect(page.match(/import\('@\/components\/shared\/VedarMap'\)/g)?.length).toBe(2);
  });
});
