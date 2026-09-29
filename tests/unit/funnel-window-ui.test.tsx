/**
 * Экран воронки за период: «нет данных» вместо нуля, один запрос на выбор,
 * отказ сервера — словами и с повтором. Рендерится настоящий компонент,
 * `fetch` подменён.
 *
 * Здоровые данные экран показывает и без теста (проверено в браузере на живой
 * схеме); здесь — то, чего на здоровых данных не увидеть: замер, который упал,
 * не должен выглядеть как «сегодня никто не пришёл».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import FunnelWindow from '@/app/hub/admin/traffic/_FunnelWindow';

const baseReport = (over: Record<string, unknown> = {}) => ({
  window: { kind: 'day', label: 'Сегодня, 29.09 (сутки по Камчатке)', date: '2026-09-29', days: null, partial: true, visitor_unit: 'people' },
  counts: { visits: 5, tour_views: 3, booking_starts: 1, leads: 2, bookings: 1, paid: 0 },
  bot_views: 4,
  verdict: null,
  verdict_state: 'no_broken_link',
  unknown_inputs: [],
  insufficient_sample: null,
  failed_measures: [],
  liveness: { views_last_at: '2026-09-29 10:14:02.317308+03', views_rows_total: 100, beacon_last_at: null, beacon_rows_total: 0 },
  top_paths: [{ path: '/', views: 3, visitors: 2 }],
  tour_entry_edges: [],
  leads_by_status: [{ status: 'converted', n: 1 }, { status: 'lost', n: 1 }],
  bookings_by_status: [],
  ...over,
});

const payload = (report: Record<string, unknown>, daily?: unknown[], daily_failed: unknown[] = []) => ({
  success: true,
  data: {
    generated_at: '2026-09-29T05:50:00.000Z',
    report,
    daily: daily ?? [
      { date: '2026-09-29', partial: true, visits: 5, tour_views: 3, booking_starts: 1, leads: 2, bookings: 1, paid: 0 },
      { date: '2026-09-28', partial: false, visits: 0, tour_views: 0, booking_starts: 0, leads: 0, bookings: 0, paid: 0 },
    ],
    daily_failed,
  },
});

function mockFetch(handler: (url: string) => unknown) {
  const fn = vi.fn(async (url: string) => ({ json: async () => handler(String(url)) }));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('воронка за период — экран', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('здоровые данные: числа, метка, «сутки идут»', async () => {
    mockFetch(() => payload(baseReport()));
    render(<FunnelWindow />);
    await screen.findByText('Сегодня, 29.09 (сутки по Камчатке)');
    expect(screen.getByText(/Сутки ещё не закончились/)).toBeTruthy();
    expect(screen.getByText('Просмотры туров', { selector: 'p' }).nextElementSibling?.textContent).toBe('3');
  });

  it('замер упал: «нет данных», а не ноль — и сказано, что не сосчитано', async () => {
    mockFetch(() => payload(baseReport({
      counts: { visits: 5, tour_views: 3, booking_starts: null, leads: null, bookings: 1, paid: 0 },
      failed_measures: [{ measure: 'leads', error: 'boom' }],
      verdict_state: 'unknown',
      unknown_inputs: ['booking_starts', 'leads'],
    }), [
      { date: '2026-09-29', partial: true, visits: 5, tour_views: 3, booking_starts: null, leads: null, bookings: 1, paid: 0 },
    ], [{ measure: 'daily.leads', error: 'boom' }]));
    render(<FunnelWindow />);
    await screen.findByText(/Не удалось сосчитать: leads/);

    // Плитки «Начали бронь» и «Заявки» — «нет данных», не «0».
    // Подпись плитки — <p> (у колонок таблицы — <th>), число — соседний <p>.
    const tile = (label: string) => screen.getByText(label, { selector: 'p' }).nextElementSibling?.textContent;
    expect(tile('Начали бронь')).toBe('нет данных');
    expect(tile('Заявки')).toBe('нет данных');
    // Плитка с настоящим нулём остаётся нулём.
    expect(tile('Оплаты')).toBe('0');
    // Вердикт «не смог», а не «поток есть».
    expect(screen.getByText(/Не смог оценить воронку/)).toBeTruthy();
    expect(screen.queryByText(/Поток до денег есть/)).toBeNull();
    // Таблица по дням: прочерк с пометкой, а не ноль.
    expect(screen.getAllByTitle('не сосчитано').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/прочерк вместо нуля/)).toBeTruthy();
  });

  it('на одних сутках «судить рано» — обычное дело, и это сказано с точкой', async () => {
    mockFetch(() => payload(baseReport({
      verdict_state: 'insufficient_sample',
      insufficient_sample: 'визиты → просмотры тура: наблюдений 1 из 10 — судить рано, это не «всё хорошо»',
    })));
    render(<FunnelWindow />);
    const line = await screen.findByText(/Оценка воронки:/);
    expect(line.textContent).toContain('это не «всё хорошо». На одних сутках это обычное дело');
    expect(line.textContent).not.toMatch(/Судить рано: /);
  });

  it('заявки — статусами CRM по-русски', async () => {
    mockFetch(() => payload(baseReport()));
    render(<FunnelWindow />);
    const line = await screen.findByText(/Заявки по статусам:/);
    expect(line.textContent).toContain('Сделка — 1');
    expect(line.textContent).toContain('Отказ — 1');
    expect(line.textContent).not.toContain('converted');
  });

  it('выбор периода — ровно один запрос со своим окном', async () => {
    const fetchFn = mockFetch(() => payload(baseReport()));
    render(<FunnelWindow />);
    await screen.findByText('Сегодня, 29.09 (сутки по Камчатке)');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toContain('range=today');

    fireEvent.click(screen.getByRole('button', { name: 'Вчера' }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1][0])).toContain('range=yesterday');

    fireEvent.click(screen.getByRole('button', { name: /Показать воронку за 28\.09/ }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));
    expect(String(fetchFn.mock.calls[2][0])).toContain('date=2026-09-28');
  });

  it('отказ сервера — словами, с кнопкой «Повторить»', async () => {
    let calls = 0;
    const fetchFn = mockFetch(() => (++calls === 1
      ? { success: false, error: 'Не удалось прочитать воронку' }
      : payload(baseReport())));
    render(<FunnelWindow />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Не удалось прочитать воронку');

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByText('Сегодня, 29.09 (сутки по Камчатке)');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('сеть упала — тот же отказ словами, а не пустой экран', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof fetch;
    render(<FunnelWindow />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Не удалось прочитать воронку');
  });
});
