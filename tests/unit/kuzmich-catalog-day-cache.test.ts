/**
 * Кэш каталога Кузьмича и MCP (loadTourCatalog) живёт 3 минуты, но жребий
 * правила 1в меняется в полночь по Камчатке (12:00 UTC). Кэш вчерашнего дня
 * отдаваться не должен: иначе get_tours до трёх минут после полуночи несёт
 * вчерашний порядок, а сайт — уже новый (риск (1) спецификации; ревью 29.10:
 * снятие проверки дня в ключе кэша не ловил ни один тест).
 *
 * Держит вызовом с подменённой базой и часами: в пределах суток повтор идёт
 * из кэша, через полночь Камчатки — снова в базу, и порядок — правилом нового дня.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/planner', () => ({}));

import { pool } from '@/lib/db-pool';
import { orderOffersBy } from '@/lib/tours/offer-order';

const q = pool.query as unknown as ReturnType<typeof vi.fn>;

const rows = Array.from({ length: 12 }, (_, i) => ({
  id: 300 + i, title: `Тур ${300 + i}`, base_price: 10000, price_unit: 'per_person', multi_day_count: null,
  activity_type: 'trekking', location_name: null, duration_type: null, duration_hours: null,
  season_start: null, season_end: null, available_slots: null, next_available_date: null,
  short_description: null, has_schedule: true, has_details: false, operator_name: `Компания ${i}`,
}));

const idsOf = (catalog: string | null) => [...(catalog ?? '').matchAll(/^ID(\d+):/gm)].map((m) => Number(m[1]));
const rule = (day: string) => orderOffersBy(rows, (r) => ({ id: r.id, nearestFreeDate: null }), { day }).map((r) => r.id);

afterEach(() => { vi.useRealTimers(); q.mockReset(); });

describe('кэш каталога — по дню жребия', () => {
  it('в пределах суток — из кэша; через полночь Камчатки, раньше трёх минут, — снова из базы по правилу нового дня', async () => {
    q.mockResolvedValue({ rows });
    vi.resetModules();
    const { loadTourCatalog } = await import('@/lib/kuzmich/core');
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2026-10-29T11:59:00Z')); // 29.10 23:59 на Камчатке
    const before = await loadTourCatalog();
    expect(idsOf(before)).toEqual(rule('2026-10-29'));
    expect(q).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-29T11:59:40Z'));
    await loadTourCatalog();
    expect(q).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-29T12:01:00Z')); // уже 30.10 на Камчатке, кэшу 2 минуты
    const after = await loadTourCatalog();
    expect(q).toHaveBeenCalledTimes(2);
    expect(idsOf(after)).toEqual(rule('2026-10-30'));
    expect(idsOf(after)).not.toEqual(idsOf(before));
  });
});
