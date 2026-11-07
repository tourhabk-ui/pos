/**
 * Сценарии планировщика на подменённом хранилище (аудит планировщика 07.11).
 *
 * Настоящий recommendTrip, туры и маршруты — из подмены, без сети, базы и
 * моделей. Файл растёт вместе с волнами аудита (раздел 5, волна 5): каждый
 * сценарий держит инвариант плана, а не текст исходника.
 *
 * Даты — июль следующего года от сегодняшнего дня: вулканы в сезоне, а тест
 * с зашитой датой — бомба.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tour {
  tourId: string; title: string; durationHours: number | null; zone: string; activityType: string;
  basePrice?: number; minParticipants?: number | null; maxParticipants?: number | null;
}
/** Туры по паре «зона:активность» — свои в каждом сценарии. */
let TOURS: Record<string, Tour[]> = {};
/** Строки тревог платформы — то, что читает `FROM safety_alerts`. */
let ALERT_ROWS: Array<{ id: string; zone: string; severity: string; title: string; message: string; source: string }> = [];

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 0, operatorReviewCount: 0,
    operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: t.basePrice ?? 10000, priceUnit: 'per_person',
    maxParticipants: t.maxParticipants === undefined ? 10 : t.maxParticipants,
    minParticipants: t.minParticipants === undefined ? 1 : t.minParticipants,
    durationHours: t.durationHours, multiDayCount: null, difficulty: null,
    weatherDependent: false, seasonStart: null, seasonEnd: null, included: null,
    lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  // Места есть на каждый день окна: сценарии здесь — про дни, не про места.
  fetchAvailabilityForTour: vi.fn(async (_tourId: string, from: string, to: string) => {
    const out = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      out.push({ date: new Date(t).toISOString().slice(0, 10), availableSlots: 10, bookedSlots: 0, remaining: 10, priceOverride: null });
    }
    return out;
  }),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: null })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchTourKeepsSchedule: vi.fn(async () => true),
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
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async (sql: string) => ({ rows: String(sql).includes('FROM safety_alerts') ? ALERT_ROWS : [] })) } }));

import { recommendTrip, type TripProfile } from '@/lib/planner/engine';
import { fetchRealToursForZone } from '@/lib/planner/data';
import { tourPlanSpan } from '@/lib/planner/tour-span';
import { ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES } from '@/lib/planner/constants';

