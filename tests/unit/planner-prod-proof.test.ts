/**
 * План агента говорит то, что просили, и о датах поездки (пруф с прода 06.11).
 *
 * Внешний ИИ собрал через make_trip_plan план на 10–14.07.2027 для двоих,
 * «вулканы и рыбалка». Что было не так, по коду и прогону движка:
 *   — на день 2 встал Горелый, у которого в эти даты мест нет, хотя выбор
 *     вулканов в зоне был: проверка мест работала только в стиле «с
 *     оператором», а план без стиля — «вперемешку»;
 *   — рыбалки в плане не было вовсе: второй день блока ушёл на отдых после
 *     восхождения, Западная зона не влезла связкой, и день 4 стал «свободным
 *     днём», хотя рыбалка в Авачинской зоне есть. Объяснение шло уровнем
 *     info, а info в «Важно» агента не проходит;
 *   — строка о рыболовной путёвке стояла при плане без рыбалки;
 *   — сводка МЧС 06.11 (перекрытая на сутки дорога, вулканы) стояла на днях
 *     июля следующего года фактом дня.
 *
 * Проверка — исполнением настоящего recommendTrip с подменённым хранилищем.
 * Даты — июль следующего года от сегодняшнего дня (рыбалка и вулканы в
 * сезоне), и сводки — от «сейчас»: тест с зашитой датой — бомба.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Подмена хранилища ────────────────────────────────────────────────────

interface Tour {
  tourId: string; title: string; durationHours: number | null; zone: string; activityType: string;
  seasonStart?: string; seasonEnd?: string;
}
/** Туры по паре «зона:активность» — свои в каждом тесте. */
let TOURS: Record<string, Tour[]> = {};
/** Свободные места по туру на даты поездки. Нет ключа — мест нет. */
let SLOTS: Record<string, number> = {};
/** Даты выезда тура, если не все дни окна (YYYY-MM-DD). Нет ключа — все. */
let SLOT_DATES: Record<string, string[]> = {};
/** Ведёт ли тур календарь. Нет ключа — ведёт. */
let KEEPS: Record<string, boolean> = {};

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 4.5, operatorReviewCount: 3,
    operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 10000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours, difficulty: null,
    weatherDependent: false, seasonStart: t.seasonStart ?? null, seasonEnd: t.seasonEnd ?? null, included: null,
    lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  fetchAvailabilityForTour: vi.fn(async (tourId: string, from: string, to: string) => {
    if (!SLOTS[tourId]) return [];
    const out = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      if (SLOT_DATES[tourId] && !SLOT_DATES[tourId].includes(date)) continue;
      out.push({ date, availableSlots: 10, bookedSlots: 10 - SLOTS[tourId], remaining: SLOTS[tourId], priceOverride: null });
    }
    return out;
  }),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  // Туров без календаря в этих снимках нет; у тура с пустыми датами
  // расписание есть — «мест нет» (tests/unit/planner-on-request-tours).
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchTourKeepsSchedule: vi.fn(async (tourId: string) => KEEPS[tourId] ?? true),
  fetchSelfSafety: vi.fn(async (ids: string[]) => {
    if (safetyFails) return null;
    const out = new Map<string, unknown>();
    for (const id of ids) {
      const r = SAFETY[id];
      if (!r) continue;
      out.set(id, {
        isRoute: r.is_route, routeDifficulty: r.route_difficulty,
        mchsRegistrationRequired: r.mchs_registration_required,
        routeRegistrationRequired: r.route_registration_required,
        hasProfile: r.has_profile, satCommunicatorRequired: r.sat_communicator_required,
        placeRegistrationRequired: r.place_registration_required,
      });
    }
    return out;
  }),
}));

vi.mock('@/lib/planner/place-load', () => ({
  fetchCandidateLoads: vi.fn(async () => new Map()),
  fetchTourLoads: vi.fn(async () => new Map()),
}));

vi.mock('@/lib/planner/intelligence', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/planner/intelligence')>();
  return { ...real, fetchForecastDays: vi.fn(async () => ({ ok: false, reason: 'test' })) };
});

const aiPrompts: string[] = [];
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: vi.fn(async (messages: Array<{ content: string }>) => {
    aiPrompts.push(messages.map((m) => m.content).join('\n'));
    return '';
  }),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));

