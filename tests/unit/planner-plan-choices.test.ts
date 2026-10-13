/**
 * Сторож: жильё — пункт плана (#2304, шаг 3); трансфер — нет (13.10).
 *
 * До 09.10 «Что ещё нужно» показывало объекты жилья и поездки перевозчиков
 * списком: выбрать было нельзя, в смете ночь оставалась ориентиром по зоне
 * на человека (а жильё продаётся за номер), в заявку не уходило ничего,
 * ссылки вели без дат, а местному подбиралось жильё на ночь, которую смета
 * считала ночью дома. Здесь — поведением:
 *   — цена стоянки на группу — правилом брони: сумма цен ночей × номера
 *     одного типа, самый дешёвый тип, куда группа помещается на все ночи;
 *   — выбранная стоянка вынимает свои ночи из ориентира и встаёт строкой с
 *     ценой предложения;
 *   — выбранное уходит в заявку и называется словами;
 *   — ссылки несут даты и состав и разбираются строго;
 *   — местному жильё на ночь дома не подбирается.
 *
 * Трансфер в план не берут (владелец 13.10: «бронируют целую машину а не
 * место в ней»): до этого здесь выбиралась поездка перевозчика «N мест × цена
 * места». Смета держит «Трансферы аэропорта» ориентиром; заявки, ушедшие до
 * 13.10 с местами, карточка лида по-прежнему читает.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));

import { lodgingStays, stayPriceForGroup, type RoomStayFacts, type ExtrasDay } from '@/lib/planner/trip-extras';
import { LODGING_FOR_STAY_SQL, findLodgingForStay } from '@/lib/planner/trip-extras-data';
import { estimateGroup, type EstimateDay, type EstimateProfile } from '@/lib/planner/estimate';
import {
  resolveChoices, toggleLodging, EMPTY_SELECTION,
  type PlanChoices, type ChosenStay, type ExtrasForChoices,
} from '@/lib/planner/plan-choices';
import { planForLead, planLeadLines, type PlanForLead } from '@/lib/planner/plan-for-lead';
import { stayLink, parseStayPrefill } from '@/lib/stay/stay-link';
import { POST as extrasRoute } from '@/app/api/planner/trip-extras/route';

beforeEach(() => poolQueryMock.mockReset());

const room = (over: Partial<RoomStayFacts>): RoomStayFacts => ({
  roomId: 'r', name: 'Номер', maxGuests: 2, minFree: 1, staySum: 10000, ...over,
});

describe('цена стоянки на группу — правилом брони', () => {
  it('самый дешёвый тип, куда группа помещается целиком: семейный дешевле двух стандартных', () => {
    const rooms = [
      room({ roomId: 's', name: 'Стандарт', maxGuests: 2, minFree: 2, staySum: 16000 }),
      room({ roomId: 'f', name: 'Семейный', maxGuests: 4, minFree: 1, staySum: 27000 }),
    ];
    expect(stayPriceForGroup(rooms, 2)).toEqual({ kind: 'priced', total: 16000, rooms: 1, roomId: 's', roomName: 'Стандарт', maxGuests: 2 });
    expect(stayPriceForGroup(rooms, 4)).toEqual({ kind: 'priced', total: 27000, rooms: 1, roomId: 'f', roomName: 'Семейный', maxGuests: 4 });
    expect(stayPriceForGroup(rooms, 3)).toMatchObject({ total: 27000, rooms: 1 });
  });

  it('номеров на самую занятую ночь не хватает — тип не годится; ни один — «подберёт хозяин»', () => {
    const rooms = [room({ maxGuests: 2, minFree: 2, staySum: 16000 }), room({ maxGuests: 4, minFree: 1, staySum: 27000 })];
    expect(stayPriceForGroup(rooms, 5)).toEqual({ kind: 'no_fit', people: 5 });
  });

  it('номер без вместимости или без цены не считается: ноль — не цена', () => {
    expect(stayPriceForGroup([room({ staySum: 0 }), room({ maxGuests: 0 })], 2)).toEqual({ kind: 'no_fit', people: 2 });
  });

  it('запрос отдаёт номера, свободные на все ночи, с вместимостью, остатком и суммой ночей', () => {
    expect(LODGING_FOR_STAY_SQL).toMatch(/HAVING bool_and\(NOT rn\.blocked AND rn\.free_units > 0\)/);
    expect(LODGING_FOR_STAY_SQL).toMatch(/MIN\(rn\.free_units\)::int AS min_free/);
    expect(LODGING_FOR_STAY_SQL).toMatch(/SUM\(rn\.price\) AS stay_sum/);
    expect(LODGING_FOR_STAY_SQL).toMatch(/r\.max_guests/);
    expect(LODGING_FOR_STAY_SQL).toMatch(/jsonb_array_length\(fit\.rooms\) > 0/);
  });

  it('подбор считает цену на состав, который ему передали', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{
      id: 'a1', name: 'Гостиница', type: 'hotel', price_from: '5000', rating: null, review_count: 0, is_verified: true,
      rooms: [
        { room_id: 's', name: 'Стандарт', max_guests: 2, min_free: 2, stay_sum: '16000.00' },
        { room_id: 'f', name: 'Семейный', max_guests: 4, min_free: 1, stay_sum: 27000 },
      ],
    }] });
    const stay = { zone: 'avachinsky' as const, checkIn: '2030-08-03', checkOut: '2030-08-06', nights: 3 };
    const two = await findLodgingForStay(stay, 2);
    const four = await findLodgingForStay(stay, 4);
    expect(two.state === 'ok' && two.items[0]!.stay).toMatchObject({ total: 16000, roomName: 'Стандарт' });
    expect(four.state === 'ok' && four.items[0]!.stay).toMatchObject({ total: 27000, roomName: 'Семейный' });
  });
});

describe('ночь дома у местного — жильё не подбирается (то же правило, что у сметы)', () => {
  const plan: ExtrasDay[] = [
    { day: 1, type: 'arrival', zone: 'avachinsky' },
    { day: 2, type: 'travel', zone: 'eastern' },
    { day: 3, type: 'activity', zone: 'avachinsky' },
    { day: 4, type: 'departure', zone: 'avachinsky' },
  ];

  it('приезжему — все ночи; местному — только вне дома', () => {
    expect(lodgingStays(plan, '2030-08-03', '2030-08-06').stays.map((s) => s.zone)).toEqual(['avachinsky', 'eastern', 'avachinsky']);
    expect(lodgingStays(plan, '2030-08-03', '2030-08-06', 'local').stays).toEqual([
      { zone: 'eastern', checkIn: '2030-08-04', checkOut: '2030-08-05', nights: 1 },
    ]);
  });

  it('роут передаёт «откуда едут» и состав группы', async () => {
    poolQueryMock.mockImplementation((q: unknown) => {
      const sql = typeof q === 'string' ? q : String((q as { text?: string } | null)?.text ?? '');
      return Promise.resolve(sql.includes('planner_zone IS NULL') ? { rows: [{ n: 0 }] } : { rows: [] });
    });
    const call = async (tripOrigin?: string) => {
      const res = await extrasRoute(new Request('http://localhost/api/planner/trip-extras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.0.${tripOrigin ? 1 : 2}` },
        body: JSON.stringify({
          needs: { lodging: true }, arrivalDate: '2030-08-03', departureDate: '2030-08-06', adults: 2, children: [7],
          days: plan, ...(tripOrigin ? { tripOrigin } : {}),
        }),
      }) as unknown as NextRequest);
      return (await res.json() as { data: { lodging: { stays: unknown[] } } }).data.lodging.stays.length;
    };
    expect(await call()).toBe(3);
    expect(await call('local')).toBe(1);
  });
});

// ── Смета с выбранным ────────────────────────────────────────────────────────

const d = (day: number, type: EstimateDay['type'], zone: EstimateDay['zone'] = 'avachinsky'): EstimateDay => ({
  day, type, zone, title: `День ${day}`, priceFrom: 0, priceTo: 0,
});
const DAYS = [d(1, 'arrival'), d(2, 'activity'), d(3, 'rest'), d(4, 'departure')];
const PROFILE: EstimateProfile = { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor', arrivalDate: '2030-08-03' };
const STAY: ChosenStay = {
  zone: 'avachinsky', checkIn: '2030-08-03', checkOut: '2030-08-05', nights: 2, accommodationId: 'a1', name: 'Гостиница',
  price: { kind: 'priced', total: 20000, rooms: 1, roomId: 's', roomName: 'Стандарт', maxGuests: 2 },
};
const choices = (over: Partial<PlanChoices> = {}): PlanChoices => ({ stays: [], ...over });
// Разделитель разрядов ru-RU — неразрывный пробел; сверяем по обычному.
const line = (e: ReturnType<typeof estimateGroup>, label: RegExp) => {
  const l = e.lines.find((x) => label.test(x.label));
  return l && { ...l, basis: l.basis.replace(/\s/g, ' ') };
};

describe('смета: выбранное — пунктом плана вместо ориентира', () => {
  it('ночи выбранной стоянки выходят из ориентира, стоянка — строкой с ценой предложения', () => {
    const before = estimateGroup(DAYS, PROFILE);
    // comfort, Авачинская: 7 000 ₽ ×0.8…×1.2 на человека за ночь; 3 ночи × 2 чел.
    expect(line(before, /Проживание в Авачинской/)?.total).toEqual([33600, 50400]);

    const e = estimateGroup(DAYS, PROFILE, choices({ stays: [STAY] }));
    expect(line(e, /Проживание в Авачинской/)).toMatchObject({ basis: '1 ночь × 2 чел.', total: [11200, 16800] });
    expect(line(e, /Жильё «Гостиница»/)).toMatchObject({
      label: 'Жильё «Гостиница», 03.08–05.08', basis: '2 ночи × 1 номер «Стандарт»', total: [20000, 20000], source: 'offer',
    });
    expect(e.fromOffers).toEqual([20000, 20000]);
    expect([e.fromTours[0] + e.fromOffers[0] + e.fromEstimates[0], e.fromTours[1] + e.fromOffers[1] + e.fromEstimates[1]]).toEqual(e.total);
  });

  it('стоянка в другой зоне чужих ночей не вынимает; без даты прилёта выбранное не ставится вовсе', () => {
    const western = estimateGroup(DAYS, PROFILE, choices({ stays: [{ ...STAY, zone: 'western' }] }));
    expect(line(western, /Проживание в Авачинской/)?.total).toEqual([33600, 50400]);
    const noDate = estimateGroup(DAYS, { ...PROFILE, arrivalDate: null }, choices({ stays: [STAY] }));
    expect(line(noDate, /Жильё/)).toBeUndefined();
    expect(line(noDate, /Проживание в Авачинской/)?.total).toEqual([33600, 50400]);
  });

  it('группа не помещается или цены нет — строка без суммы, в итог не входит, причина названа', () => {
    const noFit = estimateGroup(DAYS, PROFILE, choices({ stays: [{ ...STAY, price: { kind: 'no_fit', people: 2 } }] }));
    expect(line(noFit, /Жильё/)).toMatchObject({ total: null, note: expect.stringMatching(/подберёт хозяин/) });
    expect(noFit.unpriced).toContain('Жильё «Гостиница», 03.08–05.08');
    const unknown = estimateGroup(DAYS, PROFILE, choices({ stays: [{ ...STAY, price: null }] }));
    expect(line(unknown, /Жильё/)?.note).toMatch(/не посчитали/);
  });

  it('трансфер — ориентир аэропорта на группу; мест «× цена места» в смете нет', () => {
    // Снимок, сохранённый до 13.10, ещё несёт поездку с местами: смета её не
    // читает — машину заказывают целиком, и цены до заявки нет.
    const legacy = { stays: [], transfers: [{ tripId: 't1', date: '2030-08-03', from: 'Аэропорт Елизово', to: 'Паратунка', seats: 2, pricePerSeat: 1500, carrier: 'Перевозчик' }] } as unknown as PlanChoices;
    for (const e of [estimateGroup(DAYS, PROFILE), estimateGroup(DAYS, PROFILE, legacy)]) {
      expect(line(e, /Трансферы аэропорта/)).toMatchObject({ basis: '2 500–5 000 ₽ × 2 чел.', total: [5000, 10000], source: 'estimate' });
      expect(e.lines.some((l) => /\d мест|за место/.test(l.basis) || l.source === 'offer')).toBe(false);
    }
    expect(estimateGroup(DAYS, PROFILE, legacy).total).toEqual(estimateGroup(DAYS, PROFILE).total);
  });
});

describe('выбор — ключи; пункты плана — из текущего ответа', () => {
  const DATA: ExtrasForChoices = {
    lodging: { state: 'checked', stays: [
      { zone: 'avachinsky', checkIn: '2030-08-03', checkOut: '2030-08-05', nights: 2,
        result: { state: 'ok', items: [{ id: 'a1', name: 'Гостиница', stay: STAY.price! }] } },
    ] },
  };

  it('выбранное собирается — только жильё', () => {
    const c = resolveChoices(DATA, toggleLodging(EMPTY_SELECTION, 'avachinsky-2030-08-03', 'a1'));
    expect(c).toEqual({ stays: [{ ...STAY }] });
  });

  it('повторное нажатие снимает выбор; выбор, которого в ответе нет, в план не попадает', () => {
    const sel = toggleLodging(toggleLodging(EMPTY_SELECTION, 'avachinsky-2030-08-03', 'a1'), 'avachinsky-2030-08-03', 'a1');
    expect(sel.lodging).toEqual({});
    const stale = resolveChoices(DATA, { lodging: { 'avachinsky-2030-08-03': 'gone', 'western-2030-08-09': 'a1' } });
    expect(stale).toEqual({ stays: [] });
    expect(resolveChoices(null, { lodging: { x: 'a1' } })).toEqual({ stays: [] });
  });
});

describe('заявка несёт выбранное и называет его словами', () => {
  it('жильё — в плане заявки и в строках уведомления', () => {
    const plan = planForLead(DAYS, PROFILE, choices({ stays: [STAY] }));
    expect(plan.lodging).toEqual([{
      accommodation_id: 'a1', name: 'Гостиница', zone: 'avachinsky', check_in: '2030-08-03', check_out: '2030-08-05',
      nights: 2, total: 20000, rooms: 1, room: 'Стандарт',
    }]);
    const text = planLeadLines(plan).join('\n').replace(/\s/g, ' ');
    expect(text).toContain('Жильё: «Гостиница», 03.08–05.08 (2 ночи), 1 номер «Стандарт», 20 000 ₽');
    // Смета заявки — та же, что на экране, с выбранным.
    expect(plan.estimate.total).toEqual(estimateGroup(DAYS, PROFILE, choices({ stays: [STAY] })).total);
  });

  it('без выбора — полей нет, как раньше; мест в поездках заявка не пишет даже из старого снимка', () => {
    expect(planForLead(DAYS, PROFILE)).not.toHaveProperty('lodging');
    const legacy = { stays: [], transfers: [{ tripId: 't1', date: '2030-08-03', from: 'Аэропорт', to: 'Паратунка', seats: 2, pricePerSeat: 1500, carrier: 'П' }] } as unknown as PlanChoices;
    expect(planForLead(DAYS, PROFILE, legacy)).not.toHaveProperty('transfers');
  });

  it('заявка, ушедшая до 13.10 с местами, в карточке лида читается как раньше', () => {
    const old: PlanForLead = {
      ...planForLead(DAYS, PROFILE),
      transfers: [{ trip_id: 't1', date: '2030-08-03', from: 'Аэропорт Елизово', to: 'Паратунка', seats: 2, price_per_seat: 1500, carrier: 'Перевозчик' }],
    };
    const text = planLeadLines(old).join('\n').replace(/\s/g, ' ');
    expect(text).toContain('Трансфер: Аэропорт Елизово — Паратунка, 03.08, 2 места × 1 500 ₽ (Перевозчик)');
  });
});

describe('ссылки с датами и составом', () => {
  it('жильё: туда и обратно; негодное — null, а не выдуманные даты', () => {
    const href = stayLink('a1', { checkIn: '2030-08-03', checkOut: '2030-08-05', adults: 4, children: 1, roomId: '11111111-1111-4111-8111-111111111111', rooms: 2 });
    expect(href).toBe('/accommodations/a1?check_in=2030-08-03&check_out=2030-08-05&adults=4&children=1&room=11111111-1111-4111-8111-111111111111&rooms=2');
    expect(parseStayPrefill(href.split('?')[1]!)).toEqual({
      checkIn: '2030-08-03', checkOut: '2030-08-05', adults: 4, children: 1, roomId: '11111111-1111-4111-8111-111111111111', rooms: 2,
    });
    expect(parseStayPrefill('check_in=2030-08-05&check_out=2030-08-03')).toBeNull();
    expect(parseStayPrefill('check_in=2030-02-30&check_out=2030-03-02')).toBeNull();
    expect(parseStayPrefill('')).toBeNull();
    expect(parseStayPrefill('check_in=2030-08-03&check_out=2030-08-04&adults=99&room=x')).toEqual({
      checkIn: '2030-08-03', checkOut: '2030-08-04', adults: 2, children: 0,
    });
  });
});
