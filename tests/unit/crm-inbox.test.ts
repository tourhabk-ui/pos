/**
 * Сторож «Входящих» партнёра (CRM #2325, шаг 1г).
 *
 * Держит: медиану первого ответа и порог «мало данных» (меньше пяти ответов —
 * не число); то, что ответом считается действие партнёра, а не автомат;
 * отказ одного вида — названный отказ, а не «всё отвечено»; скоуп партнёра в
 * каждом SQL; у запроса мест нет имени туриста до ответа «есть места»; у
 * каждого вида есть путь к ответу; роут — через requirePartner, 503 только
 * когда не прочиталось ничего. Исполнение SQL на настоящем PostgreSQL — в
 * tests/integration/crm-contacts.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requirePartner = vi.fn();
const loadInboxMock = vi.fn();
vi.mock('@/lib/crm/partner-context', () => ({ requirePartner: (...a: unknown[]) => requirePartner(...a) }));
vi.mock('@/lib/services/operators/chat.service', () => ({ chatService: { getTotalUnread: vi.fn(async () => 0) } }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

const inbox = await import('@/lib/crm/inbox');
const { INBOX_SQL } = await import('@/lib/crm/inbox-sql');
const kinds = await import('@/lib/crm/inbox-kinds');

const NOW = Date.parse('2026-10-10T00:00:00Z');
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

beforeEach(() => {
  requirePartner.mockReset();
  loadInboxMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('медиана первого ответа', () => {
  it('медиана: нечётное — середина, чётное — среднее двух средних', () => {
    expect(inbox.median([5, 1, 3])).toBe(3);
    expect(inbox.median([4, 1, 3, 2])).toBe(2.5);
    expect(inbox.median([])).toBeNull();
  });

  it('меньше пяти ответов — «мало данных», а не число', () => {
    const rows = [1, 2, 3, 4].map((h) => ({ kind: 'operator_booking' as const, created_at: iso(10 * H), responded_at: iso(10 * H - h * H) }));
    const s = inbox.responseStats(rows, NOW - 7 * 24 * H, true);
    expect(s).toMatchObject({ enough: false, median_minutes: null, responded: 4, window_days: 7 });
  });

  it('пять и больше — медиана в минутах; отзывы и вне окна не считаются; ответ «раньше создания» — ноль', () => {
    const rows = [
      ...[30, 60, 90, 120].map((m) => ({ kind: 'lead' as const, created_at: iso(20 * H), responded_at: iso(20 * H - m * 60_000) })),
      { kind: 'seat_request' as const, created_at: iso(20 * H), responded_at: iso(21 * H) }, // часы разошлись → 0
      { kind: 'guide_review' as const, created_at: iso(20 * H), responded_at: iso(1 * H) },  // отзыв — не в медиану
      { kind: 'operator_booking' as const, created_at: iso(9 * 24 * H), responded_at: iso(8 * 24 * H) }, // вне окна
      { kind: 'gear_rental' as const, created_at: iso(2 * H), responded_at: null },          // без ответа — не в медиану
    ];
    const s = inbox.responseStats(rows, NOW - 7 * 24 * H, true);
    expect(s).toMatchObject({ enough: true, responded: 5, median_minutes: 60 });
  });

  it('медиана при отказавшем виде помечена неполной', () => {
    expect(inbox.responseStats([], NOW, false).complete).toBe(false);
  });
});

describe('загрузка ящика', () => {
  const row = (over: Record<string, unknown>) => ({
    item_id: '1', created_at: iso(3 * H), title: 'Тур', item_date: '2026-10-20', people: 2,
    waiting: true, responded_at: null, contact_id: null, contact_name: null, ...over,
  });

  it('ждущие — дольше всех первым; отвеченные в список не попадают; вид, что не прочитался, назван', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === INBOX_SQL.seat_request) throw Object.assign(new Error('x'), { code: '42P01' });
      if (sql === INBOX_SQL.operator_booking) {
        return { rows: [row({ item_id: 'b1', created_at: iso(1 * H) }), row({ item_id: 'b2', created_at: iso(5 * H) }), row({ item_id: 'b3', waiting: false, responded_at: iso(H) })] };
      }
      return { rows: [] };
    });
    const r = await inbox.loadInbox('op-1', 'operator', 'u-1', { db: { query } as never, nowMs: NOW, unreadChat: async () => 3 });
    expect(r.items.map((i) => i.id)).toEqual(['b2', 'b1']);
    expect(r.items[0]).toMatchObject({ kind: 'operator_booking', waiting_minutes: 300 });
    expect(r.failed).toEqual(['seat_request']);
    expect(r.response.complete).toBe(false);
    expect(r.chat).toEqual({ state: 'ok', unread: 3 });
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/seat_request не прочитан, SQLSTATE 42P01/);
  });

  it('параметры: окно отзывов ($3) — только запросу отзывов, остальным два', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await inbox.loadInbox('g-1', 'guide', 'u-2', { db: { query } as never, nowMs: NOW, unreadChat: async () => 0 });
    const bySql = new Map(query.mock.calls.map((c) => [c[0] as string, (c as unknown[])[1] as unknown[]]));
    expect(bySql.get(INBOX_SQL.guide_review)).toHaveLength(3);
    expect(bySql.get(INBOX_SQL.guide_invite)).toHaveLength(2);
    for (const params of bySql.values()) expect(params[0]).toBe('g-1');
  });

  it('у роли без чата непрочитанное не спрашивается; отказ чата — «не посчиталось», а не ноль', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const unread = vi.fn(async () => 1);
    expect((await inbox.loadInbox('s-1', 'stay', 'u-3', { db: { query } as never, nowMs: NOW, unreadChat: unread })).chat).toEqual({ state: 'none' });
    expect(unread).not.toHaveBeenCalled();
    const broken = await inbox.loadInbox('o-1', 'operator', 'u-4', {
      db: { query } as never, nowMs: NOW, unreadChat: async () => { throw new Error('x'); },
    });
    expect(broken.chat).toEqual({ state: 'failed' });
  });
});

describe('SQL и словарь', () => {
  it('каждый запрос скоупится партнёром $1 и окном $2', () => {
    for (const k of kinds.INBOX_KINDS) {
      expect(INBOX_SQL[k], k).toMatch(/= \$1\b/);
      expect(INBOX_SQL[k], k).toMatch(/\$2\b/);
    }
  });

  it('ответ партнёра — событие от партнёра, а не от автомата', () => {
    for (const k of ['operator_booking', 'lead', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking'] as const) {
      expect(INBOX_SQL[k], k).toMatch(/actor_kind IN \('partner_user', 'kuzmich', 'mcp'\)/);
      expect(INBOX_SQL[k], k).not.toMatch(/'system'/);
    }
  });

  it('запрос мест — без имени и телефона туриста: контакты после «есть места» (29.09)', () => {
    expect(INBOX_SQL.seat_request).not.toMatch(/tourist_name|tourist_phone|crm_contacts/);
    expect(INBOX_SQL.seat_request).toMatch(/NULL::text AS contact_name/);
  });

  it('у каждого вида роли есть путь к ответу; у вида без ссылки — подсказка, где ответить', () => {
    for (const [cat, list] of Object.entries(kinds.INBOX_BY_CATEGORY)) {
      for (const k of list) {
        const a = kinds.INBOX_ACTION[k];
        expect(a.hint.length, `${cat}:${k}`).toBeGreaterThan(10);
        if (a.href) expect(a.href.startsWith(`/hub/${cat === 'transfer' ? 'carrier' : cat}`), `${cat}:${k}`).toBe(true);
      }
    }
  });

  it('у роли без входящих это сказано словами', () => {
    expect(kinds.INBOX_BY_CATEGORY.agent).toEqual([]);
    expect(kinds.INBOX_NOT_HERE.agent.join(' ')).toMatch(/входящих пока нет/);
  });
});

describe('роут', () => {
  vi.doMock('@/lib/crm/inbox', async (orig) => ({
    ...(await orig<typeof import('@/lib/crm/inbox')>()),
    loadInbox: (...a: unknown[]) => loadInboxMock(...a),
  }));
  const req = () => new NextRequest('http://localhost/api/hub/crm/inbox');
  const OK = { outcome: 'ok', partnerId: 'op-1', category: 'operator', userId: 'u-1' };
  const data = (failed: string[]) => ({ category: 'operator', items: [], failed, response: {}, chat: { state: 'none' }, not_here: [] });

  it('гард не пропустил — ответ гарда, ящик не читается', async () => {
    const { GET } = await import('@/app/api/hub/crm/inbox/route');
    requirePartner.mockResolvedValueOnce(NextResponse.json({ success: false }, { status: 403 }));
    expect((await GET(req())).status).toBe(403);
    expect(loadInboxMock).not.toHaveBeenCalled();
  });

  it('скоуп — из гарда; часть видов не прочиталась — 200 с их списком; ничего — 503', async () => {
    const { GET } = await import('@/app/api/hub/crm/inbox/route');
    requirePartner.mockResolvedValue(OK);
    loadInboxMock.mockResolvedValueOnce(data(['seat_request']));
    const r = await GET(req());
    expect(r.status).toBe(200);
    expect((await r.json()).data.failed).toEqual(['seat_request']);
    expect(loadInboxMock).toHaveBeenCalledWith('op-1', 'operator', 'u-1');

    loadInboxMock.mockResolvedValueOnce(data(['seat_request', 'operator_booking', 'lead', 'tour_review']));
    expect((await GET(req())).status).toBe(503);
  });
});
