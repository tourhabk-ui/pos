/**
 * Сторож: стиль поездки и дни отдыха доходят до движка и исполняются честно.
 *
 * Владелец 26.09: в форме планировщика — «Сам / С оператором / Вперемешку»
 * и «Дни отдыха». Движок и раньше собирал поездку вперемешку (тур оператора,
 * при его отсутствии — самостоятельный выход, при отсутствии обоих — «на
 * выбор»), но выбрать СТИЛЬ человек не мог.
 *
 * Что держит сторож — поведением, на настоящем `recommendTrip` с подменённым
 * хранилищем:
 *
 *   — «Вперемешку» и отсутствие стиля дают РОВНО прежний план (снимок снят
 *     с движка до правки 26.09);
 *   — «Сам» не ставит ни одного тура оператора и никогда не ставит сам
 *     маршрут, который по данным требует гида или группы с регистрацией МЧС,
 *     или о безопасности которого данных нет, — и называет причину;
 *   — «С оператором» ставит туры с местами на даты, а где тура нет —
 *     говорит об этом (день-подмена помечена на самом дне);
 *   — дни отдыха исполняются и не выходят за срок поездки.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Подмена хранилища ────────────────────────────────────────────────────

interface Tour {
  tourId: string; title: string; durationHours: number | null; zone: string; activityType: string;
}
const TOURS: Record<string, Tour[]> = {
  'avachinsky:volcano': [
    { tourId: 't-volc', title: 'Восхождение на Авачинский', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' },
  ],
  'western:fishing': [
    { tourId: 't-fish-free', title: 'Рыбалка на Опале', durationHours: 8, zone: 'western', activityType: 'fishing' },
    { tourId: 't-fish-full', title: 'Рыбалка на Большой', durationHours: 8, zone: 'western', activityType: 'fishing' },
  ],
};
/** Свободные места по туру на даты поездки. Нет ключа — мест нет. */
let SLOTS: Record<string, number> = {};

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 4.5, operatorReviewCount: 3,
    operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 10000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours, difficulty: null,
    weatherDependent: false, seasonStart: null, seasonEnd: null, included: null,
    lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  fetchAvailabilityForTour: vi.fn(async (tourId: string, from: string) =>
    SLOTS[tourId] ? [{ date: from, availableSlots: 10, bookedSlots: 10 - SLOTS[tourId], remaining: SLOTS[tourId], priceOverride: null }] : []),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
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

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM safety_alerts')) return { rows: [] };
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

import { recommendTrip, type TripProfile } from '@/lib/planner/engine';
import {
  activitySelfBlocker, routeSelfBlocker, fitRestDays, SELF_SAFETY_UNKNOWN,
} from '@/lib/planner/travel-style';

const BASE: TripProfile = {
  interests: ['volcano', 'trekking', 'fishing', 'hot_spring'],
  arrivalDate: '2026-08-03',
  departureDate: '2026-08-12',
  adults: 2,
  children: [],
  fitnessLevel: 'moderate',
  budgetTier: 'comfort',
};

const shape = (days: Array<{ type: string; activityMode?: string; title: string; zone: string }>) =>
  days.map((d) => `${d.type}|${d.activityMode ?? '-'}|${d.zone}|${d.title}`);

beforeEach(() => {
  SLOTS = { 't-volc': 6, 't-fish-free': 4 };
  safetyFails = false;
  aiPrompts.length = 0;
});

/**
 * Снимки плана «Вперемешку» / без стиля. До 26.09 здесь стоял снимок движка
 * ДО правки («Вперемешку» обязано было не меняться). Решение владельца 26.09
 * («согласен»): самостоятельный день и в «Вперемешку» — только проверенный,
 * как в «Сам». Отличия от прежнего снимка ровно такие:
 *   - «Подход к Козельскому» (выход на вулкан без гида) больше не день «сам»;
 *   - «Перевал с регистрацией» (МЧС), «Траверс хребта» (extreme) и «Место без
 *     профиля» (данных нет) — тоже; на их месте общие дни, туры не тронуты.
 */
const GOLDEN_MIXED: string[] = [
  'arrival|-|avachinsky|Прилёт днём. Размещение, акклиматизация. Прогулка по городу',
  'activity|operator|avachinsky|Восхождение на Авачинский',
  'rest|-|avachinsky|День отдыха. Термальные источники',
  'activity|open|avachinsky|треккинг — Авачинская зона',
  'activity|open|avachinsky|рыбалка — Авачинская зона',
  'travel|-|avachinsky|Переезд: Авачинская зона → Восточная зона',
  'activity|open|eastern|треккинг — Восточная зона',
  'activity|open|eastern|горячие источники — Восточная зона',
  'departure|-|avachinsky|Сборы утром. Трансфер в аэропорт, вылет днём',
];

