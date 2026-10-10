/**
 * Сторож напоминаний о входящих без ответа (CRM 1г-2, #2325).
 *
 * Держит: одна ступень 2 часа и окно до 24 часов (дальше — дверь Watchdog,
 * второе сообщение об одном и том же — дубль); заявок и запросов мест здесь
 * нет (у них свои механизмы); тихие часы; ПД только в MAX, Telegram —
 * заглушка; три исхода записываются, отказ доставки — повтор; не прочитанный
 * вид назван, а не проглочен. Исполнение SQL на настоящем PostgreSQL — в
 * tests/integration/crm-contacts.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: vi.fn() }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn() }));

const R = await import('@/lib/crm/inbox-reminders');

/** 10:00 по Камчатке (UTC+12) — день. */
const DAY = new Date('2026-10-09T22:00:00Z');
/** 23:30 по Камчатке — тихие часы. */
const NIGHT = new Date('2026-10-10T11:30:00Z');

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  partner_id: 'p1', category: 'stay', item_id: 'b1', created_at: new Date('2026-10-09T18:00:00Z'),
  title: 'Дом у <реки>', item_date: '2026-10-20', contact_name: 'Анна <П.>', ...over,
});

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));

describe('SQL', () => {
  it('виды — только те, где напоминание наше: без заявок, запросов мест и отзывов', () => {
    expect([...R.INBOX_REMIND_KINDS]).toEqual(['operator_booking', 'accommodation_booking', 'gear_rental', 'transfer_seat_booking', 'guide_invite']);
  });

  it('у каждого вида: ждёт статус «новый», ступень и окно — параметрами, напоминание одно', () => {
    for (const k of R.INBOX_REMIND_KINDS) {
      const sql = R.INBOX_REMIND_SQL[k];
      expect(sql, k).toMatch(/<= \$1::timestamptz - \(\$2::int \* INTERVAL '1 minute'\)/);
      expect(sql, k).toMatch(/> \$1::timestamptz - \(\$3::int \* INTERVAL '1 hour'\)/);
      expect(sql, k).toMatch(new RegExp(`NOT EXISTS \\(SELECT 1 FROM crm_inbox_reminders r[\\s\\S]*r\\.item_kind = '${k}'`));
    }
    expect(R.INBOX_REMIND_SQL.operator_booking).toMatch(/booking_status = 'new' AND b\.deleted_at IS NULL/);
    expect(R.INBOX_REMIND_SQL.transfer_seat_booking).toMatch(/sb\.status = 'requested'/);
    expect(R.INBOX_REMIND_SQL.guide_invite).toMatch(/i\.status = 'pending'/);
  });

  it('ступень 2 часа, окно 24 часа — граница с Watchdog', () => {
    expect(R.INBOX_REMIND_AFTER_MINUTES).toBe(120);
    expect(R.INBOX_REMIND_WINDOW_HOURS).toBe(24);
  });

  it('исход — без дублей по паре (партнёр, предмет)', () => {
    expect(R.MARK_INBOX_REMINDED_SQL).toMatch(/ON CONFLICT \(partner_id, item_kind, item_id\) DO NOTHING/);
  });
});

describe('сообщение', () => {
  it('в MAX — названия и имена, экранированные; в Telegram — заглушка без имён', () => {
    const m = R.inboxReminderMessage([{ ...row(), kind: 'accommodation_booking' } as never]);
    expect(m.text).toContain('Ждут ответа больше 2 часов: 1');
    expect(m.text).toContain('Бронь жилья «Дом у &lt;реки&gt;» · 20.10 — Анна &lt;П.&gt;');
    expect(m.stub).not.toMatch(/Анна|Дом у/);
    expect(m.stub).toContain('во «Входящих»');
    expect(m.buttons).toEqual([{ text: 'Открыть входящие', url: 'https://vedarai.ru/hub/stay/inbox' }]);
  });

  it('перевозчик ведётся в свой кабинет; больше десяти — «и ещё»', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...row({ item_id: `t${i}`, category: 'transfer', contact_name: null }), kind: 'transfer_seat_booking' }));
    const m = R.inboxReminderMessage(many as never);
    expect(m.buttons?.[0].url).toBe('https://vedarai.ru/hub/carrier/inbox');
    expect(m.text).toContain('…и ещё 2');
  });
});

describe('прогон', () => {
  const ok = { reachable: true, maxChatId: '1', telegramChatId: null };

  it('ночью — ни запроса, ни сообщения', async () => {
    const query = vi.fn();
    const r = await R.runInboxReminders(NIGHT, { db: { query } as never, reach: vi.fn(), send: vi.fn() });
    expect(r.quiet).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('одно сообщение партнёру со всеми предметами; исходы записаны; отказ доставки и «адрес не прочитан» — без записи', async () => {
    const rows: Record<string, unknown[]> = {
      accommodation_booking: [row({ partner_id: 'p1' }), row({ partner_id: 'p2', item_id: 'b2' })],
      guide_invite: [row({ partner_id: 'p3', item_id: 'i1', category: 'guide', contact_name: null })],
      gear_rental: [row({ partner_id: 'p4', item_id: 'g1', category: 'gear' }), row({ partner_id: 'p1', item_id: 'g2', category: 'stay' })],
    };
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql === R.MARK_INBOX_REMINDED_SQL) return { rows: [] };
      expect(params).toEqual([DAY.toISOString(), 120, 24]);
      const kind = (Object.entries(R.INBOX_REMIND_SQL).find(([, s]) => s === sql) ?? [])[0] as string;
      return { rows: rows[kind] ?? [] };
    });
    const reach = vi.fn(async (id: string) => (id === 'p2' ? null : id === 'p3' ? { reachable: false, maxChatId: null, telegramChatId: null } : ok));
    const send = vi.fn(async () => ({ channel: 'max', delivered: true, reason: 'ok' }))
      .mockResolvedValueOnce({ channel: 'max', delivered: true, reason: 'ok' })          // p1
      .mockResolvedValueOnce({ channel: 'none', delivered: false, reason: 'MAX 500' });  // p4
    const r = await R.runInboxReminders(DAY, { db: { query } as never, reach: reach as never, send: send as never });
    expect(r).toMatchObject({ due: 5, partners: 4, sent_max: 1, unreachable: 1, failed: 1, reach_unknown: 1, failed_kinds: [] });

    const marks = query.mock.calls.filter((c) => c[0] === R.MARK_INBOX_REMINDED_SQL).map((c) => c[1]);
    expect(marks).toEqual([
      ['p1', ['accommodation_booking', 'gear_rental'], ['b1', 'g2'], 'max'],
      ['p3', ['guide_invite'], ['i1'], 'unreachable'],
    ]);
    // У p1 оба предмета — одним сообщением.
    expect(send.mock.calls[0][0].text).toContain('Ждут ответа больше 2 часов: 2');
  });

  it('вид не прочитался — назван, остальные идут своим ходом', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === R.INBOX_REMIND_SQL.gear_rental) throw Object.assign(new Error('x'), { code: '42703' });
      return { rows: [] };
    });
    const r = await R.runInboxReminders(DAY, { db: { query } as never, reach: vi.fn(), send: vi.fn() });
    expect(r.failed_kinds).toEqual(['gear_rental']);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/gear_rental не прочитан, SQLSTATE 42703/);
  });
});
