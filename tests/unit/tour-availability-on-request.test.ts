/**
 * Тур без расписания: все даты свободны для заявки (решение владельца 08.10:
 * «сделай все даты свободными, можно только отправить заявку оператору»).
 *
 * До этого get_tour_availability отвечал по всем одиннадцати турам «Края
 * Вулканов» «расписания нет — места уточняются у оператора», и внешний агент
 * пересказывал человеку: «свободные даты узнать нельзя».
 *
 * 17.11 (#3487, тур ID67): у тура без сезона и без расписания дни окна — не
 * «свободные даты сезона». В какие месяцы тур выезжает, в данных нет, и ноябрь
 * у летнего тура звучал свободным. Заявку на эти дни отправить можно (решение
 * 08.10 в силе), но ответ говорит, что сезон не записан и дату подтверждает
 * оператор.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) },
}));

import { getTourAvailabilityForKuzmich, collapseRuns, datesBetween } from '@/lib/kuzmich/tour-availability-tool';

const TOUR = {
  id: 46, title: 'Восхождение на вулкан Ключевская Сопка', operator_id: 'op', slug: null,
  base_price: 320000, price_unit: 'person', multi_day_count: 12, duration_hours: null,
};

function mockDb(opts: { tiers?: Array<Record<string, unknown>> } = {}) {
  query.mockImplementation(async (sql: string) => {
    if (/FROM operator_tours/.test(sql) && /(WHERE|AND) (ot\.)?id = \$1/.test(sql)) return { rows: [TOUR] };
    if (/SELECT EXISTS/.test(sql)) return { rows: [{ has: false }] };
    if (/tour_price_tiers/.test(sql)) return { rows: opts.tiers ?? [] };
    return { rows: [] };
  });
}

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { spy.mockRestore(); query.mockReset(); });

describe('get_tour_availability: тур без расписания и без сезона — заявка на любой день, сезон не записан', () => {
  it('окно целиком свободно, итог на группу, числа мест нет', async () => {
    mockDb();
    const text = await getTourAvailabilityForKuzmich({ tour: '46', date_from: '2027-07-10', days: '14', people: '2' });
    expect(text).toMatch(/сезон не записан — дату подтверждает оператор/);
    expect(text).toMatch(/Это не свободные даты сезона/);
    expect(text).not.toMatch(/все даты свободны/);
    expect(text).toMatch(/- 10\.07–23\.07(\.2027)?: можно отправить заявку оператору, итого за 2 чел\.: 640[\s  ]000 ₽/);
    // Число мест у тура без календаря — выдумка: его нет ни в одной строке.
    expect(text).not.toMatch(/свободно \d/);
    expect(text).toMatch(/create_booking_request/);
    expect(text).toMatch(/Не обещай, что место закреплено/);
    expect(text).not.toMatch(/узнать нельзя|реальная занятость мест/);
  });

  it('без числа людей — цена тура и подсказка про people', async () => {
    mockDb();
    const text = await getTourAvailabilityForKuzmich({ tour: '46', date_from: '2027-07-10', days: '3' });
    expect(text).toMatch(/- 10\.07–12\.07(\.2027)?: можно отправить заявку оператору, /);
    expect(text).toMatch(/с параметром people/);
  });

  it('нераспознанное число людей названо, а не потеряно', async () => {
    mockDb();
    const text = await getTourAvailabilityForKuzmich({ tour: '46', date_from: '2027-07-10', days: '3', people: 'много' });
    expect(text).toMatch(/Число людей «много» не распознано/);
  });

  it('один день — одна дата, без диапазона', async () => {
    mockDb();
    const text = await getTourAvailabilityForKuzmich({ tour: '46', date_from: '2027-07-10', days: '1', people: '2' });
    expect(text).toMatch(/- 10\.07(\.2027)?: можно отправить заявку оператору/);
  });
});

describe('collapseRuns / datesBetween', () => {
  it('даты окна — оба края включительно', () => {
    expect(datesBetween('2027-07-30', '2027-08-02')).toEqual(['2027-07-30', '2027-07-31', '2027-08-01', '2027-08-02']);
  });

  it('одинаковые подписи подряд — один диапазон; смена подписи или разрыв — новый', () => {
    expect(collapseRuns([
      { date: '2027-07-10', label: 'a' }, { date: '2027-07-11', label: 'a' },
      { date: '2027-07-12', label: 'b' }, { date: '2027-07-14', label: 'b' },
    ])).toEqual([
      { from: '2027-07-10', to: '2027-07-11', label: 'a' },
      { from: '2027-07-12', to: '2027-07-12', label: 'b' },
      { from: '2027-07-14', to: '2027-07-14', label: 'b' },
    ]);
  });
});