/** Второй снимок: треккинг первым — день материала «сам». */
const TREK: TripProfile = { ...BASE, interests: ['trekking', 'hot_spring'] };
const GOLDEN_TREK: string[] = [
  'arrival|-|avachinsky|Прилёт днём. Размещение, акклиматизация. Прогулка по городу',
  'activity|self|avachinsky|Тропа к Сухой речке',
  'activity|open|avachinsky|горячие источники — Авачинская зона',
  'activity|open|avachinsky|треккинг — Авачинская зона',
  'travel|-|avachinsky|Переезд: Авачинская зона → Восточная зона',
  'activity|open|eastern|треккинг — Восточная зона',
  'activity|open|eastern|горячие источники — Восточная зона',
  'travel|-|avachinsky|Возвращение: Восточная зона → Петропавловск',
  'departure|-|avachinsky|Сборы утром. Трансфер в аэропорт, вылет днём',
];

describe('«Вперемешку» — туры как прежде, «сам» только проверенное (26.09)', () => {
  it('без стиля план совпадает со снимком', async () => {
    const rec = await recommendTrip(BASE);
    expect(shape(rec.days)).toEqual(GOLDEN_MIXED);
  });

  it('второй снимок тоже', async () => {
    const rec = await recommendTrip(TREK);
    expect(shape(rec.days)).toEqual(GOLDEN_TREK);
  });

  it('тур оператора остаётся; маршрут, требующий гида, МЧС или без данных, днём «сам» не встаёт', async () => {
    const base = await recommendTrip(BASE);
    expect(base.days.some((d) => d.activityMode === 'operator' && d.title === 'Восхождение на Авачинский')).toBe(true);
    expect(base.days.map((d) => d.title)).not.toContain('Подход к Козельскому');
    const trek = await recommendTrip(TREK);
    const titles = trek.days.map((d) => d.title);
    expect(titles).toContain('Тропа к Сухой речке');
    for (const t of ['Перевал с регистрацией', 'Траверс хребта', 'Место без профиля']) expect(titles).not.toContain(t);
  });

  it('исключённое названо предупреждением — оно доходит до Кузьмича и MCP', async () => {
    const trek = await recommendTrip(TREK);
    const w = trek.warnings.find((x) => x.message.startsWith('Без гида не ставим'));
    expect(w?.type).toBe('safety');
    expect(w?.severity).toBe('important');
    expect(w?.message).toContain('Перевал с регистрацией');
    expect(w?.message).toContain('МЧС');
    // У «Сам» то же говорят заметки пожеланий — второй раз не повторяем.
    const self = await recommendTrip({ ...TREK, travelStyle: 'self' });
    expect(self.warnings.some((x) => x.message.startsWith('Без гида не ставим'))).toBe(false);
  });

  it('общий день по активности «только с гидом» говорит это на самом дне', async () => {
    const rec = await recommendTrip({ ...BASE, interests: ['volcano'], arrivalDate: '2027-08-01', departureDate: '2027-08-12' });
    const generic = rec.days.find((d) => d.activityMode === 'open' && d.activityType === 'volcano');
    expect(generic?.dayWarnings[0]).toMatch(/^Только с гидом: .*Ищите тур оператора\.$/);
  });

  it('не прочиталась безопасность мест — самостоятельных маршрутов нет, и это сказано', async () => {
    safetyFails = true;
    const rec = await recommendTrip(TREK);
    const routeTitles = new Set(ROUTES.map((r) => r.title));
    expect(rec.days.some((d) => routeTitles.has(d.title))).toBe(false);
    expect(rec.warnings.some((w) => w.message.startsWith('Не удалось проверить безопасность мест'))).toBe(true);
  });
});

describe('«Вперемешку» равно отсутствию стиля', () => {
  it('план, предупреждения и смета совпадают целиком', async () => {
    for (const profile of [BASE, TREK]) {
      const none = await recommendTrip(profile);
      const mixed = await recommendTrip({ ...profile, travelStyle: 'mixed' });
      const zeroRest = await recommendTrip({ ...profile, travelStyle: 'mixed', restDays: 0 });
      expect(mixed.days).toEqual(none.days);
      expect(mixed.warnings).toEqual(none.warnings);
      expect(mixed.priceBreakdown).toEqual(none.priceBreakdown);
      expect(zeroRest.days).toEqual(none.days);
      // Без просьбы нового поля нет вовсе; с просьбой «вперемешку» — есть и пусто.
      expect(none.preferences).toBeUndefined();
      expect(mixed.preferences?.notes).toEqual([]);
    }
  });
});

