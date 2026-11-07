/**
 * Номер дня плана — календарный день поездки (аудит планировщика 07.11,
 * волна 2, H2–H5). Правила — lib/planner/calendar-days; экран и сквозная
 * приёмка — tests/unit/planner-calendar-days-ui.test.tsx.
 *
 * Здесь — правила на граничных данных и на настоящем движке (`recommendTrip`
 * с подменённым хранилищем, как в plan-edit.test): пропуск в номерах,
 * который движок оставляет при недоборе, становится свободным днём, и день
 * отъезда остаётся на дате рейса.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let TOURS: Record<string, Array<{ tourId: string; title: string; zone: string; activityType: string }>> = {};

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map((t) => ({
      tourId: t.tourId, title: t.title, shortDescription: null,
      operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 4.5, operatorReviewCount: 3,
      operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 10000, priceUnit: 'per_person',
      maxParticipants: 10, minParticipants: 1, durationHours: 8, difficulty: null,
      weatherDependent: false, seasonStart: null, seasonEnd: null, included: null,
      lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
    }))),
  fetchAvailabilityForTour: vi.fn(async (_id: string, from: string, to: string) => {
    const out = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      out.push({ date: new Date(t).toISOString().slice(0, 10), availableSlots: 10, bookedSlots: 0, remaining: 10, priceOverride: null });
    }
    return out;
  }),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchSelfSafety: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/planner/place-load', () => ({
  fetchCandidateLoads: vi.fn(async () => new Map()),
  fetchTourLoads: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/planner/intelligence', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/planner/intelligence')>();
  return { ...real, fetchForecastDays: vi.fn(async () => ({ ok: false, reason: 'test' })) };
});
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn(async () => '') }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { recommendTrip, ZONE_COORDS } from '@/lib/planner/engine';
import { planProfile, type PlanParams } from '@/lib/planner/plan-edit';
import { estimateGroup } from '@/lib/planner/estimate';
import { planForLead } from '@/lib/planner/plan-for-lead';
import { dateOfTripDay, tripCalendarDays } from '@/lib/planner/flow-balance';
import {
  FREE_DAY_POINT, FREE_DAY_TITLE, extendTrip, fillCalendarGaps, firstFreeDay, followDaySet, followDays,
  freeDay, freeDaysInstead, inCalendarOrder, isFreeDay, kamchatkaToday, renumberByPosition,
  tripDatesProblem, tripLengthWords,
} from '@/lib/planner/calendar-days';

type Z = 'avachinsky' | 'western' | 'eastern' | 'northern';
interface Day {
  day: number; type: string; zone: Z; title: string; zoneShown?: string | null;
  realTour?: { tourId: string }; availableDate?: string; slotsRemaining?: number;
  availability?: 'open' | 'none' | 'unread'; capacityWarning?: string;
}
const d = (day: number, type: string, title: string, zone: Z = 'avachinsky', extra: Partial<Day> = {}): Day =>
  ({ day, type, zone, title, ...extra });

beforeEach(() => {
  TOURS = {
    'avachinsky:volcano': [{ tourId: 't-volc', title: 'Восхождение на Авачинский', zone: 'avachinsky', activityType: 'volcano' }],
  };
});

describe('пропуск движка и хвост поездки — свободные дни', () => {
  it('недобор: дыра в номерах закрыта днём там, где человек был накануне', () => {
    const plan = [d(1, 'arrival', 'Прилёт'), d(2, 'travel', 'Переезд на запад', 'western'),
      d(3, 'activity', 'Рыбалка', 'western'), d(6, 'departure', 'Вылет')];
    const out = fillCalendarGaps(plan, 6);
    expect(out.map((x) => x.day)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.map((x) => x.title)).toEqual(['Прилёт', 'Переезд на запад', 'Рыбалка', FREE_DAY_TITLE, FREE_DAY_TITLE, 'Вылет']);
    // Ночь 4 и 5 — там же, где 3-я: на западе, а не «в Петропавловске».
    expect(out[3]).toMatchObject({ type: 'rest', zone: 'western', activityType: 'rest', priceFrom: 0, priceTo: 0 });
    expect(out[5]).toBe(plan[3]);
  });

  it('у местного дня отъезда нет: незаполненный хвост — тоже свободные дни', () => {
    const out = fillCalendarGaps([d(1, 'activity', 'Вулкан'), d(2, 'activity', 'Океан')], 4);
    expect(out.map((x) => x.day)).toEqual([1, 2, 3, 4]);
    expect(out.slice(2).every(isFreeDay)).toBe(true);
  });

  it('после дня отъезда дней не бывает: хвост — только у плана без отъезда', () => {
    const out = fillCalendarGaps([d(1, 'arrival', 'Прилёт'), d(2, 'activity', 'Вулкан'), d(3, 'departure', 'Вылет')], 6);
    expect(out.map((x) => x.day)).toEqual([1, 2, 3]);
  });

  it('без дат хвост не достраивается, дыра внутри — закрывается', () => {
    expect(fillCalendarGaps([d(1, 'activity', 'А'), d(3, 'activity', 'Б')], null).map((x) => x.day)).toEqual([1, 2, 3]);
  });

  it('сбой раскладки — два дня с одним номером: номер по месту, у двух карточек не одна дата', () => {
    const out = fillCalendarGaps([d(1, 'arrival', 'Прилёт'), d(2, 'activity', 'А'), d(2, 'activity', 'Б'), d(3, 'departure', 'Вылет')], 3);
    expect(inCalendarOrder(out)).toBe(true);
    expect(out.map((x) => x.title)).toEqual(['Прилёт', 'А', 'Б', 'Вылет']);
  });

  it('на настоящем движке: недобор не сдвигает отъезд, ночей столько, сколько ночей в датах', async () => {
    // Десять дней на один интерес: движок кладёт дни интереса и один
    // свободный день, остальное — недобор («наполнили N из M»).
    const params: PlanParams = {
      interests: ['volcano'], arrivalDate: '2027-07-10', departureDate: '2027-07-19',
      adults: 2, children: [], budgetTier: 'comfort',
    };
    const rec = await recommendTrip(planProfile(params), { itinerary: 'plain' });
    const tripDays = tripCalendarDays(params.arrivalDate, params.departureDate);
    expect(tripDays).toBe(10);
    // Предпосылка теста: у движка есть пропуск в номерах — иначе тест ничего не сторожит.
    expect(inCalendarOrder(rec.days)).toBe(false);

    const days = fillCalendarGaps(rec.days, tripDays);
    expect(days.map((x) => x.day)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const departure = days[days.length - 1]!;
    expect(departure.type).toBe('departure');
    expect(dateOfTripDay(params.arrivalDate, departure.day)).toBe(params.departureDate);

    // Смета и заявка: ночей девять — по одной на каждый день, кроме дня отъезда.
    const est = estimateGroup(days, { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor', arrivalDate: params.arrivalDate });
    const nights = est.lines.filter((l) => l.kind === 'lodging').map((l) => Number(/^(\d+)/.exec(l.basis)?.[1] ?? 0));
    expect(nights.reduce((a, b) => a + b, 0)).toBe(9);
    const lead = planForLead(days, { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor', arrivalDate: params.arrivalDate });
    expect(lead.days.map((x) => x.date)).toEqual(days.map((x) => dateOfTripDay(params.arrivalDate, x.day)));
    expect(lead.days[lead.days.length - 1]).toMatchObject({ type: 'departure', date: '2027-07-19' });
  });

  it('точка свободного дня — та же, что у дня отдыха движка', async () => {
    // День отдыха по просьбе стоит в Авачинской зоне — его точка и есть
    // точка свободного дня там; в других зонах — центр зоны движка.
    const rec = await recommendTrip(planProfile({
      interests: ['volcano'], arrivalDate: '2027-07-10', departureDate: '2027-07-19',
      adults: 2, children: [], budgetTier: 'comfort', restDays: 1,
    } as PlanParams), { itinerary: 'plain' });
    const rest = rec.days.find((x) => x.type === 'rest' && x.zone === 'avachinsky');
    expect(rest, 'движок не поставил день отдыха — тест ничего не сторожит').toBeDefined();
    expect(FREE_DAY_POINT.avachinsky).toEqual(rest!.coords);
    for (const zone of ['western', 'eastern', 'northern'] as const) {
      expect(FREE_DAY_POINT[zone]).toEqual(ZONE_COORDS[zone]);
    }
  });
});

describe('правка не сдвигает даты', () => {
  const plan = [d(1, 'arrival', 'Прилёт'), d(2, 'activity', 'Вулкан', 'avachinsky', {
    realTour: { tourId: 't-1' }, availableDate: '2030-08-02', slotsRemaining: 4, availability: 'open', capacityWarning: 'мало мест',
  }), d(3, 'activity', 'Океан'), d(4, 'departure', 'Вылет')];

  it('удалённый день становится свободным с тем же номером и в той же зоне', () => {
    const western = [d(1, 'arrival', 'Прилёт'), d(2, 'activity', 'Рыбалка', 'western'), d(3, 'departure', 'Вылет')];
    const out = freeDaysInstead(western, new Set([2]));
    expect(out.map((x) => x.day)).toEqual([1, 2, 3]);
    expect(out[1]).toMatchObject({ title: FREE_DAY_TITLE, zone: 'western' });
    expect(out[0]).toBe(western[0]);
  });

  it('перестановка: номер — по месту, у переехавшего тура сняты места прежней даты', () => {
    const moved = [plan[0], plan[2], plan[1], plan[3]];
    const { days, newNumbers } = renumberByPosition(moved);
    expect(days.map((x) => `${x.day}:${x.title}`)).toEqual(['1:Прилёт', '2:Океан', '3:Вулкан', '4:Вылет']);
    const volcano = days[2]!;
    expect(volcano.realTour?.tourId).toBe('t-1');
    for (const k of ['availableDate', 'slotsRemaining', 'availability', 'capacityWarning'] as const) {
      expect(volcano, k).not.toHaveProperty(k);
    }
    // Не сдвинутые дни — те же объекты.
    expect(days[0]).toBe(plan[0]);
    expect([...newNumbers.entries()]).toEqual([[1, 1], [3, 2], [2, 3], [4, 4]]);
  });

  it('состояние экрана уходит вслед за днём, ключи ушедших дней выпадают', () => {
    const { newNumbers } = renumberByPosition([plan[0], plan[2], plan[1], plan[3]]);
    expect(followDays({ 2: 'jeep', 3: 'boat', 9: 'helicopter' }, newNumbers)).toEqual({ 3: 'jeep', 2: 'boat' });
    expect([...followDaySet(new Set([2, 9]), newNumbers)]).toEqual([3]);
  });

  it('новый день — перед отъездом, отъезд на день позже; у местного — в конце', () => {
    const { days, added, newNumbers } = extendTrip(plan, freeDay);
    expect(added).toBe(4);
    expect(days.map((x) => `${x.day}:${x.title}`)).toEqual(['1:Прилёт', '2:Вулкан', '3:Океан', `4:${FREE_DAY_TITLE}`, '5:Вылет']);
    expect(newNumbers.get(4)).toBe(5);
    const local = [d(1, 'activity', 'Вулкан'), d(2, 'activity', 'Океан')];
    expect(extendTrip(local, freeDay).days.map((x) => x.day)).toEqual([1, 2, 3]);
  });

  it('свободный день ищется в своей зоне', () => {
    const days = [d(1, 'arrival', 'Прилёт'), freeDay(2, { zone: 'western' }), freeDay(3, { zone: 'avachinsky' }), d(4, 'departure', 'Вылет')];
    expect(firstFreeDay(days)?.day).toBe(2);
    expect(firstFreeDay(days, 'avachinsky')?.day).toBe(3);
    expect(firstFreeDay(days, 'eastern')).toBeUndefined();
  });
});

describe('даты формы', () => {
  it('длина поездки — дни по календарю и ночи', () => {
    expect(tripLengthWords(1)).toBe('1 день, без ночёвки');
    expect(tripLengthWords(2)).toBe('2 дня (1 ночь)');
    expect(tripLengthWords(5)).toBe('5 дней (4 ночи)');
    expect(tripLengthWords(6)).toBe('6 дней (5 ночей)');
    expect(tripLengthWords(21)).toBe('21 день (20 ночей)');
    expect(tripLengthWords(22)).toBe('22 дня (21 ночь)');
  });

  it('местный может уложиться в один день, прилетающий — нет', () => {
    expect(tripDatesProblem('2030-08-03', '2030-08-03', true)).toBeNull();
    expect(tripDatesProblem('2030-08-03', '2030-08-02', true)).toMatch(/раньше первого/);
    expect(tripDatesProblem('2030-08-03', '2030-08-03', false)).toMatch(/позже даты прилёта/);
    expect(tripDatesProblem('2030-08-03', '2030-08-04', false)).toBeNull();
  });

  it('«сегодня» — по Камчатке: в 20:30 UTC там уже завтра', () => {
    expect(kamchatkaToday(new Date('2027-07-10T20:30:00Z'))).toBe('2027-07-11');
    expect(kamchatkaToday(new Date('2027-07-10T11:59:00Z'))).toBe('2027-07-10');
  });
});
