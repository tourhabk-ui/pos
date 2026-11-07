/**
 * edit_trip_plan снаружи: «нас трое», «сдвинь поездку», «замени вулкан»
 * (аудит планировщика 07.11, M3 и M4).
 *
 * Сторож держит три слоя вызовом:
 *  - разбор аргументов (`readPlanEdit`): состав и даты — теми же правилами,
 *    что у make_trip_plan; чего нет — ошибка словами, без догадки;
 *  - ответ инструмента: правка сдвинула тур — ответ говорит, что места и цена
 *    перечитаны, а у какого тура прочитать не удалось — называет его;
 *  - схемы: Кузьмич и MCP принимают новые поля, и агент их видит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DayPlan } from '@/lib/planner/engine';

let availabilityFails = false;
const queries: string[] = [];
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM trip_plan_drafts')) return { rows: [{ id: ID, params: PARAMS, days: DAYS, revision: 1 }] };
      if (sql.startsWith('UPDATE')) return { rows: [{ revision: 2 }] };
      if (sql.includes('FROM tour_availability ta') && sql.includes('CROSS JOIN LATERAL')) {
        if (availabilityFails) throw Object.assign(new Error('down'), { code: '57P01' });
        return { rows: [] };
      }
      if (sql.includes('AS on_sale')) {
        return { rows: [{ base_price: '9000', price_unit: 'per_person', multi_day_count: null, duration_hours: '8', on_sale: true }] };
      }
      return { rows: [] };
    }),
  },
}));

import { editTripPlanForKuzmich, readPlanEdit, rereadLine, toursTouchedLines } from '@/lib/kuzmich/trip-plan-tool';
import { validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';

const ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const day = (n: number, type: DayPlan['type'], title: string, extra: Partial<DayPlan> = {}): DayPlan => ({
  day: n, type, zone: 'avachinsky', title, description: '', activityType: type === 'activity' ? 'volcano' : 'hot_spring',
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
});
const DAYS: DayPlan[] = [
  day(1, 'arrival', 'Прилёт'),
  day(2, 'activity', 'Мутновский вулкан', {
    realTour: {
      tourId: '70', operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 0, tourRating: null, reviewCount: 0,
      verified: true, maxParticipants: 8, weatherDependent: false, durationHours: 8, priceUnit: 'per_person', lodgingIncluded: null,
    },
    availability: 'open', availableDate: '2027-07-11', slotsRemaining: 6, realPrice: 9000, priceFrom: 9000, priceTo: 10800,
  }),
  day(3, 'rest', 'Отдых'),
  day(4, 'departure', 'Отъезд'),
];
const PARAMS = {
  interests: ['volcano'], arrivalDate: '2027-07-10', departureDate: '2027-07-13',
  adults: 2, children: [], budgetTier: 'comfort',
};
const NOW = Date.parse('2026-11-07T03:00:00Z');

beforeEach(() => {
  availabilityFails = false;
  queries.length = 0;
});

describe('разбор: состав группы', () => {
  it('взрослые и дети — правилами make_trip_plan; не названное — прежнее', () => {
    expect(readPlanEdit({ action: 'set_party', adults: '3' })).toEqual({ ok: true, edit: { kind: 'set_party', adults: 3 } });
    expect(readPlanEdit({ action: 'состав', children: '6, 10' })).toEqual({ ok: true, edit: { kind: 'set_party', children: [6, 10] } });
    expect(readPlanEdit({ action: 'set_party', children: 'нет' })).toEqual({ ok: true, edit: { kind: 'set_party', children: [] } });
    expect(readPlanEdit({ action: 'set_party', adults: '2', children: '[0]' }, { surface: 'mcp' })).toEqual({ ok: true, edit: { kind: 'set_party', adults: 2, children: [0] } });
  });

  it('нечего менять, «трое» словом, голое число детей — ошибка словами, без «план не собран»', () => {
    expect(readPlanEdit({ action: 'set_party' })).toMatchObject({ ok: false, error: expect.stringMatching(/нужен состав/) });
    expect(readPlanEdit({ action: 'set_party', adults: 'трое' })).toMatchObject({ ok: false, error: expect.stringMatching(/«трое» не разобрал — нужно от 1 до 30/) });
    const bare = readPlanEdit({ action: 'set_party', children: '12' }, { surface: 'mcp' });
    expect(bare.ok).toBe(false);
    if (!bare.ok) {
      expect(bare.error).toMatch(/одно число без «лет»/);
      expect(bare.error).not.toMatch(/План не собран/);
    }
  });
});

describe('разбор: сдвиг поездки', () => {
  it('дата начала — разбором `when`: число словами, диапазон, ISO; сдвиг в днях со знаком', () => {
    expect(readPlanEdit({ action: 'shift_dates', start_date: '2027-07-20' }, { now: NOW })).toEqual({ ok: true, edit: { kind: 'shift_dates', startDate: '2027-07-20' } });
    expect(readPlanEdit({ action: 'сдвинуть', start_date: '20 июля' }, { now: NOW })).toEqual({ ok: true, edit: { kind: 'shift_dates', startDate: '2027-07-20' } });
    expect(readPlanEdit({ action: 'shift_dates', start_date: '20–27 июля' }, { now: NOW })).toEqual({ ok: true, edit: { kind: 'shift_dates', startDate: '2027-07-20', length: 8 } });
    expect(readPlanEdit({ action: 'shift_dates', shift_days: '7' })).toEqual({ ok: true, edit: { kind: 'shift_dates', days: 7 } });
    expect(readPlanEdit({ action: 'shift_dates', shift_days: '-3' })).toEqual({ ok: true, edit: { kind: 'shift_dates', days: -3 } });
    expect(readPlanEdit({ action: 'перенести', shift_days: '−3' })).toEqual({ ok: true, edit: { kind: 'shift_dates', days: -3 } });
  });

  it('несуществующая, прошедшая, не дата, ноль, ничего — ошибка, а не сдвиг на соседний день', () => {
    expect(readPlanEdit({ action: 'shift_dates', start_date: '2027-02-30' }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringMatching(/нет в календаре/) });
    expect(readPlanEdit({ action: 'shift_dates', start_date: '1 ноября 2026' }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringMatching(/уже прошло/) });
    expect(readPlanEdit({ action: 'shift_dates', start_date: 'когда-нибудь' }, { now: NOW })).toMatchObject({ ok: false, error: expect.stringMatching(/не разобрал как дату/) });
    expect(readPlanEdit({ action: 'shift_dates', shift_days: '0' })).toMatchObject({ ok: false, error: expect.stringMatching(/не разобрал — нужно целое число дней/) });
    expect(readPlanEdit({ action: 'shift_dates' })).toMatchObject({ ok: false, error: expect.stringMatching(/start_date.*shift_days/) });
  });
});

describe('разбор: замена дня и список действий', () => {
  it('день и занятие обязательны; занятие — словами', () => {
    expect(readPlanEdit({ action: 'replace_day', day: '6', interest: 'рыбалка' })).toEqual({ ok: true, edit: { kind: 'replace_day', day: 6, interest: 'fishing' } });
    expect(readPlanEdit({ action: 'заменить', day: '2', interest: 'медведи' })).toEqual({ ok: true, edit: { kind: 'replace_day', day: 2, interest: 'bears' } });
    expect(readPlanEdit({ action: 'replace_day', interest: 'рыбалка' })).toMatchObject({ ok: false, error: expect.stringMatching(/номер дня/) });
    expect(readPlanEdit({ action: 'replace_day', day: '2', interest: 'что-нибудь' })).toMatchObject({ ok: false, error: expect.stringMatching(/не разобрал/) });
  });

  it('непонятное действие — ответ называет все восемь', () => {
    const r = readPlanEdit({ action: 'fly' });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      for (const a of ['add_day', 'remove_day', 'move_day', 'replace_day', 'set_lodging', 'set_party', 'shift_dates', 'flight_delay']) {
        expect(r.error).toContain(a);
      }
    }
  });
});

describe('ответ инструмента', () => {
  it('сдвиг на неделю: заметка, места и цена перечитаны, тур «попал на другие даты», тот же ID с номером правки', async () => {
    const text = await editTripPlanForKuzmich({ plan_id: ID, action: 'shift_dates', shift_days: '7' }, { now: NOW });
    expect(text).toMatch(/^Поездка сдвинута на 7 дней позже: 17 июля — 20 июля\./);
    expect(text).toContain('Места и цену туров, которых коснулась правка, я перечитал');
    expect(text).not.toContain('Места не прочитались');
    expect(text).toContain('«Мутновский вулкан» (ID70) — попал на другие даты');
    expect(text).toContain('сообщи оператору об изменении');
    expect(text).toContain(`ID плана: ${ID} (правка 1)`);
    // Занятость перечитана на новую дату дня 2 — 18.07, а не взята из черновика.
    expect(queries.some((q) => q.includes('FROM tour_availability ta'))).toBe(true);
  });

  it('занятость не прочиталась — ответ называет тур и как проверить, а не молчит', async () => {
    availabilityFails = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const text = await editTripPlanForKuzmich({ plan_id: ID, action: 'shift_dates', shift_days: '7' }, { now: NOW });
    expect(text).toContain('Места не прочитались: «Мутновский вулкан» (ID70) — проверь через get_tour_availability');
    log.mockRestore();
  });

  it('ошибка разбора — «План не менялся», в базу не ходим', async () => {
    const text = await editTripPlanForKuzmich({ plan_id: ID, action: 'set_party', children: '12' }, { surface: 'mcp', now: NOW });
    expect(text).toMatch(/План не менялся\.$/);
    expect(queries).toHaveLength(0);
  });

  it('строки ответа: перечитывание и задетые туры — по исходу', () => {
    expect(rereadLine([])).toBe('');
    expect(rereadLine([{ tourId: '70', title: 'Вулкан', day: 2, date: '2027-07-18', availability: 'none' }])).not.toContain('не прочитались');
    const party = toursTouchedLines([{ tourId: '70', title: 'Вулкан', how: 'party' }]);
    expect(party).toContain('«Вулкан» (ID70) — идёт другим составом группы');
    expect(party).toContain('подтверждает их оператор');
    expect(party).not.toContain('вернёт деньги');
    const both = toursTouchedLines([{ tourId: '70', title: 'Вулкан', how: 'dropped' }, { tourId: '71', title: 'Море', how: 'shifted' }]);
    expect(both).toContain('Не обещай, что оператор вернёт деньги');
    expect(both).toContain('подтверждает их оператор');
  });
});

describe('схемы: новые поля доходят до инструмента и видны агенту', () => {
  it('Кузьмич: состав и даты проходят проверку аргументов, возрасты массивом — строкой массива', () => {
    const r = validateToolArgs('edit_trip_plan', {
      plan_id: ID, action: 'set_party', adults: '3', children: [6, 10] as unknown as string, start_date: '20 июля', shift_days: '7',
    });
    expect(r).toMatchObject({ ok: true, args: { adults: '3', children: '[6,10]', start_date: '20 июля', shift_days: '7' } });
  });

  it('MCP: у edit_trip_plan есть поля состава и сдвига, и действие называет новые правки', () => {
    const tool = PUBLIC_MCP_TOOLS.find((t) => t.name === 'edit_trip_plan');
    const props = (tool?.inputSchema as { properties: Record<string, { description: string }> }).properties;
    for (const p of ['adults', 'children', 'start_date', 'shift_days']) expect(props[p]?.description, p).toBeTruthy();
    expect(props.action.description).toMatch(/replace_day.*set_party.*shift_dates/);
    expect(tool?.description).toMatch(/shift the whole trip/);
  });
});
