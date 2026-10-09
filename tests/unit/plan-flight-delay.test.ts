/**
 * Сторож: срыв рейса — турист сообщает сам (#2231, решение владельца 08.10).
 *
 * «Рейс задержали на N дней» — правка готового плана (`flight_delay`), а не
 * новый подбор:
 *   - обратный билет прежний: выпадают N дней сразу после прилёта, поездка
 *     короче, многодневный тур, задетый окном, выпадает целиком;
 *   - обратный билет переносится: вся поездка сдвигается, дни те же;
 *   - переезд или отъезд в окне, задержка больше недели, остаток короче трёх
 *     дней — отказ словами, план прежний;
 *   - задетые туры возвращаются списком: брони план не меняет, и ответ
 *     говорит, кому из операторов написать.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import type { DayPlan } from '@/lib/planner/engine';
import { applyPlanEdit, type EditablePlan } from '@/lib/planner/plan-edit';
import { readPlanEdit, toursTouchedLines } from '@/lib/kuzmich/trip-plan-tool';

const day = (n: number, type: string, title: string, tourId?: string) =>
  ({ day: n, type, title, zone: 'avachinsky', ...(tourId ? { realTour: { tourId } } : {}) }) as unknown as DayPlan;

function plan(): EditablePlan {
  return {
    params: { interests: ['volcano'], arrivalDate: '2027-07-10', departureDate: '2027-07-17', adults: 2, children: [], budgetTier: 'comfort' },
    days: [
      day(1, 'arrival', 'Прилёт'),
      day(2, 'activity', 'Морская прогулка', 't-sea'),
      day(3, 'activity', 'Сплав (день 1 из 2)', 't-raft'),
      day(4, 'activity', 'Сплав (день 2 из 2)', 't-raft'),
      day(5, 'rest', 'Термальные источники'),
      day(6, 'activity', 'Авачинский'),
      day(7, 'buffer', 'Резерв на погоду'),
      day(8, 'departure', 'Отъезд'),
    ],
  };
}

describe('обратный билет прежний — поездка короче', () => {
  it('задержка на 1 день: выпадает день после прилёта, остальные сдвигаются на день раньше', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'flight_delay', days: 1, keepReturn: true });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.params.arrivalDate).toBe('2027-07-11');
    expect(r.plan.params.departureDate).toBe('2027-07-17');
    expect(r.plan.days.map((d) => `${d.day}:${d.title}`)).toEqual([
      '1:Прилёт', '2:Сплав (день 1 из 2)', '3:Сплав (день 2 из 2)', '4:Термальные источники', '5:Авачинский', '6:Резерв на погоду', '7:Отъезд',
    ]);
    expect(r.toursTouched).toEqual([{ tourId: 't-sea', title: 'Морская прогулка', how: 'dropped' }]);
  });

  it('задержка задевает один день многодневного тура — тур выпадает целиком, его хвост свободен', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'flight_delay', days: 2, keepReturn: true });
    if (!r.ok) throw new Error(r.reason);
    // Окно — дни 2 и 3; день 4 — хвост сплава, выпал вместе с ним, его место пусто.
    expect(r.plan.days.map((d) => `${d.day}:${d.title}`)).toEqual([
      '1:Прилёт', '3:Термальные источники', '4:Авачинский', '5:Резерв на погоду', '6:Отъезд',
    ]);
    expect(r.note).toContain('многодневный тур выпадает целиком');
    expect(r.toursTouched?.map((t) => `${t.tourId}:${t.title}`)).toEqual(['t-sea:Морская прогулка', 't-raft:Сплав']);
  });

  it('отъезд или переезд в окне — отказ, план прежний', async () => {
    const p = plan();
    p.days[1] = day(2, 'travel', 'Переезд на север');
    const r = await applyPlanEdit(p, { kind: 'flight_delay', days: 1, keepReturn: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('переезд между зонами');
  });

  it('от поездки остаётся меньше трёх дней — отказ с двумя выходами', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'flight_delay', days: 6, keepReturn: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/меньше 3 дней[\s\S]*сдвинуть всю поездку/);
  });
});

describe('обратный билет переносится — поездка сдвигается целиком', () => {
  it('даты сдвинуты, дни те же, туры — «попали на другие даты»', async () => {
    const before = plan();
    const r = await applyPlanEdit(before, { kind: 'flight_delay', days: 3, keepReturn: false });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.params.arrivalDate).toBe('2027-07-13');
    expect(r.plan.params.departureDate).toBe('2027-07-20');
    expect(r.plan.days).toEqual(before.days);
    expect(r.toursTouched?.every((t) => t.how === 'shifted')).toBe(true);
    expect(r.note).toContain('свободные места надо проверить');
  });
});

describe('границы и ответ', () => {
  it('задержка больше недели — пересборка, а не правка', async () => {
    const r = await applyPlanEdit(plan(), { kind: 'flight_delay', days: 8, keepReturn: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('make_trip_plan');
  });

  it('аргументы: delay_days обязателен, keep_return по умолчанию «да»', () => {
    expect(readPlanEdit({ action: 'flight_delay', delay_days: '2' })).toEqual({ ok: true, edit: { kind: 'flight_delay', days: 2, keepReturn: true } });
    expect(readPlanEdit({ action: 'рейс', delay_days: '1', keep_return: 'нет' })).toEqual({ ok: true, edit: { kind: 'flight_delay', days: 1, keepReturn: false } });
    expect(readPlanEdit({ action: 'flight_delay' }).ok).toBe(false);
    expect(readPlanEdit({ action: 'flight_delay', delay_days: '2', keep_return: 'может' }).ok).toBe(false);
  });

  it('ответ называет задетые туры и не обещает, что бронь поменялась', () => {
    const text = toursTouchedLines([{ tourId: 't-raft', title: 'Сплав', how: 'dropped' }]);
    expect(text).toContain('«Сплав» (IDt-raft) — выпал из плана');
    expect(text).toContain('бронь сама не меняется');
    expect(text).toContain('Не обещай, что оператор вернёт деньги');
    expect(toursTouchedLines([])).toBe('');
  });
});
