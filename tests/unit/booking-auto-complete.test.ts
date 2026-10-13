/**
 * Тур завершается сам на следующий день после даты (решение владельца 13.10:
 * «тур завершать автоматически»).
 *
 * До этого бронь становилась завершённой только кнопкой оператора, и от неё
 * зависели отзыв, просьба об отзыве и баллы. Сторож держит связку целиком:
 *   · отбор — подтверждённые, не удалённые, последний день тура прошёл по
 *     Камчатке (многодневный тур — по своему последнему дню); SQL отбора
 *     проверен на PostgreSQL 16;
 *   · завершение — тем же completeBooking, что у кнопки, без человека и с
 *     причиной словами; в журнале броней changed_by пуст, в CRM актор system;
 *   · баллы — тем же awardCompletionLoyalty, что у кнопки;
 *   · отказ одной брони не останавливает остальные и назван в ответе; отказ
 *     отбора — 502 с SQLSTATE, а не «завершать нечего»;
 *   · крон зовётся шагом раньше просьбы об отзыве и стоит в реестре кронов.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const { poolQuery, completeBookingMock, awardMock, dbQuery, recordEvent } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  completeBookingMock: vi.fn(),
  awardMock: vi.fn(),
  dbQuery: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/lib/bookings/completion-loyalty', () => ({ awardCompletionLoyalty: (...a: unknown[]) => awardMock(...a) }));

import {
  autoCompletePastTours, AUTO_COMPLETE_BATCH, AUTO_COMPLETE_COMMENT, DUE_BOOKINGS_SQL, TOUR_LAST_DAY_SQL,
} from '@/lib/bookings/auto-complete-past';
import * as bookingService from '@/lib/bookings/booking.service';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

beforeEach(() => {
  vi.restoreAllMocks();
  poolQuery.mockReset();
  completeBookingMock.mockReset();
  awardMock.mockReset();
  vi.spyOn(bookingService, 'completeBooking').mockImplementation((...a: unknown[]) => completeBookingMock(...a));
});

describe('кого завершать', () => {
  it('подтверждённые, не удалённые, последний день тура прошёл по Камчатке', () => {
    const sql = DUE_BOOKINGS_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain("ob.booking_status = 'confirmed'");
    expect(sql).toContain('ob.deleted_at IS NULL');
    expect(sql).toContain(`${TOUR_LAST_DAY_SQL} < (NOW() AT TIME ZONE 'Asia/Kamchatka')::date`);
    // Многодневный тур — по последнему дню: дата брони или её конец, длительность брони или тура.
    expect(TOUR_LAST_DAY_SQL).toContain('ob.end_date');
    expect(TOUR_LAST_DAY_SQL).toContain('ob.duration_days');
    expect(TOUR_LAST_DAY_SQL).toContain('ot.multi_day_count');
    expect(sql).toContain('LIMIT $1');
  });
});

describe('завершение тем же путём, что у кнопки', () => {
  it('без человека и с причиной; баллы тем же местом; отказ одной брони не мешает другим', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: '11' }, { id: '12' }] });
    const done = { tourist: { id: 'u-1' }, totalAmount: 11000 };
    // Отказывает ПЕРВАЯ: вторая обязана завершиться всё равно.
    completeBookingMock.mockImplementation(async (id: string) => {
      if (id === '11') throw new Error('Нельзя изменить статус заявки в терминальном состоянии (cancelled)');
      return done;
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const s = await autoCompletePastTours();

    expect(poolQuery).toHaveBeenCalledWith(DUE_BOOKINGS_SQL, [AUTO_COMPLETE_BATCH]);
    expect(completeBookingMock).toHaveBeenCalledWith('11', null, { comment: AUTO_COMPLETE_COMMENT });
    expect(completeBookingMock).toHaveBeenCalledWith('12', null, { comment: AUTO_COMPLETE_COMMENT });
    expect(awardMock).toHaveBeenCalledTimes(1);
    expect(awardMock).toHaveBeenCalledWith(done, '12');
    expect(s).toEqual({
      due: 2,
      completed: ['12'],
      failed: [{ id: '11', error: expect.stringMatching(/терминальном/) }],
    });
    expect(err).toHaveBeenCalled();
  });

  it('причина словами: дата прошла, оператор не отметил отмену или неявку', () => {
    expect(AUTO_COMPLETE_COMMENT).toMatch(/автоматически/);
    expect(AUTO_COMPLETE_COMMENT).toMatch(/неявку/);
  });
});

describe('completeBooking без человека', () => {
  it('в журнал броней — changed_by пуст и причина; в CRM — актор system', async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doMock('@/lib/database', () => ({
      query: (...a: unknown[]) => dbQuery(...a),
      transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) => cb({ query: (...a: unknown[]) => dbQuery(...a) }),
    }));
    vi.doMock('@/lib/crm/events', async (orig) => ({
      ...(await orig<typeof import('@/lib/crm/events')>()),
      recordSourceEventQuietly: (...a: unknown[]) => recordEvent(...a),
    }));
    const row = {
      id: '42', status: 'confirmed', tour_id: '7', total_price: '10000', date: '2026-10-10', start_date: '2026-10-10',
      participants: 2, guests_count: 2, created_at: '2026-10-01', updated_at: '2026-10-01', tour_name: 'Тур', user_id: 'u-1',
    };
    dbQuery.mockImplementation(async (sql: string) => ({ rows: /^\s*(SELECT|WITH)/i.test(sql) || /FOR UPDATE/.test(sql) ? [row] : [] }));
    const { completeBooking } = await import('@/lib/bookings/booking.service');

    await completeBooking('42', null, { comment: AUTO_COMPLETE_COMMENT });

    const log = dbQuery.mock.calls.find((c) => /INSERT INTO booking_logs/.test(String(c[0])));
    expect(log?.[1]).toEqual(['42', 'confirmed', 'completed', null, AUTO_COMPLETE_COMMENT]);
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ actorKind: 'system', actorUserId: null }));

    // Кнопка оператора — как прежде: его id и «Тур завершён», актор partner_user.
    dbQuery.mockClear();
    recordEvent.mockClear();
    await completeBooking('42', 'op-1');
    const byOperator = dbQuery.mock.calls.find((c) => /INSERT INTO booking_logs/.test(String(c[0])));
    expect(byOperator?.[1]).toEqual(['42', 'confirmed', 'completed', 'op-1', 'Тур завершён']);
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ actorKind: 'partner_user', actorUserId: 'op-1' }));
    vi.doUnmock('@/lib/database');
    vi.doUnmock('@/lib/crm/events');
  });
});

describe('роут /api/cron/booking-auto-complete', () => {
  const SECRET = 'test-cron-secret';
  const req = (auth = true) => new NextRequest('https://vedarai.ru/api/cron/booking-auto-complete', {
    headers: auth ? { authorization: `Bearer ${SECRET}` } : {},
  });

  it('без секрета — 401, в базу не ходит; отказ отбора — 502 с SQLSTATE; иначе — числа', async () => {
    process.env.CRON_SECRET = SECRET;
    const { GET } = await import('@/app/api/cron/booking-auto-complete/route');
    expect((await GET(req(false))).status).toBe(401);
    expect(poolQuery).not.toHaveBeenCalled();

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQuery.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const failed = await GET(req());
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ success: false, sqlstate: '42P01' });
    err.mockRestore();

    poolQuery.mockResolvedValueOnce({ rows: [] });
    const empty = await GET(req());
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ success: true, due: 0, completed: 0, failed: [] });
  });
});

describe('расписание и реестр', () => {
  it('крон зовётся шагом раньше просьбы об отзыве; отказ красит job, но просьбу не отменяет', () => {
    const wf = read('.github/workflows/cron-tour-review-request.yml');
    const auto = wf.indexOf('/api/cron/booking-auto-complete');
    const review = wf.indexOf('/api/cron/tour-review-request');
    expect(auto).toBeGreaterThan(0);
    expect(auto).toBeLessThan(review);
    expect(wf).toMatch(/id: autocomplete\s+continue-on-error: true/);
    expect(wf).toMatch(/if: steps\.autocomplete\.outcome == 'failure'/);
  });

  it('в реестре кронов — свой адрес в общем workflow; права — только база', () => {
    const entry = CRON_REGISTRY.find((e) => e.key === 'booking-auto-complete');
    expect(entry).toMatchObject({ endpoint: 'booking-auto-complete', workflow: 'cron-tour-review-request.yml', cron: '0 8 * * *' });
    expect(CRON_REGISTRY.find((e) => e.key === 'tour-review-request')?.endpoint).toBe('tour-review-request');
    expect(CRON_CAPABILITIES['booking-auto-complete']).toEqual(['db_read', 'db_write']);
  });
});
