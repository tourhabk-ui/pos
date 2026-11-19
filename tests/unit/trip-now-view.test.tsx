/**
 * Блок «Сейчас на ваши даты» на странице сохранённой поездки (#3394, слово
 * владельца 19.11 «начни с обновления плана ближе к датам») — рендером.
 *
 * Что видит человек: что появилось и что ушло в предупреждениях дней; «не
 * изменилось» — только когда правда ничего не изменилось; места туров теми же
 * словами, что страница по ссылке; прогноз — только в горизонте, а дальше
 * сказано «прогноза пока нет»; сбой проверки — «не получилось», а не тишина;
 * ссылка «соберите заново» — только когда есть что менять. Запрос блока идёт
 * в дверь своей поездки.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { TripNowCheck, TripNowView } from '@/components/trips/TripNowCheck';
import type { TripNow, TripNowDay } from '@/lib/trips/trip-now';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const REBUILD = '/planner?arrival=2026-10-24&days=3';

function day(over: Partial<TripNowDay> = {}): TripNowDay {
  return {
    day: 1, date: '2026-10-24', added: [], gone: [], availability: null,
    weather: null, weather_state: 'not_checked', ...over,
  };
}
function checked(days: TripNowDay[], over: Partial<Extract<TripNow, { state: 'checked' }>> = {}): TripNow {
  return {
    state: 'checked', checked_at: '2026-10-23T22:00:00.000Z', days, plan_warnings: [],
    safety_changed: days.some((d) => d.added.length > 0 || d.gone.length > 0), ...over,
  };
}
const view = (now: TripNow | 'loading' | 'failed') =>
  render(<TripNowView now={now} savedAt="2026-10-01T03:00:00.000Z" rebuildHref={REBUILD} />);

describe('TripNowView', () => {
  it('появилось и больше не действует — по дням, со ссылкой собрать заново', () => {
    view(checked([day({ added: ['Шторм на Авачинском'], gone: ['Старое закрытие парка'] })]));
    const box = screen.getByTestId('trip-now-safety-changed');
    expect(box.textContent).toContain('День 1, 24.10');
    expect(box.textContent).toContain('Появилось: Шторм на Авачинском');
    expect(box.textContent).toContain('Больше не действует: Старое закрытие парка');
    expect(screen.queryByTestId('trip-now-safety-same')).toBeNull();
    const link = screen.getByRole('link', { name: 'соберите его заново на те же даты' });
    expect(link.getAttribute('href')).toBe(REBUILD);
    expect(screen.getByTestId('trip-now').textContent).toContain('План не меняется сам');
  });

  it('ничего не изменилось — так и сказано, ссылки собрать заново нет; названы время проверки и день сохранения', () => {
    view(checked([day()]));
    expect(screen.getByTestId('trip-now-safety-same').textContent)
      .toContain('с дня сохранения не изменились');
    expect(screen.queryByTestId('trip-now-rebuild')).toBeNull();
    const text = screen.getByTestId('trip-now').textContent ?? '';
    expect(text).toContain('Проверено 24.10, 10:00 по Камчатке');
    expect(text).toContain('план сохранён 01.10.2026');
  });

  it('предупреждения плана сейчас — списком (в том числе «проверить не удалось»)', () => {
    view(checked([day()], { plan_warnings: ['Официальные предупреждения не прочитаны — проверьте перед выездом.'] }));
    expect(screen.getByTestId('trip-now-plan-warnings').textContent)
      .toContain('Официальные предупреждения не прочитаны');
  });

  it('места: словами страницы по ссылке; нехватка мест — повод собрать заново', () => {
    view(checked([
      day({ availability: { date: '2026-10-24', remaining: 1, state: 'short', checkedAt: '2026-10-23T22:00:00.000Z' } }),
      day({ day: 2, date: '2026-10-25', availability: { date: '2026-10-25', remaining: 0, state: 'on_request' } }),
    ]));
    const seats = screen.getByTestId('trip-now-seats').textContent ?? '';
    expect(seats).toContain('День 1, 24.10: на 24.10 свободно 1');
    expect(seats).toContain('на всю группу не хватит');
    expect(seats).toContain('День 2, 25.10: расписания в системе нет — дату 25.10 подтвердит оператор по заявке');
    expect(screen.getByTestId('trip-now-rebuild')).toBeTruthy();
  });

  it('места есть у всех — блока «собрать заново» нет; у дня без тура строки мест нет', () => {
    view(checked([
      day({ availability: { date: '2026-10-24', remaining: 6, state: 'open', checkedAt: '2026-10-23T22:00:00.000Z' } }),
      day({ day: 2, date: '2026-10-25' }),
    ]));
    const seats = screen.getByTestId('trip-now-seats');
    expect(seats.querySelectorAll('li')).toHaveLength(1);
    expect(screen.queryByTestId('trip-now-rebuild')).toBeNull();
  });

  it('погода: прогноз в горизонте, «не получен» при сбое, «пока нет» дальше 16 суток', () => {
    view(checked([
      day({ weather_state: 'ok', weather: {
        date: '2026-10-24', tempMin: -3, tempMax: 2, windKmh: 55, precipMm: 12, description: 'метель', bad: true,
      } }),
      day({ day: 2, date: '2026-10-25', weather_state: 'unavailable' }),
      day({ day: 20, date: '2026-11-12', weather_state: 'later' }),
    ]));
    const w = screen.getByTestId('trip-now-weather').textContent ?? '';
    expect(w).toContain('День 1, 24.10: -3…2 °C · ветер 55 км/ч · осадки 12 мм · метель');
    expect(w).toContain('День 2, 25.10: прогноз сейчас не получен');
    expect(w).toContain('Для дней с 12.11 прогноза пока нет');
    expect(w).toContain('за 16 суток до даты');
    // День вне горизонта не выдаётся за «прогноз не получен»: спрашивать было рано.
    expect(w).not.toContain('День 20');
  });

  it('все дни дальше горизонта — «на ваши даты прогноза пока нет»; дни без занятий погоду не показывают', () => {
    const { unmount } = view(checked([day({ weather_state: 'later', date: '2026-12-01' })]));
    expect(screen.getByTestId('trip-now-weather').textContent).toContain('Прогноза на ваши даты пока нет');
    unmount();
    view(checked([day()]));
    expect(screen.queryByTestId('trip-now-weather')).toBeNull();
  });

  it('сбой, нет дат, поездка прошла — свои слова, а не пустой блок', () => {
    const { unmount: u1 } = view('failed');
    expect(screen.getByTestId('trip-now-failed').textContent).toContain('Проверить план сейчас не получилось');
    u1();
    const { unmount: u2 } = view({ state: 'no_dates' });
    expect(screen.getByTestId('trip-now').textContent).toContain('не записаны даты');
    u2();
    view({ state: 'past', last_day: '2026-10-02' });
    expect(screen.getByTestId('trip-now').textContent).toContain('последний день — 02.10');
  });
});

describe('TripNowCheck — запрос своей поездки', () => {
  it('спрашивает дверь этой поездки и рисует ответ; сбой сети — «не получилось»', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ success: true, data: { state: 'no_dates' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<TripNowCheck tripId="t-1" savedAt="2026-10-01" rebuildHref={REBUILD} />);
    await waitFor(() => expect(screen.getByTestId('trip-now').textContent).toContain('не записаны даты'));
    expect(fetchMock).toHaveBeenCalledWith('/api/trips/t-1/now');
    unmount();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<TripNowCheck tripId="t-2" savedAt="2026-10-01" rebuildHref={REBUILD} />);
    await waitFor(() => expect(screen.getByTestId('trip-now-failed')).toBeTruthy());
  });

  it('ответ без success — «не получилось», а не «ничего не изменилось»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: false, error: 'x' }) })));
    render(<TripNowCheck tripId="t-3" savedAt="2026-10-01" rebuildHref={REBUILD} />);
    await waitFor(() => expect(screen.getByTestId('trip-now-failed')).toBeTruthy());
    expect(screen.queryByTestId('trip-now-safety-same')).toBeNull();
  });
});