/** Маршруты для самостоятельного выхода: id → зона/активность. */
const ROUTES: Array<{ id: string; title: string; zone: string; activity_type: string }> = [
  { id: 'r-trek-ok', title: 'Тропа к Сухой речке', zone: 'avachinsky', activity_type: 'trekking' },
  { id: 'r-trek-mchs', title: 'Перевал с регистрацией', zone: 'avachinsky', activity_type: 'trekking' },
  { id: 'r-trek-hard', title: 'Траверс хребта', zone: 'avachinsky', activity_type: 'trekking' },
  { id: 'r-trek-nodata', title: 'Место без профиля', zone: 'avachinsky', activity_type: 'trekking' },
  { id: 'r-volc-self', title: 'Подход к Козельскому', zone: 'avachinsky', activity_type: 'volcano' },
  { id: 'r-fish-ok', title: 'Берег Опалы', zone: 'western', activity_type: 'fishing' },
  { id: 'r-hot-ok', title: 'Источник у дороги', zone: 'avachinsky', activity_type: 'hot_spring' },
];
/** Данные безопасности по id — то, что читает `fetchSelfSafety`. */
const SAFETY: Record<string, Record<string, unknown>> = {
  'r-trek-ok':   { id: 'r-trek-ok', is_route: true, route_difficulty: 'easy', mchs_registration_required: false, route_registration_required: false, has_profile: false, sat_communicator_required: null, place_registration_required: null },
  'r-trek-mchs': { id: 'r-trek-mchs', is_route: true, route_difficulty: 'moderate', mchs_registration_required: true, route_registration_required: false, has_profile: false, sat_communicator_required: null, place_registration_required: null },
  'r-trek-hard': { id: 'r-trek-hard', is_route: true, route_difficulty: 'extreme', mchs_registration_required: false, route_registration_required: false, has_profile: false, sat_communicator_required: null, place_registration_required: null },
  'r-trek-nodata': { id: 'r-trek-nodata', is_route: false, route_difficulty: null, mchs_registration_required: null, route_registration_required: null, has_profile: false, sat_communicator_required: null, place_registration_required: null },
  'r-fish-ok':   { id: 'r-fish-ok', is_route: false, route_difficulty: null, mchs_registration_required: null, route_registration_required: null, has_profile: true, sat_communicator_required: false, place_registration_required: false },
  'r-hot-ok':    { id: 'r-hot-ok', is_route: false, route_difficulty: null, mchs_registration_required: null, route_registration_required: null, has_profile: true, sat_communicator_required: false, place_registration_required: false },
  'r-volc-self': { id: 'r-volc-self', is_route: true, route_difficulty: 'easy', mchs_registration_required: false, route_registration_required: false, has_profile: false, sat_communicator_required: null, place_registration_required: null },
};
let safetyFails = false;
/** Отказ чтения тревог платформы (`FROM safety_alerts`) — аудит 07.11, S1. */
let alertsFail = false;
/** Живые тревоги парков по ссылкам дней — то, что читает проверка парков плана. */
let PARK_ALERTS: unknown[] = [];
/** Строки сводки МЧС — то, что читает loadActiveWarnings. */
let MCHS_ROWS: unknown[] = [];

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM safety_alerts')) {
        if (alertsFail) throw Object.assign(new Error('db down'), { code: '57P01' });
        return { rows: [] };
      }
      if (sql.includes('WITH refs AS')) return { rows: PARK_ALERTS };
      if (sql.includes("alert_type IN ('volcanic_eruption', 'road_closure')")) return { rows: MCHS_ROWS };
      if (sql.includes('FROM agent_route_knowledge')) {
        const [zone, act, limit] = params as [string, string, number];
        const rows = ROUTES.filter((r) => r.zone === zone && r.activity_type === act)
          .slice(0, limit)
          .map((r) => ({ ...r, lat: 53.1, lng: 158.6, location_type: null }));
        return { rows };
      }
      if (sql.includes('location_safety_profile')) {
        if (safetyFails) throw Object.assign(new Error('db down'), { code: '57P01' });
        const ids = params[0] as string[];
        return { rows: ids.filter((id) => SAFETY[id]).map((id) => SAFETY[id]) };
      }
      return { rows: [] };
    }),
  },
}));