describe('«Сам»', () => {
  it('ни одного дня с туром оператора', async () => {
    // Рыбалка без гида допустима, а тур на неё есть: в «Вперемешку» он встаёт,
    // в «Сам» — нет. Без этого профиля сторож не отличил бы «туров нет» от
    // «туры не берём».
    const FISH: TripProfile = { ...BASE, interests: ['fishing'] };
    const mixed = await recommendTrip(FISH);
    expect(mixed.days.some((d) => d.activityMode === 'operator')).toBe(true);
    for (const profile of [BASE, TREK, FISH]) {
      const rec = await recommendTrip({ ...profile, travelStyle: 'self' });
      expect(rec.days.some((d) => d.realTour || d.activityMode === 'operator')).toBe(false);
    }
  });

  it('маршрут, требующий гида, МЧС или без данных, самостоятельным днём не встаёт', async () => {
    const rec = await recommendTrip({ ...TREK, travelStyle: 'self' });
    const titles = rec.days.map((d) => d.title);
    expect(titles).toContain('Тропа к Сухой речке');
    expect(titles).not.toContain('Перевал с регистрацией'); // mchs_registration_required
    expect(titles).not.toContain('Траверс хребта');         // difficulty extreme
    expect(titles).not.toContain('Место без профиля');      // данных нет — «не знаем»
    const text = rec.preferences?.notes.map((n) => n.message).join('\n') ?? '';
    expect(text).toContain('Перевал с регистрацией');
    expect(text).toContain('МЧС');
    expect(text).toContain('Место без профиля');
  });

  it('активность, куда только с гидом, не ставится и называется с причиной', async () => {
    const rec = await recommendTrip({ ...BASE, travelStyle: 'self' });
    // В «Вперемешку» здесь стоял самостоятельный «Подход к Козельскому» —
    // выход на вулкан без гида. В «Сам» его быть не должно.
    expect(rec.days.map((d) => d.title)).not.toContain('Подход к Козельскому');
    expect(rec.days.some((d) => d.activityType === 'volcano')).toBe(false);
    const note = rec.preferences?.notes.find((n) => n.message.includes('вулканы'));
    expect(note?.status).toBe('partial');
  });

  it('не прочиталась безопасность мест — самостоятельных маршрутов нет, и это сказано', async () => {
    safetyFails = true;
    const rec = await recommendTrip({ ...TREK, travelStyle: 'self' });
    const routeTitles = new Set(ROUTES.map((r) => r.title));
    expect(rec.days.some((d) => routeTitles.has(d.title))).toBe(false);
    expect(rec.preferences?.notes.some((n) => n.message.includes('Не удалось проверить безопасность'))).toBe(true);
  });
});

describe('«С оператором»', () => {
  it('ставит туры со свободными местами, тур без мест — нет', async () => {
    const rec = await recommendTrip({ ...BASE, travelStyle: 'operator' });
    const tours = rec.days.filter((d) => d.realTour).map((d) => d.realTour?.tourId);
    expect(tours).toContain('t-volc');
    expect(tours).not.toContain('t-fish-full');
    for (const d of rec.days) {
      if (d.type === 'activity' && d.activityMode !== 'operator') {
        expect(d.dayWarnings.length, `день без тура и без пометки: ${d.title}`).toBeGreaterThan(0);
      }
    }
  });

  it('активный день без тура несёт пометку на самом дне', async () => {
    const rec = await recommendTrip({ ...TREK, travelStyle: 'operator' });
    const bare = rec.days.filter((d) => d.type === 'activity' && d.activityMode !== 'operator');
    expect(bare.length).toBeGreaterThan(0);
    for (const d of bare) expect(d.dayWarnings.join(' '), d.title).toMatch(/тур(а)? оператора/i);
    // Туров нет совсем — это «не выполнено», а не «выполнено».
    expect(rec.preferences?.notes.some((n) => n.status === 'not_honoured')).toBe(true);
  });

  it('подмена тура самостоятельным днём проходит ту же проверку безопасности', async () => {
    const rec = await recommendTrip({ ...TREK, travelStyle: 'operator' });
    const titles = rec.days.map((d) => d.title);
    expect(titles).not.toContain('Перевал с регистрацией');
    expect(titles).not.toContain('Траверс хребта');
  });

  it('нет мест ни у одного тура — не выполнено и сказано', async () => {
    SLOTS = {};
    const rec = await recommendTrip({ ...BASE, travelStyle: 'operator' });
    expect(rec.days.some((d) => d.realTour)).toBe(false);
    const msgs = rec.preferences?.notes.map((n) => n.message).join('\n') ?? '';
    expect(msgs).toContain('нет свободных мест');
    expect(rec.preferences?.notes.some((n) => n.status === 'not_honoured')).toBe(true);
  });
});

