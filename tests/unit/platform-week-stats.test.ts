/**
 * Платформа за 7 дней для Scout-Innovator (#2767) — вызовом.
 *
 * «Виден на витрине» — одно правило с витриной (publicTourSql), оператор —
 * только category='operator'; отказ базы — «не прочиталась», а не нули.
 */
import { describe, it, expect, vi } from 'vitest';
import { publicTourSql } from '@/lib/tours/public-visibility';
import {
  PLATFORM_WEEK_SQL, loadPlatformWeekStats, platformWeekLine, platformWeekPromptLines, type PlatformWeekStats,
} from '@/lib/agents/platform-week-stats';

const STATS: PlatformWeekStats = {
  bookings_week: 0, confirmed_week: 0, operators_new: 5, operators_new_with_visible_tour: 0,
  operators_with_visible_tour: 9, tours_visible: 42, tours_hidden: 17,
};

describe('запрос', () => {
  it('витрина — publicTourSql, операторы — category operator, старых таблиц нет', () => {
    expect(PLATFORM_WEEK_SQL).toContain(publicTourSql('ot'));
    expect(PLATFORM_WEEK_SQL).toMatch(/p\.category = 'operator'/);
    expect(PLATFORM_WEEK_SQL).not.toMatch(/FROM bookings\b|FROM tours\b/);
    expect(PLATFORM_WEEK_SQL).toMatch(/FROM operator_bookings WHERE deleted_at IS NULL/);
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
    expect(lines.join('\n')).toContain('туров на витрине 42, не видны туристу 17');
    expect(platformWeekLine(read)).toBe(
      '<b>Платформа за 7 дней:</b> 0 бронирований, 0 подтверждено, 5 новых операторов (с туром на витрине: 0), туров на витрине 42, не видны 17',
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
    expect(lines[0]).not.toMatch(/Бронирований: \d/);
    expect(platformWeekLine(read)).toBe('<b>Платформа за 7 дней:</b> статистика не прочиталась');
    expect(console.error).toHaveBeenCalledWith('[platform-week-stats] статистика платформы не прочитана:', 'sqlstate=57P01 timeout exceeded');
    vi.restoreAllMocks();
  });

  it('пустой ответ — тоже отказ, не нули', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect((await loadPlatformWeekStats(db as never)).kind).toBe('failed');
  });
});
