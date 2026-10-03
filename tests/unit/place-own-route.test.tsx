/**
 * PlaceOwnRoute — свой рассчитанный автопуть на карточке места (владелец
 * 07.09: «добавить свой трек на место»).
 *
 * До этой правки обе ссылки навигации на карточке места вели во внешние
 * навигаторы (PlaceActionBar, MobileBottomBar) — осознанное решение 11.08,
 * но оно оставляло платформу без единой точки, где показан СВОЙ расчёт
 * (roadGraphCarProvider, уже подключённый в /planning). Сторож держит
 * состояния до карты (idle/locating/building/refused/error через RTL —
 * они не рендерят LeafletMap и потому дешёвы) и статикой — что финальный
 * рендер идёт ИСКЛЮЧИТЕЛЬНО через calculatedCarLine()/calculatedCarToLeafletCoordinates()
 * (§12 CLAUDE.md), без кнопки «Начать маршрут» (mayNavigate: false).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';

vi.mock('next/dynamic', () => ({
  default: () => () => React.createElement('div', { 'data-testid': 'leaflet-map-stub' }),
}));

import { PlaceOwnRoute } from '@/components/places/PlaceOwnRoute';

const SRC = readFileSync(join(process.cwd(), 'components/places/PlaceOwnRoute.tsx'), 'utf-8');

function mockGeolocation(behavior: 'success' | 'denied') {
  const getCurrentPosition = vi.fn((success: PositionCallback, error?: PositionErrorCallback) => {
    if (behavior === 'success') {
      success({ coords: { latitude: 53.0, longitude: 158.0, accuracy: 10 } } as GeolocationPosition);
    } else {
      error?.({} as GeolocationPositionError);
    }
  });
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PlaceOwnRoute — машина состояний', () => {
  it('idle: кнопка «Построить свой путь»', () => {
    mockGeolocation('success');
    render(<PlaceOwnRoute lat={53.1} lng={158.1} name="Дикие озерки" />);
    expect(screen.getByText(/Построить путь — пешком или на машине/)).toBeTruthy();
  });

  it('нет geolocation в браузере — честная ошибка, не тишина', () => {
    vi.stubGlobal('navigator', {});
    render(<PlaceOwnRoute lat={53.1} lng={158.1} name="Дикие озерки" />);
    fireEvent.click(screen.getByText(/Построить путь — пешком или на машине/));
    expect(screen.getByText(/Геолокация недоступна/)).toBeTruthy();
  });

  it('отказ геолокации — честное сообщение с повтором', () => {
    mockGeolocation('denied');
    render(<PlaceOwnRoute lat={53.1} lng={158.1} name="Дикие озерки" />);
    fireEvent.click(screen.getByText(/Построить путь — пешком или на машине/));
    expect(screen.getByText(/Не удалось определить ваше местоположение/)).toBeTruthy();
    expect(screen.getByText(/Попробовать снова/)).toBeTruthy();
  });

  it('unsupported от сервера — причина показана как есть, не выдумана', async () => {
    mockGeolocation('success');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        result: { status: 'unsupported', reason: 'Точка вне Камчатского края — маршрутизация здесь не предлагается.' },
      }),
    }));
    render(<PlaceOwnRoute lat={53.1} lng={158.1} name="Дикие озерки" />);
    fireEvent.click(screen.getByText(/Построить путь — пешком или на машине/));
    await waitFor(() => {
      expect(screen.getByText(/маршрутизация здесь не предлагается/)).toBeTruthy();
    });
  });

  it('not_found — честная причина отказа роутера, не пустой экран', async () => {
    mockGeolocation('success');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        result: { status: 'not_found', reason: 'Точка слишком далеко от известной дороги.' },
      }),
    }));
    render(<PlaceOwnRoute lat={53.1} lng={158.1} name="Дикие озерки" />);
    fireEvent.click(screen.getByText(/Построить путь — пешком или на машине/));
    await waitFor(() => {
      expect(screen.getByText(/слишком далеко от известной дороги/)).toBeTruthy();
    });
  });

  it('сеть упала — честная ошибка сети', async () => {
    mockGeolocation('success');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    render(<PlaceOwnRoute lat={53.1} lng={158.1} name="Дикие озерки" />);
    fireEvent.click(screen.getByText(/Построить путь — пешком или на машине/));
    await waitFor(() => {
      expect(screen.getByText(/Ошибка сети/)).toBeTruthy();
    });
  });

  const calc = (travelMode: 'car' | 'foot', distanceM: number, durationS: number, provider: string) => ({
    kind: 'calculated_car',
    geometry: { type: 'LineString', coordinates: [[158.0, 53.0], [158.1, 53.1]] },
    distanceM, durationS,
    originSnapped: { lat: 53.001, lon: 158.001, snapDistanceM: 20 },
    destinationSnapped: { lat: 53.099, lon: 158.099, snapDistanceM: 15 },
    provider,
    builtAt: new Date().toISOString(),
    traffic: false, mayDisplay: true, mayNavigate: false, mayPersist: false, travelMode,
  });
  /** Ответ сервера по режиму из тела запроса — как настоящий /api/routes/build. */
  function serveModes(foot: unknown, car: unknown) {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { body: string }) => {
      const mode = (JSON.parse(init.body) as { mode: 'foot' | 'car' }).mode;
      return Promise.resolve({ json: () => Promise.resolve(mode === 'foot' ? foot : car) });
    }));
  }
  const found = (id: string, title: string, c: unknown) => ({
    success: true,
    result: { status: 'found', options: [{ id, title, distanceKm: 1, lineGrade: null, difficulty: null, elevationGainM: null, waypointNames: [], calculated: c }] },
  });

  it('found — оба режима посчитаны, вкладки со временем, карта видна', async () => {
    mockGeolocation('success');
    serveModes(
      found('calculated-foot', 'Дикие озерки', calc('foot', 5000, 3780, 'Ведар — тропы и дороги OpenStreetMap')),
      found('calculated-car', 'Дикие озерки', calc('car', 12300, 900, 'Ведар — свой дорожный граф Камчатки')),
    );
    render(<PlaceOwnRoute lat={53.1} lng={158.1} name="Дикие озерки" />);
    fireEvent.click(screen.getByText(/Построить путь — пешком или на машине/));
    await waitFor(() => {
      expect(screen.getByTestId('leaflet-map-stub')).toBeTruthy();
    });
    // Пеший путь 5 км — показан первым (FOOT_DEFAULT_MAX_M), обе вкладки со временем.
    expect(screen.getByText('1 ч 3 мин')).toBeTruthy();
    expect(screen.getByText('15 мин')).toBeTruthy();
    expect(screen.getByText(/Ведар — тропы и дороги OpenStreetMap/)).toBeTruthy();
    expect(screen.getByText(/На месте его никто не проверял/)).toBeTruthy();
    expect(screen.queryByText(/Пробки/)).toBeNull();
    // Переключение на машину — другая линия, другой провайдер.
    fireEvent.click(screen.getByText('15 мин'));
    expect(screen.getByText(/Ведар — свой дорожный граф Камчатки/)).toBeTruthy();
    expect(screen.queryByText(/Начать маршрут/)).toBeNull();
  });

  it('пешком нет, машиной есть — открывается машина, вкладка «Пешком — нет» с причиной', async () => {
    mockGeolocation('success');
    serveModes(
      { success: true, result: { status: 'not_found', reason: 'Связного пути по нашим данным нет' } },
      found('calculated-car', 'Дикие озерки', calc('car', 40000, 2400, 'Ведар — свой дорожный граф Камчатки')),
    );
    render(<PlaceOwnRoute lat={53.1} lng={158.1} name="Дикие озерки" />);
    fireEvent.click(screen.getByText(/Построить путь — пешком или на машине/));
    await waitFor(() => expect(screen.getByText('Пешком — нет')).toBeTruthy());
    expect(screen.getByText(/Ведар — свой дорожный граф Камчатки/)).toBeTruthy();
    fireEvent.click(screen.getByText('Пешком — нет'));
    expect(screen.getByText(/Связного пути по нашим данным нет/)).toBeTruthy();
  });

  it('тропа не дошла до цели — остаток назван заголовком сервера', async () => {
    mockGeolocation('success');
    serveModes(
      found('calculated-foot', 'Пешком к «Дикие озерки» — последние 700 м без тропы, по азимуту', calc('foot', 3000, 2400, 'Ведар — тропы и дороги OpenStreetMap')),
      { success: true, result: { status: 'not_found', reason: 'нет' } },
    );
    render(<PlaceOwnRoute lat={53.1} lng={158.1} name="Дикие озерки" />);
    fireEvent.click(screen.getByText(/Построить путь — пешком или на машине/));
    await waitFor(() => expect(screen.getByText(/последние 700 м без тропы, по азимуту/)).toBeTruthy());
  });
});

describe('PlaceOwnRoute — линия строго по контракту §12', () => {
  it('линия собирается через calculatedLine() + calculatedCarToLeafletCoordinates(), не вручную', () => {
    // Род линии — по режиму, которым считали (03.10): пешком — пунктир
    // calculatedFootLine, машиной — calculatedCarLine.
    expect(SRC).toMatch(/import \{ calculatedLine \} from '@\/lib\/map\/line-standard'/);
    expect(SRC).toMatch(/const line = calculatedLine\(route\.travelMode \?\? state\.selected\)/);
    expect(SRC).toMatch(/import \{ calculatedCarToLeafletCoordinates, type CalculatedCarRoute \} from '@\/lib\/on-route\/calculated-route'/);
    expect(SRC).not.toMatch(/color:\s*['"]#/);
  });

  it('mayDisplay:false — честный отказ показа, не рисуем линию через голову провайдера', () => {
    expect(SRC).toMatch(/route\.mayDisplay/);
    expect(SRC).toMatch(/не разрешил показать геометрию/);
  });
});