import { recommendTrip, SAFETY_ALERTS_UNREAD_NOTE, type TripProfile } from '@/lib/planner/engine';
import { planWarningLines } from '@/lib/kuzmich/trip-plan-tool';
import {
  mchsBeforeTripNote, relevantUntilOf, splitWarningsForTrip, warningsFromRows,
} from '@/lib/safety/mchs-bulletin';

const NEXT_JULY = new Date().getUTCFullYear() + 1;
const isoIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const atIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const GORELY: Tour = { tourId: 't-gor', title: 'Горелый и пещеры', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' };
const AVACHA: Tour = { tourId: 't-ava', title: 'Восхождение на Авачинский', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' };
const FISHING: Tour = { tourId: 't-fish-ava', title: 'Летняя рыбалка', durationHours: 10, zone: 'avachinsky', activityType: 'fishing' };

const PROOF: TripProfile = {
  interests: ['volcano', 'fishing'],
  arrivalDate: `${NEXT_JULY}-07-10`,
  departureDate: `${NEXT_JULY}-07-14`,
  adults: 2,
  children: [],
  fitnessLevel: 'moderate',
  budgetTier: 'comfort',
};

const activity = (rec: Awaited<ReturnType<typeof recommendTrip>>) => rec.days.filter((d) => d.type === 'activity');

beforeEach(() => {
  TOURS = { 'avachinsky:volcano': [GORELY], 'avachinsky:fishing': [FISHING] };
  SLOTS = { 't-fish-ava': 14 };
  SLOT_DATES = {};
  KEEPS = {};
  PARK_ALERTS = [];
  MCHS_ROWS = [];
  safetyFails = false;
  alertsFail = false;
});

describe('просьба получает день: рыбалка не тонет в «свободном дне»', () => {
  it('план пруфа: день рыбалки в Авачинской зоне, путёвка — к нему, свободного дня нет', async () => {
    const rec = await recommendTrip(PROOF);
    const fishing = activity(rec).filter((d) => d.activityType === 'fishing');
    expect(fishing.map((d) => d.realTour?.tourId)).toEqual(['t-fish-ava']);
    expect(rec.days.some((d) => d.title.startsWith('Свободный день'))).toBe(false);
    expect(rec.warnings.some((w) => w.type === 'license')).toBe(true);
    // Западная зона не влезла, но рыбалка в плане есть — это справка, не просьба без ответа.
    const western = rec.warnings.find((w) => w.type === 'zone_days' && w.message.includes('Западная'));
    expect(western?.severity).toBe('info');
  });

  it('подготовка в плане — «в расчёте плана», а не «у вас указана» (ai-debug run 24)', async () => {
    // В чате подготовку никто не называет: движок считает на среднюю, и
    // «у вас указана средняя» Кузьмич пересказывал как слова человека.
    const rec = await recommendTrip(PROOF);
    const fitness = rec.warnings.filter((w) => w.type === 'fitness').map((w) => w.message);
    expect(fitness.length).toBeGreaterThan(0);
    for (const line of fitness) {
      expect(line).toMatch(/нужна хорошая подготовка, в расчёте плана — средняя/);
      expect(line).not.toMatch(/у вас/);
    }
  });

  it('дня не хватило — агент видит это в «Важно», а строки о путёвке нет', async () => {
    const rec = await recommendTrip({ ...PROOF, departureDate: `${NEXT_JULY}-07-12` });
    expect(activity(rec).some((d) => d.activityType === 'fishing')).toBe(false);
    const lines = planWarningLines(rec);
    // «Интерес … не вошёл» (08.11) или «зона … не вошла» — с причиной.
    expect(lines.some((l) => /рыбалка/i.test(l) && /не вош(?:ла|ёл)/.test(l))).toBe(true);
    expect(rec.warnings.some((w) => w.type === 'license')).toBe(false);
  });
});

describe('тур с местами впереди тура без мест (план без выбора стиля)', () => {
  it('есть вулкан с местами — Горелый без мест на день не встаёт', async () => {
    TOURS['avachinsky:volcano'] = [GORELY, AVACHA];
    SLOTS = { 't-ava': 6, 't-fish-ava': 14 };
    const rec = await recommendTrip(PROOF);
    const volcano = activity(rec).filter((d) => d.activityType === 'volcano');
    expect(volcano.map((d) => d.realTour?.tourId)).toEqual(['t-ava']);
    expect(rec.days.some((d) => d.realTour?.tourId === 't-gor')).toBe(false);
  });

  it('другого нет — тур без выездов в дни поездки не ставится, а назван в «Важно» (волна 3 аудита 07.11, 3.2)', async () => {
    // До волны 3 Горелый вставал с «мест нет» и шёл в смету: валидатор
    // дат плана должен блокировать тур без выезда, а не подписывать его.
    const rec = await recommendTrip(PROOF);
    expect(rec.days.some((d) => d.realTour?.tourId === 't-gor')).toBe(false);
    const line = rec.warnings.find((w) => w.type === 'tour_dates');
    expect(line?.message).toBe('В ваши даты у тура нет выездов — его не ставили: «Горелый и пещеры».');
    expect(planWarningLines(rec)).toContain(line?.message);
  });
});

describe('тур — только на день, где у него есть выезд (волна 3 аудита 07.11, 3.2; пруф с прода 07.11)', () => {
  // Пруф: план на 7 дней с 10.07.2027, вулканы. «Восхождение на вулкан
  // Горелый и лавовые пещеры» (выезды 15 и 16.07) стоял днём 2 (11.07) с
  // «в ваши даты свободных мест нет», а день 6 (15.07) был свободным; тур
  // был посчитан в смете. Авачинский без календаря — дату подтверждает оператор.
  const SEVEN: TripProfile = { ...PROOF, interests: ['volcano'], departureDate: `${NEXT_JULY}-07-16` };
  const prodCase = (gorDates: string[]) => {
    TOURS = { 'avachinsky:volcano': [GORELY, AVACHA] };
    SLOTS = { 't-gor': 4 };
    SLOT_DATES = { 't-gor': gorDates.map((d) => `${NEXT_JULY}-${d}`) };
    KEEPS = { 't-ava': false };
  };

  it('выезд внутри поездки — тур встаёт на свой день, а не на первый день вулканов', async () => {
    prodCase(['07-15', '07-16']);
    const rec = await recommendTrip(SEVEN);
    const gor = rec.days.filter((d) => d.realTour?.tourId === 't-gor');
    expect(gor).toHaveLength(1);
    expect(gor[0].day).toBe(6);
    expect(gor[0].availability).toBe('open');
    expect(gor[0].availableDate).toBe(`${NEXT_JULY}-07-15`);
    // Дата, ответ наличия и время проверки — доказательство места (принцип 2,
    // 07.11): время — этой сборки плана, а не выдуманное.
    const checked = Date.parse(gor[0].availabilityCheckedAt ?? '');
    expect(Math.abs(Date.now() - checked)).toBeLessThan(60_000);
    // У дня без тура занятость не читалась — и времени проверки нет.
    expect(rec.days.filter((d) => !d.realTour).every((d) => d.availabilityCheckedAt === undefined)).toBe(true);
    // Тур с календарём не стоит ни на одном дне без своего выезда. У
    // Авачинского календаря нет: «дату подтверждает оператор» — его исход.
    expect(rec.days.some((d) => d.realTour?.tourId === 't-gor' && d.availability !== 'open')).toBe(false);
    expect(rec.days.find((d) => d.day === 2)?.realTour?.tourId).toBe('t-ava');
    expect(rec.warnings.some((w) => w.type === 'tour_dates')).toBe(false);
  });

  it('выезд — в день после блока вулканов: тур встаёт в этот день, а не свободным днём в городе', async () => {
    // Раскладка пруфа: треккинг ушёл в Восточную зону и не влез связкой —
    // блок вулканов кончился днём 5, день 6 (15.07) оставался свободным.
    prodCase(['07-15', '07-16']);
    const rec = await recommendTrip({ ...SEVEN, interests: ['volcano', 'trekking'] });
    expect(rec.warnings.some((w) => w.type === 'zone_days' && w.message.includes('Восточная'))).toBe(true);
    const gor = rec.days.filter((d) => d.realTour?.tourId === 't-gor');
    expect(gor.map((d) => [d.day, d.availableDate])).toEqual([[6, `${NEXT_JULY}-07-15`]]);
    expect(rec.days.some((d) => d.title.startsWith('Свободный день'))).toBe(false);
  });

  it('выезд только в день вылета — тур не встаёт, назван с датой и в смету не идёт', async () => {
    prodCase(['07-16']);
    const rec = await recommendTrip(SEVEN);
    expect(rec.days.some((d) => d.realTour?.tourId === 't-gor')).toBe(false);
    expect(rec.warnings.find((w) => w.type === 'tour_dates')?.message).toBe(
      'Не встали в план — в дни этих занятий у тура нет выезда: «Горелый и пещеры» (выезды 16 июля). Хотите тур — переставьте день плана на дату выезда.',
    );
    // В смете тур — только поставленный: по цене Авачинского, один раз.
    expect(rec.priceBreakdown.activityPricing.tourPriced).toBe(1);
  });

  it('тур без календаря встаёт только в сезоне выездов (E6)', async () => {
    TOURS = { 'avachinsky:volcano': [{ ...AVACHA, seasonStart: `${NEXT_JULY}-08-01`, seasonEnd: `${NEXT_JULY}-09-30` }] };
    SLOTS = {};
    KEEPS = { 't-ava': false };
    const rec = await recommendTrip(SEVEN);
    expect(rec.days.some((d) => d.realTour?.tourId === 't-ava')).toBe(false);
    expect(rec.warnings.find((w) => w.type === 'tour_dates')?.message).toContain('«Восхождение на Авачинский»');
    // Сезон на даты поездки — тур на месте.
    TOURS = { 'avachinsky:volcano': [{ ...AVACHA, seasonStart: `${NEXT_JULY}-06-01`, seasonEnd: `${NEXT_JULY}-09-30` }] };
    const inSeason = await recommendTrip(SEVEN);
    expect(inSeason.days.some((d) => d.realTour?.tourId === 't-ava')).toBe(true);
  });
});

describe('сводка МЧС судится по датам поездки', () => {
  const ROWS = () => [
    // Вулкан без срока, сводка вчера: говорит о ближайших двух неделях.
    { alert_type: 'volcanic_eruption', title: 'Вулкан Мутновский', description: 'Рекомендовано не приближаться',
      source_url: 'https://example.org/mchs/1', volcano_name: 'Мутновский', expires_iso: null, published_iso: atIn(-1) },
    // Сводка со сроком до завтра.
    { alert_type: 'volcanic_eruption', title: 'Вулкан Безымянный', description: 'Рекомендовано не приближаться',
      source_url: 'https://example.org/mchs/2', volcano_name: 'Безымянный', expires_iso: atIn(1), published_iso: atIn(-1) },
  ];

  it('поездка через полгода: ни день, ни общая сводка не несут сегодняшнего МЧС; агенту — «проверьте ближе к выезду»', async () => {
    MCHS_ROWS = ROWS();
    const rec = await recommendTrip(PROOF);
    expect(rec.days.flatMap((d) => d.dayWarnings ?? []).some((w) => w.startsWith('МЧС:'))).toBe(false);
    expect(rec.warnings.some((w) => w.type === 'mchs')).toBe(false);
    const note = rec.warnings.find((w) => w.message.startsWith('Сводки МЧС на сегодня'));
    expect(note?.message).toMatch(/Мутновский/);
    expect(note?.message).toMatch(/Безымянный/);
    expect(planWarningLines(rec)).toContain(note?.message);
  });

  it('поездка через пять дней: действующая сводка — на дне своей зоны, кончившаяся — строкой', async () => {
    MCHS_ROWS = ROWS();
    const rec = await recommendTrip({
      ...PROOF, interests: ['hot_spring'], arrivalDate: isoIn(5), departureDate: isoIn(9),
    });
    const dayLines = rec.days.flatMap((d) => d.dayWarnings ?? []);
    expect(dayLines.some((w) => w.includes('МЧС: к вулкану Мутновский'))).toBe(true);
    expect(dayLines.some((w) => w.includes('Безымянный'))).toBe(false);
    expect(rec.warnings.find((w) => w.type === 'mchs')?.message).toMatch(/Мутновский/);
    expect(rec.warnings.find((w) => w.message.startsWith('Сводки МЧС на сегодня'))?.message).toMatch(/Безымянный/);
  });

  it('срок строки: срок — по дню Камчатки; без срока — горизонт от сводки; ничего — не известно', () => {
    expect(relevantUntilOf({ expires_iso: '2026-11-05T18:00:00.000Z' })).toBe('2026-11-06');
    expect(relevantUntilOf({ published_iso: '2026-11-05T00:00:00.000Z' })).toBe('2026-11-19');
    expect(relevantUntilOf({})).toBeNull();
    const [w] = warningsFromRows([{ alert_type: 'volcanic_eruption', title: 'Вулкан Шивелуч', volcano_name: 'Шивелуч' }]);
    expect(splitWarningsForTrip([w], '2030-07-10').forTrip).toHaveLength(1);
    expect(splitWarningsForTrip([w], null).forTrip).toHaveLength(1);
    expect(mchsBeforeTripNote([w], '2030-07-10')).toMatch(/с 10\.07/);
  });
});

describe('что план говорит о себе (аудит планировщика 07.11, S1 и E10)', () => {
  it('тревоги платформы не прочитались — строка в плане и в «Важно» агента, причина в логе', async () => {
    alertsFail = true;
    const errLog: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errLog.push(args); };
    let rec: Awaited<ReturnType<typeof recommendTrip>>;
    try {
      rec = await recommendTrip(PROOF);
    } finally {
      console.error = orig;
    }
    expect(rec.warnings.filter((w) => w.message === SAFETY_ALERTS_UNREAD_NOTE)).toEqual([
      { type: 'safety', severity: 'important', message: SAFETY_ALERTS_UNREAD_NOTE },
    ]);
    expect(planWarningLines(rec).slice(0, 8)).toContain(SAFETY_ALERTS_UNREAD_NOTE);
    expect(errLog.some((a) => a.join(' ').includes('57P01'))).toBe(true);
  });

  it('тревоги прочитаны, их просто нет — строки «не прочитаны» нет', async () => {
    const rec = await recommendTrip(PROOF);
    expect(rec.warnings.some((w) => w.message === SAFETY_ALERTS_UNREAD_NOTE)).toBe(false);
  });

  it('вертолёт: «запасной день добавлен» — только когда он стоит в плане', async () => {
    const heli = (departureDate: string) => recommendTrip({ ...PROOF, interests: ['helicopter'], departureDate });
    const heliNote = (rec: Awaited<ReturnType<typeof recommendTrip>>) =>
      rec.warnings.find((w) => w.type === 'weather' && w.message.startsWith('Вертолётные экскурсии'))?.message;

    const week = await heli(`${NEXT_JULY}-07-16`);
    expect(week.days.some((d) => d.type === 'buffer')).toBe(true);
    expect(heliNote(week)).toMatch(/В план добавлен запасной день\.$/);
    // Вид — словами, а не ключом движка «(helicopter)».
    expect(heliNote(week)).toMatch(/^Вертолётные экскурсии: /);
    const geysers = await recommendTrip({ ...PROOF, interests: ['geyser'], departureDate: `${NEXT_JULY}-07-16` });
    expect(heliNote(geysers)).toMatch(/^Вертолётные экскурсии \(гейзеры\): /);

    const twoDays = await heli(`${NEXT_JULY}-07-11`);
    expect(twoDays.days.some((d) => d.type === 'buffer')).toBe(false);
    expect(heliNote(twoDays)).toMatch(/Запасного дня в плане нет/);
    expect(heliNote(twoDays)).not.toMatch(/добавлен запасной день/);
  });
});

describe('несколько интересов в одной зоне: у каждого свои туры (независимая проверка 07.11, Б1)', () => {
  it('день рыбалки получает тур рыбалки, день вулкана — тур вулкана', async () => {
    TOURS = { 'avachinsky:volcano': [GORELY, AVACHA], 'avachinsky:fishing': [FISHING] };
    SLOTS = { 't-gor': 10, 't-ava': 10, 't-fish-ava': 10 };
    const rec = await recommendTrip({ ...PROOF, departureDate: `${NEXT_JULY}-07-16` });
    const kinds: Record<string, string> = { 't-gor': 'volcano', 't-ava': 'volcano', 't-fish-ava': 'fishing' };
    const withTour = activity(rec).filter((d) => d.realTour);
    expect(withTour.length).toBeGreaterThan(0);
    for (const d of withTour) expect([d.title, kinds[d.realTour!.tourId]]).toEqual([d.title, d.activityType]);
    expect(withTour.some((d) => d.activityType === 'fishing' && d.realTour?.tourId === 't-fish-ava')).toBe(true);
  });
});
