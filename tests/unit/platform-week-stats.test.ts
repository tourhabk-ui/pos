/**
 * Платформа за 7 дней для Scout-Innovator (#2767) — вызовом.
 *
 * «Виден на витрине» — одно правило с витриной (publicTourSql), оператор —
 * только category='operator'; отказ базы — «не прочиталась», а не нули.
 *
 * 30.10 (#2881, #2882): невидимые туры разложены по причинам шлюза (черновик /
 * выключен / и то и другое — в сумме ровно tours_hidden), воронка брони —
 * касания, заявки, отказы и самая частая причина словами; свои заходы в
 * воронке не считаются.
 */
import { describe, it, expect, vi } from 'vitest';
import { publicTourSql, hiddenTourReasonSql } from '@/lib/tours/public-visibility';
import {
  PLATFORM_WEEK_SQL, loadPlatformWeekStats, platformWeekLine, platformWeekPromptLines,
  hiddenBreakdownWords, funnelWords, rejectReasonWords, type PlatformWeekStats,
} from '@/lib/agents/platform-week-stats';

const STATS: PlatformWeekStats = {
  bookings_week: 0, confirmed_week: 0, operators_new: 5, operators_new_with_visible_tour: 0,
  operators_with_visible_tour: 9, tours_visible: 42, tours_hidden: 17,
  hidden_draft: 11, hidden_inactive: 5, hidden_both: 1,
  funnel_booking_start: 6, funnel_booking_submitted: 2, funnel_booking_rejected: 3,
  funnel_top_reject_reason: 'NO_SLOTS', funnel_top_reject_count: 2,
};

describe('запрос', () => {
  it('витрина — publicTourSql, операторы — category operator, старых таблиц нет', () => {
    expect(PLATFORM_WEEK_SQL).toContain(publicTourSql('ot'));
    expect(PLATFORM_WEEK_SQL).toMatch(/p\.category = 'operator'/);
    expect(PLATFORM_WEEK_SQL).not.toMatch(/FROM bookings\b|FROM tours\b/);
    expect(PLATFORM_WEEK_SQL).toMatch(/FROM operator_bookings WHERE deleted_at IS NULL/);
  });

  it('невидимые — по трём вёдрам шлюза, третье определено как остаток (сумма = tours_hidden по построению)', () => {
    const hidden = `ot.deleted_at IS NULL AND NOT ${publicTourSql('ot')}`;
    const { draft, inactive } = hiddenTourReasonSql('ot');
    expect(draft).toBe('(ot.is_active IS TRUE AND ot.is_published IS FALSE)');
    expect(inactive).toBe('(ot.is_active IS FALSE AND ot.is_published IS TRUE)');
    expect(() => hiddenTourReasonSql('ot; DROP')).toThrow(/алиас/);
    expect(PLATFORM_WEEK_SQL).toContain(`WHERE ${hidden})::int AS tours_hidden`);
    expect(PLATFORM_WEEK_SQL).toContain(`WHERE ${hidden} AND ${draft})::int AS hidden_draft`);
    expect(PLATFORM_WEEK_SQL).toContain(`WHERE ${hidden} AND ${inactive})::int AS hidden_inactive`);
    expect(PLATFORM_WEEK_SQL).toContain(`WHERE ${hidden} AND NOT ${draft} AND NOT ${inactive})::int AS hidden_both`);
    // Цена, даты и линия маршрута причиной невидимости не называются: шлюз их не знает.
    expect(PLATFORM_WEEK_SQL).not.toMatch(/base_price|geometry|tour_availability/);
  });

  it('воронка — funnel_events без своих заходов, за 7 дней, шаги словаря', () => {
    expect(PLATFORM_WEEK_SQL).toMatch(/FROM funnel_events WHERE is_self = FALSE AND created_at > NOW\(\) - '7 days'::interval AND step = 'booking_start'/);
    expect(PLATFORM_WEEK_SQL).toMatch(/step = 'booking_submitted'/);
    expect(PLATFORM_WEEK_SQL).toMatch(/step = 'booking_rejected'\)::int AS funnel_booking_rejected/);
    expect(PLATFORM_WEEK_SQL).toMatch(/step = 'booking_rejected' AND reason IS NOT NULL\s+GROUP BY reason ORDER BY n DESC, reason LIMIT 1/);
  });
});