const NEXT_JULY = new Date().getUTCFullYear() + 1;
const profile = (days: number, interests: string[]): TripProfile => ({
  interests,
  arrivalDate: `${NEXT_JULY}-07-10`,
  departureDate: new Date(Date.parse(`${NEXT_JULY}-07-10T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10),
  adults: 2,
  children: [],
  fitnessLevel: 'moderate',
  budgetTier: 'comfort',
});

/** Сколько дней плана занимает каждый поставленный тур. */
function daysByTour(rec: Awaited<ReturnType<typeof recommendTrip>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of rec.days) {
    const id = d.realTour?.tourId;
    if (id) out.set(String(id), (out.get(String(id)) ?? 0) + 1);
  }
  return out;
}

beforeEach(() => { TOURS = {}; ALERT_ROWS = []; });

describe('E1: многодневный тур не режется на краю блока (волна 3.1)', () => {
  // Проба 6.4 C аудита: 7 дней, вулканы, туры на 1, 2 и 3 дня. До 3.1 тур
  // на три дня вставал днём 5, «день 2 из 3» — днём 6, третьего дня не было,
  // а цена в смете оставалась полной: проверка длины сравнивала тур с блоком
  // целиком, а не с остатком.
  const ONE: Tour = { tourId: 't-1', title: 'Вулкан за день', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' };
  const TWO: Tour = { tourId: 't-2', title: 'Два вулкана', durationHours: 48, zone: 'avachinsky', activityType: 'volcano' };
  const THREE: Tour = { tourId: 't-3', title: 'Три вулкана', durationHours: 72, zone: 'avachinsky', activityType: 'volcano' };

  it('каждый поставленный тур — всеми своими днями; не вошедший — назван', async () => {
    TOURS['avachinsky:volcano'] = [ONE, TWO, THREE];
    const rec = await recommendTrip(profile(7, ['volcano']));
    const placed = daysByTour(rec);
    for (const t of [ONE, TWO, THREE]) {
      const span = tourPlanSpan(t.durationHours, null) ?? 1;
      const n = placed.get(t.tourId) ?? 0;
      expect([0, span], `${t.title}: в плане ${n} дн. из ${span}`).toContain(n);
    }
    // «Состав N туров не заполнен» считает туры, а не их дни.
    const lodging = rec.warnings.find((w) => w.message.startsWith('Состав '));
    const n = placed.size;
    expect(lodging?.message).toContain(n === 1 ? 'Состав одного тура' : `Состав ${n} туров`);
    expect(lodging?.message).toContain('итог в смете завышен');
    expect(lodging?.severity).toBe('important');
    // Не вошедший многодневный тур назван словами, а не пропал молча.
    const missing = [ONE, TWO, THREE].filter((t) => !placed.has(t.tourId) && (tourPlanSpan(t.durationHours, null) ?? 1) > 1);
    const text = rec.warnings.map((w) => w.message).join('\n');
    for (const t of missing) expect(text).toContain(t.title);
  });

  it('вилка активностей — ровно по поставленным турам: цена тура без его дней не считается', async () => {
    TOURS['avachinsky:volcano'] = [ONE, TWO, THREE];
    const rec = await recommendTrip(profile(7, ['volcano']));
    const placedTours = daysByTour(rec).size;
    // У каждого тура цена 10 000 ₽ за человека; верх вилки — с запасом движка.
    expect(rec.priceBreakdown.activities[0]).toBe(placedTours * 10000);
  });
});

describe('E3: минимум группы (волна 3.3)', () => {
  // Проба C аудита: один человек на туре с минимумом 4 — без единого слова.
  it('группа меньше минимума тура — день говорит «нужен набор группы»; дотягивает — молчит', async () => {
    TOURS['avachinsky:volcano'] = [{ tourId: 't-min', title: 'Вулкан с набором', durationHours: 10, zone: 'avachinsky', activityType: 'volcano', minParticipants: 4 }];
    const solo = await recommendTrip({ ...profile(4, ['volcano']), adults: 1 });
    const day = solo.days.find((d) => d.realTour?.tourId === 't-min');
    expect(day?.dayWarnings[0]).toBe('Нужен набор группы от 4 чел.: вас 1. Выезд подтверждает оператор.');

    const four = await recommendTrip({ ...profile(4, ['volcano']), adults: 4 });
    const day4 = four.days.find((d) => d.realTour?.tourId === 't-min');
    expect(day4?.dayWarnings.some((w) => w.startsWith('Нужен набор группы'))).toBe(false);
    // Минимум доезжает до дня: правка состава пересчитает строку.
    expect(day4?.realTour?.minParticipants).toBe(4);
  });
});

describe('E5: туры зоны — в окне поездки (волна 3.5)', () => {
  it('движок просит туры зоны с окном дат поездки — каждый раз: и оценка зоны, и блок дней', async () => {
    TOURS['avachinsky:volcano'] = [{ tourId: 't-1', title: 'Вулкан за день', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' }];
    const p = profile(4, ['volcano']);
    vi.mocked(fetchRealToursForZone).mockClear();
    await recommendTrip(p);
    const calls = vi.mocked(fetchRealToursForZone).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call[4], `вызов ${call[0]}:${call[1]}:${call[2]}`).toEqual({ from: p.arrivalDate, to: p.departureDate });
  });
});

describe('E8: зима и пустой план (волна 3.6)', () => {
  // Проба 6.4 E аудита: январь, вулканы, рыбалка, треккинг — дней нет, а
  // смета показывала трансфер аэропорта и не говорила, что доступно.
  const winter = (): TripProfile => ({
    ...profile(7, ['volcano', 'fishing', 'trekking']),
    arrivalDate: `${NEXT_JULY}-01-15`, departureDate: `${NEXT_JULY}-01-21`,
  });

  it('дней нет — смета пустая, а «Важно» называет, что доступно в этом месяце', async () => {
    const rec = await recommendTrip(winter());
    expect(rec.days).toHaveLength(0);
    expect(rec.priceBreakdown.perPersonTotal).toEqual([0, 0]);
    expect(rec.priceBreakdown.transport).toEqual([0, 0]);
    const line = rec.warnings.find((w) => w.message.startsWith('В эти даты план не собрался'));
    expect(line?.severity).toBe('important');
    const listed = line!.message.split('доступны: ')[1]!.split(' — ')[0]!.split(', ').sort();
    const january = Object.entries(ACTIVITY_CONSTRAINTS).filter(([, c]) => c.months.includes(1)).map(([a]) => ACTIVITY_NAMES[a] ?? a).sort();
    expect(listed).toEqual(january);
    for (const asked of ['volcano', 'fishing', 'trekking']) expect(listed).not.toContain(ACTIVITY_NAMES[asked]);
  });

  it('даты наоборот — строки «все просьбы вне сезона» нет: причина другая', async () => {
    const rec = await recommendTrip({ ...winter(), departureDate: `${NEXT_JULY}-01-10` });
    expect(rec.days).toHaveLength(0);
    expect(rec.warnings.some((w) => w.message.startsWith('В эти даты план не собрался'))).toBe(false);
  });
});

describe('E9: вертолётный выезд в Северную зону — из города (волна 3.7)', () => {
  // Проба 6.4 D аудита: 7 дней, гейзеры — дни в Северной зоне, резерв, вылет
  // и критическое «дня на возвращение в Петропавловск нет». Ребро графа
  // Северная → Авачинская дня не требует: вертолёт возвращается в тот же день.
  it('ни пустого «дня возвращения», ни ложной тревоги; ночи — в городе', async () => {
    TOURS['northern:geyser'] = [{ tourId: 't-geo', title: 'Долина гейзеров на вертолёте', durationHours: 9, zone: 'northern', activityType: 'geyser' }];
    const rec = await recommendTrip(profile(7, ['geyser']));
    expect(rec.days.some((d) => d.zone === 'northern')).toBe(true);
    expect(rec.days.some((d) => d.title.startsWith('Возвращение: Северная зона'))).toBe(false);
    expect(rec.warnings.some((w) => w.message.includes('дня на возвращение в Петропавловск в нём нет'))).toBe(false);
  });
});

describe('S4: тревоги — только по зонам, куда план пошёл (волна 3.7)', () => {
  it('тревога о Западной зоне в плане по Авачинской не выводится; своя зона и «весь край» — выводятся', async () => {
    TOURS['avachinsky:volcano'] = [{ tourId: 't-1', title: 'Вулкан за день', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' }];
    ALERT_ROWS = [
      { id: 'a-w', zone: 'western', severity: 'important', title: 'Паводок на Опале', message: 'Броды закрыты', source: 'МЧС' },
      { id: 'a-a', zone: 'avachinsky', severity: 'important', title: 'Пепел над Авачей', message: 'Выход ограничен', source: 'KVERT' },
      { id: 'a-all', zone: 'all', severity: 'info', title: 'Штормовое', message: 'Ветер по краю', source: 'МЧС' },
    ];
    const rec = await recommendTrip(profile(4, ['volcano']));
    expect(new Set(rec.days.map((d) => d.zone))).toEqual(new Set(['avachinsky']));
    const text = rec.warnings.filter((w) => w.type === 'mchs').map((w) => w.message).join('\n');
    expect(text).not.toContain('Паводок на Опале');
    expect(text).toContain('Пепел над Авачей');
    expect(text).toContain('Штормовое');
  });

  it('зона-кандидат, не вошедшая в план, тревоги не даёт', async () => {
    // Три дня, вулкан и рыбалка: Западная — кандидат по рыбалке, но связка
    // «туда, день там, обратно» в два свободных дня не влезает. До 07.11
    // тревога шла по кандидатам и называла паводок в зоне, куда план не едет.
    TOURS['avachinsky:volcano'] = [{ tourId: 't-1', title: 'Вулкан за день', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' }];
    TOURS['western:fishing'] = [{ tourId: 't-f', title: 'Рыбалка на Опале', durationHours: 10, zone: 'western', activityType: 'fishing' }];
    ALERT_ROWS = [
      { id: 'a-w', zone: 'western', severity: 'important', title: 'Паводок на Опале', message: 'Броды закрыты', source: 'МЧС' },
    ];
    const rec = await recommendTrip(profile(3, ['volcano', 'fishing']));
    expect(rec.zones.some((z) => z.zone === 'western')).toBe(true);
    expect(rec.days.some((d) => d.zone === 'western')).toBe(false);
    const text = rec.warnings.filter((w) => w.type === 'mchs').map((w) => w.message).join('\n');
    expect(text).not.toContain('Паводок на Опале');
  });
});
