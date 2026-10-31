/**
 * Серверная запись события воронки (#2882) — вызовом.
 *
 *  - с заголовками запроса: тот же суточный хэш, что у маяка и page_views,
 *    is_self из куки, причина только у отказа, у каждого параметра приведение;
 *  - без заголовков (чат, агент): хэш NULL, не свой;
 *  - краулер — не пишется и назван (skipped_bot);
 *  - отказ базы — not_written и лог с именем шага и SQLSTATE, не бросает.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordFunnelEvent, visitorFromHeaders, RECORD_FUNNEL_SQL } from '@/lib/funnel/record';
import { visitorHash, currentDay } from '@/lib/analytics/visitor-hash';
import { SELF_VISIT_COOKIE } from '@/lib/analytics/self-visit';

const db = { query: vi.fn() };
beforeEach(() => { db.query.mockReset(); db.query.mockResolvedValue({ rows: [], rowCount: 1 }); });

describe('recordFunnelEvent', () => {
  it('отказ с заголовками: хэш как у маяка, is_self из куки, причина, приведения у всех параметров', async () => {
    const visitor = { ip: '10.0.0.7', userAgent: 'Mozilla/5.0 (iPhone)', cookie: `${SELF_VISIT_COOKIE}=1` };
    const out = await recordFunnelEvent({ step: 'booking_rejected', entityId: '79', source: 'website', reason: 'NO_SLOTS', visitor }, db);
    expect(out).toBe('ok');
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe(RECORD_FUNNEL_SQL);
    expect(sql).toMatch(/\$1::varchar, \$2::text, \$3::varchar, \$4::boolean, \$5::varchar, \$6::varchar/);
    expect(sql).not.toMatch(/WHERE NOT EXISTS/);
    const expectedHash = visitorHash(visitor.ip, visitor.userAgent, currentDay(), process.env.CRON_SECRET ?? 'vedar');
    expect(params).toEqual(['booking_rejected', '79', expectedHash, true, 'NO_SLOTS', 'website']);
  });

  it('заявка без заголовков (чат): хэш NULL, не свой, причины нет', async () => {
    const out = await recordFunnelEvent({ step: 'booking_submitted', entityId: '79', source: 'kuzmich' }, db);
    expect(out).toBe('ok');
    const [, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['booking_submitted', '79', null, false, null, 'kuzmich']);
  });

  it('краулер не пишется и назван', async () => {
    const visitor = { ip: '10.0.0.8', userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)', cookie: null };
    const out = await recordFunnelEvent({ step: 'booking_submitted', entityId: '1', source: 'website', visitor }, db);
    expect(out).toBe('skipped_bot');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('отказ базы — not_written, лог с шагом и SQLSTATE, не бросает', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockRejectedValue(Object.assign(new Error('relation "funnel_events" does not exist'), { code: '42P01' }));
    const out = await recordFunnelEvent({ step: 'booking_rejected', entityId: null, source: 'agent', reason: 'DATE_BLOCKED' }, db);
    expect(out).toBe('not_written');
    expect(error).toHaveBeenCalledWith(
      '[funnel] серверное событие «booking_rejected» не записано:',
      'relation "funnel_events" does not exist',
      'SQLSTATE=42P01',
    );
    error.mockRestore();
  });

  it('visitorFromHeaders берёт UA и куку из заголовков', () => {
    const h = new Headers({ 'user-agent': 'UA', cookie: 'a=b' });
    expect(visitorFromHeaders(h, '1.2.3.4')).toEqual({ ip: '1.2.3.4', userAgent: 'UA', cookie: 'a=b' });
    expect(visitorFromHeaders(new Headers(), '1.2.3.4')).toEqual({ ip: '1.2.3.4', userAgent: '', cookie: null });
  });
});
