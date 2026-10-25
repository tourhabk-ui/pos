/**
 * Витрина /hub/admin/traffic: большая цифра — люди, рядом «боты / свои»,
 * ИИ-краулеры отдельной строкой. Рендер, не поиск по исходнику.
 *
 * Качество 24.10: счётчик пишет только исполнивших скрипт, обходчики ИИ его
 * не исполняют — ноль ИИ не выдаётся за «ИИ не ходят». В топе адресов
 * столбец — просмотры (COUNT(*)), а не визиты.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import AdminTrafficPage from '@/app/hub/admin/traffic/page';
import VisitsBreakdown from '@/app/hub/admin/traffic/_VisitsBreakdown';

const traffic = {
  success: true,
  data: {
    totals: {
      today: { hits: 12, uniques: 4, bots: 40, selfs: 3 },
      week: { hits: 80, visitorDays: 20, bots: 10, selfs: 2 },
      month: { hits: 300, visitorDays: 90, bots: 15, selfs: 5 },
    },
    bots: { month_hits: 15 },
    ai: { today: 7, week: 9, month: 11 },
    self: { month_hits: 5, since: '2026-10-02' },
    daily: [],
    top_paths: [],
    top_referrers: [],
    edges: [],
    pages: [],
    top_exit_pages: [],
    sessions: { total: 0, onePage: 0, avgDepth: null },
    not_found: [],
    funnel: [],
    uniques_since: null,
    addresses: {
      day: '2026-10-24',
      rows: [
        { hash: 'a1b2c3d4e5f6', hits: 48, ua: 'browser' },
        { hash: 'fff000111222', hits: 2, ua: 'не записано' },
      ],
    },
  },
};

const funnel = {
  success: true,
  data: {
    generated_at: '2026-10-24T07:00:00.000Z',
    report: {
      window: { kind: 'day', label: 'Сегодня', date: '2026-10-24', days: null, partial: true, visitor_unit: 'people' },
      counts: { visits: 12, tour_views: 0, booking_starts: 0, leads: 0, bookings: 0, paid: 0 },
      bot_views: 40,
      visit_aside: { bots: 8, selfs: 1, ai: 7 },
      verdict: null,
      verdict_state: 'insufficient_sample',
      unknown_inputs: [],
      insufficient_sample: 'мало',
      failed_measures: [],
      liveness: { views_last_at: null, views_rows_total: 1, beacon_last_at: null, beacon_rows_total: 0 },
      top_paths: [],
      tour_entry_edges: [],
      leads_by_status: [],
      bookings_by_status: [],
    },
    daily: [],
    daily_failed: [],
  },
};

describe('страница посещаемости', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('просмотры — люди, рядом боты и свои, ИИ отдельно', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      json: async () => (String(url).includes('funnel-window') ? funnel : traffic),
    })));
    render(<AdminTrafficPage />);
    expect(await screen.findByText('боты: 40, свои: 3')).toBeTruthy();
    expect(screen.getByText('боты: 8, свои: 1')).toBeTruthy();
    expect(screen.getByText(/ИИ, исполнившие скрипт: 7/)).toBeTruthy();
    expect(screen.getByText('боты: 10, свои: 2')).toBeTruthy();
    expect(screen.getByText('боты: 15, свои: 5')).toBeTruthy();
    expect(screen.getByText(/Исполнили скрипт с меткой ИИ: 11 за 30 дней, сегодня 7, за 7 дней 9/)).toBeTruthy();
    expect(screen.getByText(/В «боты» и в людей не входят/)).toBeTruthy();
    // Большая цифра карточки «сегодня» — 12 людей, не 40 ботов.
    expect(screen.getAllByText('12').length).toBeGreaterThan(0);
    expect(screen.queryByText('52')).toBeNull();
    expect(screen.getByText(/Топ адресов/)).toBeTruthy();
    // COUNT(*) по адресу — просмотры: один человек на 48 страницах — не 48 визитов.
    const table = screen.getByText('a1b2c3d4e5f6').closest('table') as HTMLElement;
    expect(within(table).getByRole('columnheader', { name: 'Просмотры' })).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Визиты' })).toBeNull();
    expect(screen.getByText('a1b2c3d4e5f6')).toBeTruthy();
    expect(screen.getByText('48')).toBeTruthy();
    expect(screen.getByText('browser')).toBeTruthy();
    expect(screen.getByText('не записано')).toBeTruthy();
    expect(screen.getByText(/адреса у них не было/)).toBeTruthy();
    expect(screen.queryByText('203.0.113.1')).toBeNull();
  });

  it('ноль ИИ-краулеров не выдаётся за «ИИ не ходят»: счётчик их не видит', async () => {
    const zero = { ...traffic, data: { ...traffic.data, ai: { today: 0, week: 0, month: 0 } } };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      json: async () => (String(url).includes('funnel-window') ? funnel : zero),
    })));
    render(<AdminTrafficPage />);
    const headline = await screen.findByText('не измеряются здесь');
    expect(headline.closest('p')?.textContent).toBe('ИИ-краулеры: не измеряются здесь');
    expect(screen.queryByText(/ИИ-краулеры: 0/)).toBeNull();
    expect(screen.getByText(/обходчики ИИ \(GPTBot, ClaudeBot,\s+PerplexityBot\) его не исполняют/)).toBeTruthy();
    // Где ИИ видно на самом деле — перепись входов для агентов.
    expect(screen.getByRole('link', { name: 'A2A: кто приходит' }).getAttribute('href')).toBe('/hub/admin/a2a');
    expect(screen.getByText(/Исполнили скрипт с меткой ИИ: 0 за 30 дней/)).toBeTruthy();
  });

  it('порог адреса назван словами того же правила: визит, переход, пять секунд', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      json: async () => (String(url).includes('funnel-window') ? funnel : traffic),
    })));
    render(<AdminTrafficPage />);
    await screen.findByText(/Топ адресов/);
    const rule = screen.getAllByText(/Больше 30 просмотров с адреса за камчатские сутки — бот в тех визитах, где не было ни перехода, ни 5 секунд на странице/);
    expect(rule.length).toBe(2);
  });

  it('«Визиты подробно»: строка ИИ называет, что видны только исполнившие скрипт', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        success: true,
        data: {
          window: { label: 'Сегодня', visitor_unit: 'people', partial: true },
          visits: 4, sources: [], landing: [], devices: [], device_since: null,
          aside: { bots: 2, selfs: 1, ai: 0 }, failed: [],
        },
      }),
    })));
    render(<VisitsBreakdown query="window=day" onClose={() => undefined} />);
    expect(await screen.findByText('ИИ, исполнившие скрипт: 0')).toBeTruthy();
    expect(screen.queryByText(/ИИ-краулеры: 0/)).toBeNull();
  });

  it('несосчитанный топ адресов не показывает ноль', async () => {
    const unknown = {
      ...traffic,
      data: { ...traffic.data, addresses: { day: '2026-10-24', rows: null } },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      json: async () => (String(url).includes('funnel-window') ? funnel : unknown),
    })));
    render(<AdminTrafficPage />);
    expect(await screen.findByText('Топ адресов не сосчитан.')).toBeTruthy();
    expect(screen.queryByText('За эти сутки строк с хэшем адреса нет.')).toBeNull();
  });
});
