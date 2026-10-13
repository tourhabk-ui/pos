/**
 * Бронь из чата Кузьмича — копия менеджерам команды кабинета (CRM 2г-4).
 *
 * Проверяется вызовом настоящего `createBooking` (lib/kuzmich/core.ts) с
 * подменённой базой, а не поиском строки в модуле: правило — поведение, а не
 * текст (CLAUDE.md §4, решение владельца 13.10).
 *
 * Что держит:
 *  - копия уходит команде кабинета тура тем же текстом, что оператору;
 *  - имя и телефон туриста — только в тексте для MAX, в заглушке их нет;
 *  - кнопки — только ссылки;
 *  - копия не зависит от того, подключил ли канал сам кабинет.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { clientQuery, poolQuery, teamMock, reachMock, pdMock } = vi.hoisted(() => ({
  clientQuery: vi.fn(), poolQuery: vi.fn(), teamMock: vi.fn(), reachMock: vi.fn(), pdMock: vi.fn(),
}));
vi.mock('@/lib/database', () => ({
  transaction: (cb: (client: { query: (...args: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...args: unknown[]) => clientQuery(...args) }),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...args: unknown[]) => poolQuery(...args) } }));
vi.mock('@/lib/operators/team-notify', () => ({ notifyTeamOfTour: (...a: unknown[]) => teamMock(...a) }));
vi.mock('@/lib/partners/reach', () => ({ reachForTour: (...a: unknown[]) => reachMock(...a) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => pdMock(...a) }));

import { createBooking } from '@/lib/kuzmich/core';

const TOUR = { id: 7, title: 'Вулкан Горелый', base_price: 9000, multi_day_count: null };
const PENDING = { tour: TOUR, name: 'Иван Иванов', phone: '+79991234567', participants: 2, date: '2099-07-01' };

function mockDb() {
  clientQuery.mockImplementation((sql: string) => {
    const s = String(sql);
    if (s.includes('FROM operator_tours')) return Promise.resolve({ rows: [{ operator_id: 'op-1', title: TOUR.title, base_price: '9000', max_participants: 10, multi_day_count: null, duration_hours: 6 }] });
    if (s.includes('generate_series')) return Promise.resolve({ rows: [{ date: PENDING.date, occupied: '0', available_slots: null, is_cancelled: null }] });
    if (s.includes('INSERT INTO operator_bookings')) return Promise.resolve({ rows: [{ id: 101, access_token: '11111111-2222-3333-4444-555555555555' }] });
    if (s.includes('FROM tour_pricing_rules') || s.includes('FROM tour_price_tiers') || s.includes('v_tour_daily_occupancy')) return Promise.resolve({ rows: [] });
    throw new Error('unexpected SQL: ' + s);
  });
  poolQuery.mockResolvedValue({ rows: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb();
  teamMock.mockResolvedValue({ state: 'sent', members: 1, delivered: 1, stubbed: 0 });
  pdMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

type TeamMsg = { text: string; stub: string; buttons: Array<Record<string, string>> };

describe('бронь из чата Кузьмича — копия команде кабинета', () => {
  it('тем же текстом, что оператору; ПД только в тексте для MAX; кнопки — ссылки', async () => {
    reachMock.mockResolvedValue({ maxChatId: '900', telegramChatId: '901', telegramSource: 'partner', reachable: true });
    expect(await createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg')).toMatchObject({ id: 101 });
    await vi.waitFor(() => expect(teamMock).toHaveBeenCalledTimes(1));

    const [tourId, msg, what] = teamMock.mock.calls[0] as [number, TeamMsg, string];
    expect(tourId).toBe(7);
    expect(what).toBe('бронь #101');
    expect(msg.text).toContain('Иван Иванов');
    expect(msg.text).toContain('+79991234567');
    expect(msg.stub).not.toContain('Иван Иванов');
    expect(msg.stub).not.toContain('+79991234567');
    expect(msg.buttons.length).toBeGreaterThan(0);
    for (const b of msg.buttons) expect(Object.keys(b).sort()).toEqual(['text', 'url']);

    const toOperator = pdMock.mock.calls.map(c => c[0] as { text: string; to?: unknown }).find(p => p.to);
    expect(toOperator?.text).toBe(msg.text);
  });

  it('у кабинета канала нет — команде копия всё равно уходит', async () => {
    reachMock.mockResolvedValue({ maxChatId: null, telegramChatId: null, telegramSource: null, reachable: false });
    await createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg');
    await vi.waitFor(() => expect(teamMock).toHaveBeenCalledTimes(1));
    expect(teamMock.mock.calls[0]![0]).toBe(7);
  });
});