describe('слова', () => {
  it('разбивка невидимых и воронка — с цифрами и причиной словами', () => {
    expect(hiddenBreakdownWords(STATS)).toBe('не видны туристу 17: черновики 11, выключены оператором 5, и то и другое 1');
    expect(funnelWords(STATS)).toBe('касаний формы 6, заявок отправлено 2, отказов 3 (чаще всего: мест на дату нет ×2)');
  });

  it('нет невидимых — без разбивки; нет отказов — без «чаще всего»; незнакомый код — как есть', () => {
    const quiet: PlatformWeekStats = {
      ...STATS, tours_hidden: 0, hidden_draft: 0, hidden_inactive: 0, hidden_both: 0,
      funnel_booking_rejected: 0, funnel_top_reject_reason: null, funnel_top_reject_count: 0,
    };
    expect(hiddenBreakdownWords(quiet)).toBe('не видны туристу 0');
    expect(funnelWords(quiet)).toBe('касаний формы 6, заявок отправлено 2, отказов 0');
    expect(rejectReasonWords('NEW_CODE')).toBe('NEW_CODE');
    expect(rejectReasonWords(null)).toBeNull();
  });
});

describe('три исхода', () => {
  it('прочитано — цифры в промпте и в дайджесте, новые операторы с витриной отдельно', async () => {
    const db = { query: vi.fn(async () => ({ rows: [STATS] })) };
    const read = await loadPlatformWeekStats(db as never);
    expect(read).toEqual({ kind: 'ok', stats: STATS });
    expect((db.query.mock.calls[0] as unknown[])[0]).toBe(PLATFORM_WEEK_SQL);
    const lines = platformWeekPromptLines(read);
    expect(lines).toContain('- Новых операторов: 5, из них с туром на витрине: 0');
    expect(lines).toContain('- Бронирований за 7 дней: 0, из них подтверждено 0');
    expect(lines.join('\n')).toContain('туров на витрине 42, не видны туристу 17: черновики 11, выключены оператором 5, и то и другое 1');
    expect(lines).toContain('- Воронка брони за 7 дней: касаний формы 6, заявок отправлено 2, отказов 3 (чаще всего: мест на дату нет ×2)');
    expect(platformWeekLine(read)).toBe(
      '<b>Платформа за 7 дней:</b> 0 бронирований, 0 подтверждено, 5 новых операторов (с туром на витрине: 0), '
      + 'туров на витрине 42, не видны туристу 17: черновики 11, выключены оператором 5, и то и другое 1; '
      + 'воронка: касаний формы 6, заявок отправлено 2, отказов 3 (чаще всего: мест на дату нет ×2)',
    );
  });

  it('база не ответила — «не прочиталась» с причиной, цифр нет', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = { query: vi.fn(async () => { throw Object.assign(new Error('timeout exceeded'), { code: '57P01' }); }) };
    const read = await loadPlatformWeekStats(db as never);
    expect(read).toEqual({ kind: 'failed', reason: 'sqlstate=57P01 timeout exceeded' });
    const lines = platformWeekPromptLines(read);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/не прочиталась/);
    expect(lines[0]).not.toMatch(/Бронирований[^\n]*\d/);
    expect(platformWeekLine(read)).toBe('<b>Платформа за 7 дней:</b> статистика не прочиталась');
    expect(console.error).toHaveBeenCalledWith('[platform-week-stats] статистика платформы не прочитана:', 'sqlstate=57P01 timeout exceeded');
    vi.restoreAllMocks();
  });

  it('пустой ответ — тоже отказ, не нули', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect((await loadPlatformWeekStats(db as never)).kind).toBe('failed');
  });
});
