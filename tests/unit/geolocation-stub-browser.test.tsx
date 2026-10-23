// @vitest-environment jsdom
/**
 * Геолокация-заглушка не роняет экран (ошибка браузера 23.10).
 *
 * Посетитель карточки места /places/ozyora-malye поймал
 * «navigator.geolocation.watchPosition is not a function»: объект был,
 * функции не было. Проверка «есть ли объект» стояла в четырнадцати файлах.
 * Теперь вход один — lib/geo/current-position: geolocationOnce() для
 * разового запроса и geolocationWatch() для слежения; функция проверяется та,
 * что нужна.
 *
 *  - вызов: заглушка без функций, только разовый запрос, полный объект;
 *  - рендер: баннер офлайн-GPS карточки места на заглушке не падает, на
 *    полном объекте следит и снимает слежку при уходе со страницы;
 *  - запрет: обращения к navigator.geolocation мимо этих двух функций в коде
 *    нет — новое место с проверкой «есть ли объект» краснеет здесь.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { geolocationOnce, geolocationWatch, requestPosition } from '@/lib/geo/current-position';

function setGeo(geo: unknown) {
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); setGeo(undefined); });

describe('проверяется нужная функция, а не наличие объекта', () => {
  it('заглушка без функций — ни разового запроса, ни слежения; requestPosition — «не умеет»', async () => {
    setGeo({});
    expect(geolocationOnce()).toBeNull();
    expect(geolocationWatch()).toBeNull();
    expect(await requestPosition()).toEqual({ ok: false, kind: 'unsupported' });
  });

  it('есть только разовый запрос — он работает, слежения нет (SOS не теряет координаты)', () => {
    setGeo({ getCurrentPosition: vi.fn() });
    expect(geolocationOnce()).not.toBeNull();
    expect(geolocationWatch()).toBeNull();
  });

  it('watchPosition без clearWatch — слежения нет: остановить его было бы нечем', () => {
    setGeo({ getCurrentPosition: vi.fn(), watchPosition: vi.fn() });
    expect(geolocationWatch()).toBeNull();
  });

  it('объекта нет вовсе — null, без исключения', () => {
    setGeo(undefined);
    expect(geolocationOnce()).toBeNull();
    expect(geolocationWatch()).toBeNull();
  });
});

describe('баннер офлайн-GPS карточки места', () => {
  it('на заглушке без watchPosition страница не падает', async () => {
    setGeo({ getCurrentPosition: vi.fn() });
    const { default: OfflineGPSBanner } = await import('@/components/shared/OfflineGPSBanner');
    expect(() => render(React.createElement(OfflineGPSBanner))).not.toThrow();
  });

  it('на полном объекте следит за местом и снимает слежку при уходе', async () => {
    const watchPosition = vi.fn(() => 7);
    const clearWatch = vi.fn();
    setGeo({ getCurrentPosition: vi.fn(), watchPosition, clearWatch });
    const { default: OfflineGPSBanner } = await import('@/components/shared/OfflineGPSBanner');
    const { unmount } = render(React.createElement(OfflineGPSBanner));
    expect(watchPosition).toHaveBeenCalledTimes(1);
    unmount();
    expect(clearWatch).toHaveBeenCalledWith(7);
  });
});

describe('к navigator.geolocation — только через lib/geo/current-position', () => {
  const ROOTS = ['app', 'components', 'hooks', 'lib'];
  const ALLOWED = new Set(['lib/geo/current-position.ts']);

  function walk(dir: string, out: string[]) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
  }

  it('в коде нет проверки «есть ли объект» и прямых вызовов', () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(join(process.cwd(), r), files);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(process.cwd(), f);
      if (ALLOWED.has(rel)) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (/navigator\.geolocation\b|'geolocation'\s+in\s+navigator/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
