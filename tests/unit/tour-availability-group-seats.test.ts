/**
 * get_tour_availability с people: группа больше свободных мест (30.10).
 *
 * До этого строка даты звучала «свободно 2, …; итого за 4 чел.: 72 000 ₽» —
 * агент пересказывал сумму как готовую к заявке, а гейт create_booking_request
 * такую заявку отклоняет. Теперь на такой дате итог не называется, сказано
 * «мест не хватит», и названа ближайшая дата, где мест хватит на всех, — в
 * окне или после него тем же движком (fetchAvailabilityForTour).
 *
 * Судит вызов инструмента на подложенных базе, движке занятости и расчёте цены.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
const availability = vi.fn();
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: (...a: unknown[]) => availability(...a),
}));
const honest = vi.fn();
vi.mock('@/lib/tours/honest-price', () => ({ honestTourPrice: (...a: unknown[]) => honest(...a) }));

import { pool } from '@/lib/db-pool';
import { getTourAvailabilityForKuzmich } from '@/lib/kuzmich/tour-availability-tool';
import { parseAvailabilityText } from '@/lib/quality/channel-parity';

const q = pool.query as unknown as ReturnType<typeof vi.fn>;
const TOUR = { id: 37, title: 'Зимняя рыбалка', operator_id: 'op', base_price: 18000, price_unit: 'per_day_per_person', slug: 'zimnyaya', multi_day_count: null, duration_hours: null };

const slotLine = (out: string, iso: string) => out.split('\n').find((l) => l.includes(`(${iso})`)) ?? '';

describe('get_tour_availability: группа больше свободных мест', () => {
  beforeEach(() => {
    q.mockReset(); availability.mockReset(); honest.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('на дате «свободно 2» при 4 чел. итога нет, сказано «не хватит»; ближайшая дата в окне названа', async () => {
    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 2 }, { date: '2027-01-16', remaining: 6 }]);
    honest.mockResolvedValue({ total: 72000 });
    const out = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '2', people: '4' });

    const short = slotLine(out, '2027-01-15');
    expect(short).toContain('свободно 2');
    expect(short).toContain('на 4 чел. мест не хватит');
    expect(short).not.toContain('итого');
    // Расчёт цены на короткую дату не зовётся вовсе — только на подходящую.
    expect(honest).toHaveBeenCalledTimes(1);
    expect(honest).toHaveBeenCalledWith(expect.objectContaining({ tourDate: '2027-01-16', participants: 4 }));
    expect(slotLine(out, '2027-01-16')).toContain('итого за 4 чел.: 72');

    expect(out).toMatch(/мест на 4 чел\. не хватит: не называй там итог/);
    expect(out).toMatch(/Ближайшая дата, где хватит мест на 4 чел\., — 16\.01\.2027, свободно 6\./);
    // Окно не ищется второй раз: подходящая дата уже в нём.
    expect(availability).toHaveBeenCalledTimes(1);
    // Сверка каналов читает обе даты как даты окна — строка слота прежнего вида.
    expect(parseAvailabilityText(out)?.dates.map((d) => [d.date, d.free])).toEqual([['2027-01-15', 2], ['2027-01-16', 6]]);
  });

  it('в окне мест на группу нет нигде — ближайшая дата после окна тем же движком', async () => {
    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability
      .mockResolvedValueOnce([{ date: '2027-01-15', remaining: 2 }, { date: '2027-01-16', remaining: 3 }])
      .mockResolvedValueOnce([{ date: '2027-01-20', remaining: 3 }, { date: '2027-02-02', remaining: 8 }]);
    const out = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '2', people: '4' });

    expect(honest).not.toHaveBeenCalled();
    expect(out).not.toContain('итого');
    expect(slotLine(out, '2027-01-15')).toContain('на 4 чел. мест не хватит');
    expect(slotLine(out, '2027-01-16')).toContain('на 4 чел. мест не хватит');
    // Поиск после окна — со следующего дня до горизонта в год.
    expect(availability).toHaveBeenNthCalledWith(2, '37', '2027-01-17', '2027-10-30', expect.anything());
    expect(out).toMatch(/В этом окне такой даты нет; ближайшая дата после окна, где хватит мест на 4 чел\., — 02\.02\.2027, свободно 8; её покажет get_tour_availability с date_from=2027-02-02\./);
    // Дата после окна — не строкой слота: сверка каналов не примет её за дату окна.
    expect(parseAvailabilityText(out)?.dates.map((d) => d.date)).toEqual(['2027-01-15', '2027-01-16']);
  });

  it('после окна тоже нет — так и сказано; не смог проверить — не «нет»', async () => {
    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 2 }]).mockResolvedValueOnce([]);
    const none = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '1', people: '4' });
    expect(none).toMatch(/даты, где хватит мест на 4 чел\., нет — предложи разделить группу или другой тур/);

    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 2 }]).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57014' }));
    const failed = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '1', people: '4' });
    expect(failed).toMatch(/проверить не смог — не говори, что её нет/);
    expect(failed).toContain('на 4 чел. мест не хватит');
  });

  it('группа помещается везде — ответ прежний, без строки о нехватке и без лишнего поиска', async () => {
    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 4 }]);
    honest.mockResolvedValueOnce({ total: 72000 });
    const out = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '1', people: '4' });
    expect(out).toContain('итого за 4 чел.: 72');
    expect(out).not.toMatch(/не хватит/);
    expect(availability).toHaveBeenCalledTimes(1);
  });

  it('без people «не хватит» не говорится: группа неизвестна', async () => {
    q.mockResolvedValueOnce({ rows: [TOUR] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 1 }]);
    const out = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '1' });
    expect(out).toContain('свободно 1');
    expect(out).not.toMatch(/не хватит/);
  });

  it('у тура без цены нехватка мест всё равно названа', async () => {
    q.mockResolvedValueOnce({ rows: [{ ...TOUR, base_price: null }] });
    availability.mockResolvedValueOnce([{ date: '2027-01-15', remaining: 2 }, { date: '2027-01-16', remaining: 5 }]);
    const out = await getTourAvailabilityForKuzmich({ tour: '37', date_from: '2027-01-15', days: '2', people: '4' });
    expect(slotLine(out, '2027-01-15')).toContain('на 4 чел. мест не хватит');
    expect(slotLine(out, '2027-01-16')).not.toMatch(/не хватит|итого/);
    expect(honest).not.toHaveBeenCalled();
  });
});
