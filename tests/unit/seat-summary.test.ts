/** «/сводка» для оператора в MAX (пилот «Камчатская рыбалка», 23.10). */
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
import { pool } from '@/lib/db-pool';
import {
  formatDuration, isSummaryCommand, readSeatSummary, summaryEnabledFor, summaryText,
} from '@/lib/seat-requests/summary';

const FISHING = '0aaa4f05-b479-418b-9d54-2b909783dfd7';

describe('команда и флаг', () => {
  it('узнаёт команду целиком', () => {
    for (const t of ['/сводка', 'Сводка', ' сводка ', '/svodka', '/summary', 'сводка.']) expect(isSummaryCommand(t)).toBe(true);
    for (const t of ['сводка за неделю', 'покажи сводку погоды', '', '/start']) expect(isSummaryCommand(t)).toBe(false);
  });
  it('включено только пилоту', () => {
    expect(summaryEnabledFor(FISHING)).toBe(true);
    expect(summaryEnabledFor('11111111-1111-1111-1111-111111111111')).toBe(false);
  });
});

describe('текст', () => {
  it('длительности', () => {
    expect(formatDuration(5)).toBe('5 мин');
    expect(formatDuration(100)).toBe('1 ч 40 мин');
    expect(formatDuration(120)).toBe('2 ч');
    expect(formatDuration(60 * 50)).toBe('2 дн');
  });
  it('полная сводка без ПД', () => {
    const t = summaryText({
      pending: 2, oldestPendingMin: 180, todayIn: 3, todayAnswered: 1, avgResponseMin7d: 100, answered7d: 4,
      nearest: { title: 'Тур <A>', tourDate: '2027-06-14', participants: 2, deadlineAt: new Date('2026-10-23T09:00:00Z') },
    });
    expect(t).toContain('Ждут ответа: <b>2</b> (самый старый — 3 ч)');
    expect(t).toContain('Сегодня пришло: 3 · отвечено: 1');
    expect(t).toContain('1 ч 40 мин (ответов: 4)');
    expect(t).toContain('до 23.10, 21:00 — «Тур &lt;A&gt;», 14.06.2027, 2 чел.');
    expect(t).not.toMatch(/\+?\d{10,}/);
  });
  it('пусто', () => {
    const t = summaryText({ pending: 0, oldestPendingMin: null, todayIn: 0, todayAnswered: 0, avgResponseMin7d: null, answered7d: 0, nearest: null });
    expect(t).toContain('Ждут ответа: 0');
    expect(t).toContain('ответов не было');
    expect(t).not.toContain('Ближайший');
  });
});

describe('чтение', () => {
  it('не выбирает ПД туриста и фильтрует по партнёру', async () => {
    const q = vi.mocked(pool.query);
    q.mockResolvedValueOnce({ rows: [{ pending: '1', oldest_min: '30', today_in: '1', today_answered: '0', avg_min: null, answered_7d: '0' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const s = await readSeatSummary(FISHING);
    expect(s).toMatchObject({ pending: 1, oldestPendingMin: 30, avgResponseMin7d: null, nearest: null });
    for (const call of q.mock.calls) {
      expect(String(call[0])).not.toMatch(/tourist_(name|phone)/);
      expect(call[1]).toEqual([FISHING]);
    }
  });
  it('сбой базы', async () => {
    vi.mocked(pool.query).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    expect(await readSeatSummary(FISHING)).toBe('db_error');
  });
});