describe('дни отдыха', () => {
  it('исполняются, стоят между активными днями и не выходят за срок', async () => {
    const rec = await recommendTrip({ ...TREK, restDays: 2 });
    const rest = rec.days.filter((d) => d.type === 'rest').length;
    expect(rest).toBeGreaterThanOrEqual(2);
    expect(rec.days.length).toBeLessThanOrEqual(9);
    expect(rec.preferences?.restDaysPlanned).toBe(rest);
    expect(rec.preferences?.notes.find((n) => n.topic === 'rest_days')?.status).toBe('honoured');
    const firstRest = rec.days.findIndex((d) => d.type === 'rest');
    expect(rec.days.slice(firstRest + 1).some((d) => d.type === 'activity')).toBe(true);
  });

  it('просьба больше срока — ставится что влезло и говорится словами', async () => {
    const short: TripProfile = { ...TREK, arrivalDate: '2026-08-03', departureDate: '2026-08-07', restDays: 10 };
    const rec = await recommendTrip(short);
    expect(rec.days.length).toBeLessThanOrEqual(4);
    expect(rec.days.some((d) => d.type === 'activity')).toBe(true);
    const note = rec.preferences?.notes.find((n) => n.topic === 'rest_days');
    expect(note?.status).not.toBe('honoured');
    expect(note?.message).toContain('из 10');
  });
});

describe('здоровье не уходит в модель', () => {
  it('заметки о здоровье и подвижность не попадают в промпт', async () => {
    await recommendTrip({ ...BASE, healthNotes: 'астма, больное колено', mobilityLevel: 'wheelchair' });
    expect(aiPrompts.length).toBeGreaterThan(0);
    const all = aiPrompts.join('\n');
    expect(all).not.toContain('астма');
    expect(all).not.toContain('колено');
    expect(all).not.toMatch(/безбарьерн|подвижност|коляск/i);
  });

  it('а человеку предупреждение о подвижности показывается', async () => {
    const rec = await recommendTrip({ ...BASE, mobilityLevel: 'limited' });
    expect(rec.warnings.some((w) => w.message.includes('Ограниченная подвижность'))).toBe(true);
  });
});

describe('правила «Сам» читают наши данные, а не выдумывают', () => {
  it('куда без гида нельзя — по транспорту, разрешению, правилам и риску', () => {
    // helicopter/geyser — только вертолёт; boat_trip — только катер;
    // bears — разрешение заказника и «только с гидом»; mountain — «обязателен
    // опытный гид»; volcano и river (rafting) — высокий риск lib/safety/tour-risk.
    for (const i of ['helicopter', 'geyser', 'boat_trip', 'bears', 'mountain', 'volcano', 'river']) {
      expect(activitySelfBlocker(i), i).not.toBeNull();
    }
    for (const i of ['trekking', 'fishing', 'hot_spring', 'thermal', 'sea', 'snowmobile']) {
      expect(activitySelfBlocker(i), i).toBeNull();
    }
  });

  it('нет данных о месте — «не знаем», и это отказ', () => {
    expect(routeSelfBlocker(undefined)).toBe(SELF_SAFETY_UNKNOWN);
    const place = {
      isRoute: false, routeDifficulty: null, mchsRegistrationRequired: null, routeRegistrationRequired: null,
      hasProfile: false, satCommunicatorRequired: null, placeRegistrationRequired: null,
    };
    expect(routeSelfBlocker(place)).toBe(SELF_SAFETY_UNKNOWN);
    expect(routeSelfBlocker({ ...place, hasProfile: true, satCommunicatorRequired: false, placeRegistrationRequired: false })).toBeNull();
    expect(routeSelfBlocker({ ...place, hasProfile: true, satCommunicatorRequired: true })).toMatch(/спутников/);
  });

  it('маршрут с регистрацией МЧС или опасной сложностью — отказ', () => {
    const route = {
      isRoute: true, routeDifficulty: 'easy', mchsRegistrationRequired: false, routeRegistrationRequired: false,
      hasProfile: false, satCommunicatorRequired: null, placeRegistrationRequired: null,
    };
    expect(routeSelfBlocker(route)).toBeNull();
    expect(routeSelfBlocker({ ...route, mchsRegistrationRequired: true })).toMatch(/МЧС/);
    for (const d of ['hard', 'difficult', 'extreme', 'expert']) {
      expect(routeSelfBlocker({ ...route, routeDifficulty: d }), d).not.toBeNull();
    }
  });

  it('дни отдыха не съедают поездку целиком', () => {
    expect(fitRestDays(undefined, 6)).toBe(0);
    expect(fitRestDays(2, 6)).toBe(2);
    expect(fitRestDays(10, 6)).toBe(5);
    expect(fitRestDays(3, 1)).toBe(0);
    expect(fitRestDays(-2, 6)).toBe(0);
  });
});
