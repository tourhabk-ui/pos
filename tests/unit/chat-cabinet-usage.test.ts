/**
 * Счёт пользования кабинетом в чате (lib/chat-cabinet/usage, 1353) — вызовом
 * с подменённой базой. Запрос на настоящей схеме судит
 * tests/integration/chat-cabinet.pg.test.ts.
 *
 * Держит:
 *  - в базу уходят только день по Камчатке, карточка, место, канал, действие
 *    и исход — ни текста экрана, ни запроса поиска, ни чата;
 *  - отказ базы — «failed» по экрану, не по тексту;
 *  - отказ записи счёта нажатие не роняет и не глушится: SQLSTATE в лог.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CABINET_USAGE_SQL, countCabinetUse, usageOutcome } from '@/lib/chat-cabinet/usage';

const PID = '11111111-1111-4111-8111-111111111111';
/** 30.10 08:12 по Камчатке — 29.10 по UTC. */
const AT = Date.UTC(2026, 9, 29, 20, 12);

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });

describe('счёт нажатий', () => {
  it('в базу — шесть значений без текста; день — камчатский', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const screen = { text: 'По запросу «Петрова» найдено: 1. Анна П.', rows: [], pd: true };
    await countCabinetUse({ partnerId: PID, seat: 'member', channel: 'max', action: 'search_query', screen }, AT, { query } as never);
    expect(query).toHaveBeenCalledWith(CABINET_USAGE_SQL, ['2026-10-30', PID, 'member', 'max', 'search_query', 'ok']);
    expect(JSON.stringify(query.mock.calls)).not.toMatch(/Петрова|Анна/);
  });

  it('исход — по отметке экрана, а не по словам', () => {
    expect(usageOutcome({ text: 'База не ответила', rows: [], pd: false })).toBe('ok');
    expect(usageOutcome({ text: 'что угодно', rows: [], pd: false, failed: true })).toBe('failed');
  });

  it('отказ записи — без исключения, SQLSTATE и действие в лог', async () => {
    const query = vi.fn(async () => { throw Object.assign(new Error('x'), { code: '23514' }); });
    await expect(countCabinetUse(
      { partnerId: PID, seat: 'owner', channel: 'telegram', action: 'tasks', screen: { text: '', rows: [], pd: false } }, AT, { query } as never,
    )).resolves.toBeUndefined();
    const log = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(log).toContain('23514');
    expect(log).toContain('tasks');
  });
});
