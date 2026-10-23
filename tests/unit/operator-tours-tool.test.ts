import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
const avail = vi.fn();
vi.mock('@/lib/planner', () => ({ createPlannerCache: () => new Map(), fetchAvailabilityForTour: (...a: unknown[]) => avail(...a) }));

import { runMyToursSchedule, parseDays, MY_TOURS_TOOL } from '@/lib/kuzmich/operator-tours-tool';

const NOW = Date.parse('2026-10-24T00:00:00Z');

describe('my_tours_schedule (24.10: «разве это мы планировали?»)', () => {
  beforeEach(() => { query.mockReset(); avail.mockReset(); });

  it('свои туры — без шлюза витрины: скрытый тур виден, оператор из параметра', async () => {
    query.mockResolvedValue({ rows: [{ id: 68, title: 'ТЕСТ рыбалка', is_active: true, is_published: false, max_participants: 10, season_start: '2026-10-24', season_end: '2027-12-31' }] });
    avail.mockResolvedValue([{ date: '2026-10-25', remaining: 8 }]);
    const out = await runMyToursSchedule('p1', {}, NOW);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/operator_id = \$1::uuid/);
    expect(sql).not.toMatch(/is_published\s*=\s*true/);
    expect(params[0]).toBe('p1');
    expect(out).toContain('скрыт с витрины');
    expect(out).toContain('2026-10-25: свободно 8');
  });

  it('нет дат — не «мест нет», а пояснение; отказ базы — «не удалось»', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, title: 'A', is_active: true, is_published: true, max_participants: null, season_start: null, season_end: null }] });
    avail.mockResolvedValue([]);
    expect(await runMyToursSchedule('p1', {}, NOW)).toContain('Открытых дат со свободными местами нет');
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    expect(await runMyToursSchedule('p1', {}, NOW)).toContain('НЕ УДАЛОСЬ');
  });

  it('days ограничен 1–120, определение называется my_tours_schedule', () => {
    expect(parseDays(undefined)).toBe(60);
    expect(parseDays('500')).toBe(120);
    expect(MY_TOURS_TOOL.function.name).toBe('my_tours_schedule');
  });
});
