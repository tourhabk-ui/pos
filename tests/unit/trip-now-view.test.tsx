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
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { TripNowCheck, TripNowView } from '@/components/trips/TripNowCheck';
import type { TripNow, TripNowDay } from '@/lib/trips/trip-now-types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const REBUILD = '/planner?arrival=2026-10-24&days=3';

function day(over: Partial<TripNowDay> = {}): TripNowDay {
  return {
    day: 1, date: '2026-10-24', added: [], gone: [], availability: null,
    weather: null, weather_state: 'not_checked', replaceable: true, activity: 'volcano', ...over,
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

  it('ответ чужой формы — «не получилось», страница не падает', async () => {
    // Так отвечала подставная дверь соседнего теста страницы поездки: под
    // любым /api/trips/… — сама поездка. Блок рухнул и унёс всю страницу.
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: { id: 'trip-1', days: [] } }) })));
    render(<TripNowCheck tripId="t-4" savedAt="2026-10-01" rebuildHref={REBUILD} />);
    await waitFor(() => expect(screen.getByTestId('trip-now-failed')).toBeTruthy());
  });
});

describe('замена дня новым черновиком (#3394, срез 2)', () => {
  const DRAFT = '22222222-3333-4444-8555-666666666666';
  const withTrip = (now: TripNow) =>
    render(<TripNowView now={now} savedAt="2026-10-01T03:00:00.000Z" rebuildHref={REBUILD} tripId="t-9" />);

  it('кнопка — только у дня с новым предупреждением, который можно заменить; без id поездки кнопки нет', () => {
    const now = checked([
      day({ day: 1, added: ['Шторм'] }),
      day({ day: 2, date: '2026-10-25', gone: ['Старое'] }),
      day({ day: 3, date: '2026-10-26', added: ['Закрыт парк'], replaceable: false }),
    ]);
    const { unmount } = withTrip(now);
    expect(screen.getByTestId('trip-now-replace-1')).toBeTruthy();
    expect(screen.queryByTestId('trip-now-replace-2')).toBeNull();
    expect(screen.queryByTestId('trip-now-replace-3')).toBeNull();
    unmount();
    view(now);
    expect(screen.queryByTestId('trip-now-replace-1')).toBeNull();
  });

  it('в списке нет занятия, которое уже стоит в дне', () => {
    withTrip(checked([day({ added: ['Шторм'], activity: 'volcano' })]));
    const select = screen.getByLabelText('Заменить день 1 на') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).not.toContain('volcano');
    expect(values).toContain('thermal');
  });

  it('подобрано — новый черновик со словами правила, строками нового дня и ссылкой; поездка не изменилась', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ success: true, data: {
      state: 'drafted', draft_id: DRAFT,
      note: 'Заменил день 1 (24 октября): было «Авачинский вулкан», стало «Паратунка». Остальные дни не менялись.',
      day: { day: 1, date: '2026-10-24', title: 'Паратунка', zone: 'avachinsky', warnings: ['Шторм в Авачинской зоне'] },
      plan_warnings: ['Сводка МЧС не прочитана'],
    } }) }));
    vi.stubGlobal('fetch', fetchMock);
    withTrip(checked([day({ added: ['Шторм'] })]));
    fireEvent.change(screen.getByLabelText('Заменить день 1 на'), { target: { value: 'thermal' } });
    fireEvent.click(screen.getByRole('button', { name: /Подобрать замену/ }));
    const box = await screen.findByTestId('trip-now-draft-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/trips/t-9/replace-day', expect.objectContaining({ method: 'POST' }));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ day: 1, interest: 'thermal' });
    expect(box.textContent).toContain('было «Авачинский вулкан», стало «Паратунка»');
    // Замена не обещает, что предупреждение снято: строка нового дня — как есть.
    expect(box.textContent).toContain('Шторм в Авачинской зоне');
    expect(box.textContent).toContain('Сводка МЧС не прочитана');
    expect(box.textContent).toContain('Ваша поездка не изменилась');
    expect(within(box).getByRole('link', { name: 'Открыть черновик' }).getAttribute('href')).toBe(`/trip/${DRAFT}`);
  });

  it('у нового дня строк нет — так и сказано', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: {
      state: 'drafted', draft_id: DRAFT, note: 'Заменил день 1.', plan_warnings: [],
      day: { day: 1, date: '2026-10-24', title: 'Паратунка', zone: 'avachinsky', warnings: [] },
    } }) })));
    withTrip(checked([day({ added: ['Шторм'] })]));
    fireEvent.click(screen.getByRole('button', { name: /Подобрать замену/ }));
    expect((await screen.findByTestId('trip-now-draft-1')).textContent).toContain('У нового дня предупреждений нет.');
  });

  it('отказ правила — его причина; сбой сети и чужая форма ответа — «не получилось»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: { state: 'refused', reason: 'День 1 — день прилёта, его не заменяют.' } }) })));
    const { unmount } = withTrip(checked([day({ added: ['Шторм'] })]));
    fireEvent.click(screen.getByRole('button', { name: /Подобрать замену/ }));
    expect((await screen.findByRole('status')).textContent).toBe('День 1 — день прилёта, его не заменяют.');
    unmount();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const second = withTrip(checked([day({ added: ['Шторм'] })]));
    fireEvent.click(screen.getByRole('button', { name: /Подобрать замену/ }));
    expect((await screen.findByRole('status')).textContent).toContain('Подобрать замену не получилось');
    second.unmount();

    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true, data: { state: 'drafted', draft_id: 'x' } }) })));
    withTrip(checked([day({ added: ['Шторм'] })]));
    fireEvent.click(screen.getByRole('button', { name: /Подобрать замену/ }));
    expect((await screen.findByRole('status')).textContent).toContain('Подобрать замену не получилось');
    expect(screen.queryByTestId('trip-now-draft-1')).toBeNull();
  });
});
