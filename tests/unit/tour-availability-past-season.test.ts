/**
 * Тур без расписания, записанный сезон которого кончился (#3487, сверка
 * 24.11: туры ID4, 7, 10, 11). Заявка на дату по-прежнему возможна (решение
 * 08.10), но агенту не говорится «все даты свободны»: сезон кончился, а
 * следующего оператор не объявил.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) },
}));
vi.mock('@/lib/seat-requests/core', async (orig) => ({
  ...(await orig<typeof import('@/lib/seat-requests/core')>()),
  kamchatkaToday: () => '2026-11-25',
}));

import { getTourAvailabilityForKuzmich } from '@/lib/kuzmich/tour-availability-tool';
import { pastSeasonAgentWords } from '@/lib/tours/request-window';

const BASE = {
  id: 7, title: 'Летняя рыбалка', operator_id: 'op', slug: null,
  base_price: 25000, price_unit: 'person', multi_day_count: null, duration_hours: 8, duration_type: 'hours',
};

function mockDb(tour: Record<string, unknown>) {
  query.mockImplementation(async (sql: string) => {
    if (/FROM operator_tours/.test(sql) && /(WHERE|AND) (ot\.)?id = \$1/.test(sql)) return { rows: [tour] };
    if (/SELECT EXISTS/.test(sql)) return { rows: [{ has: false }] };
    return { rows: [] };
  });
}

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { spy.mockRestore(); query.mockReset(); });

describe('get_tour_availability: сезон кончился, следующего нет', () => {
  it('не «все даты свободны», а сезон кончился и дата не подтверждена', async () => {
    mockDb({ ...BASE, season_start: '2026-06-01', season_end: '2026-10-30' });
    const text = await getTourAvailabilityForKuzmich({ tour: '7', date_from: '2026-11-25', days: '7' });
    expect(text).not.toMatch(/все даты свободны/);
    expect(text).toMatch(/записанный сезон тура закончился 30 октября 2026, сезон следующего года оператор не объявил/);
    expect(text).toMatch(/Это не свободные даты сезона/);
    expect(text).toMatch(/: можно отправить заявку оператору, /);
    expect(text).not.toMatch(/свободно для заявки/);
    expect(text).toMatch(/Не обещай, что место закреплено/);
  });

  it('сезон идёт — прежний ответ по сезону, без строки о прошедшем', async () => {
    mockDb({ ...BASE, season_start: '2026-11-01', season_end: '2027-03-31' });
    const text = await getTourAvailabilityForKuzmich({ tour: '7', date_from: '2026-11-25', days: '7' });
    expect(text).not.toMatch(/закончился/);
    expect(text).toMatch(/свободно для заявки/);
  });
});

describe('pastSeasonAgentWords', () => {
  const t = { duration_type: 'hours', multi_day_count: null, duration_hours: 8 };
  it('прошедший сезон — строка; идущий или не записанный — null', () => {
    expect(pastSeasonAgentWords({ ...t, season_start: '2026-06-01', season_end: '2026-10-30' }, '2026-11-25'))
      .toBe('записанный сезон тура закончился 30 октября 2026, сезон следующего года оператор не объявил');
    expect(pastSeasonAgentWords({ ...t, season_start: '2026-11-01', season_end: '2027-03-31' }, '2026-11-25')).toBeNull();
    expect(pastSeasonAgentWords({ ...t, season_start: null, season_end: null }, '2026-11-25')).toBeNull();
  });
});
