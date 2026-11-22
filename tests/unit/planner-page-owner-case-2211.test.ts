/**
 * Кейс владельца из /planner (24.11–04.12, двое; 22.11) — тот же движок
 * `recommendTrip`, путь экрана планера (без 'plain', LLM подменён), моки без ПД:
 *  - в Западной зоне есть только трёхдневный тур, а раскладка дала ей день на
 *    месте: план не едет туда ради пустых дней, тур назван «не поместились»;
 *  - пятидневный термальный тур встаёт блоком «Дни 2–6», пустых дней нет;
 *  - «вертолёт без оператора — не сезон» не пишется, когда вертолёт с
 *    оператором в плане есть;
 *  - заметки о плане — одним блоком под днями (PlanNotes), сверху только
 *    критичное.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tour { tourId: string; title: string; zone: string; activityType: string; durationHours?: number; seasonStart?: string | null; seasonEnd?: string | null }
let TOURS: Record<string, Tour[]> = {};
let KEEPS: Record<string, boolean | null> = {};
let ON_REQUEST: Set<string> | null = new Set();
const onRequestCalls: number[] = [];

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: null, operatorReviewCount: 0,
    operatorVerified: false, tourRating: null, tourReviewCount: 0, basePrice: 20000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours ?? 10, difficulty: null,
    weatherDependent: false, seasonStart: t.seasonStart ?? null, seasonEnd: t.seasonEnd ?? null, included: null,
    lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  // Свободных дат нет ни у одного тура: у тура без календаря их нет никогда.
  fetchAvailabilityForTour: vi.fn(async () => []),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  // Записью оператора (строками расписания) октябрь не открыт ни для чего.
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => { onRequestCalls.push(1); return ON_REQUEST; }),
  fetchTourKeepsSchedule: vi.fn(async (id: string) => (id in KEEPS ? KEEPS[id] : true)),
  fetchSelfSafety: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, {
    isRoute: true, routeDifficulty: 'easy', mchsRegistrationRequired: false, routeRegistrationRequired: false,
    hasProfile: false, satCommunicatorRequired: null, placeRegistrationRequired: null,
  }]))),
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

/** Безопасная тропа — кандидат в самостоятельный день треккинга. */
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM agent_route_knowledge')) {
        const [zone, act] = params as [string, string];
        return zone === 'avachinsky' && act === 'trekking'
          ? { rows: [{ id: 'r-trek-ok', title: 'Тропа к Сухой речке', zone, activity_type: act, lat: 53.1, lng: 158.6, location_type: null }] }
          : { rows: [] };
      }
      return { rows: [] };
    }),
  },
}));

import { recommendTrip, type TripProfile } from '@/lib/planner/engine';

const NEXT = new Date().getUTCFullYear() + 1;
/** 24.11–04.12 следующего года: 11 дней, двое взрослых (как у владельца, без ПД). */
const OWNER: TripProfile = {
  interests: ['hot_spring', 'fishing', 'snowmobile', 'helicopter'],
  arrivalDate: `${NEXT}-11-24`, departureDate: `${NEXT}-12-04`,
  adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', travelStyle: 'mixed',
};
const MALKI: Tour = { tourId: 't-malki', title: 'Малкинские источники', zone: 'avachinsky', activityType: 'hot_spring' };
const THERMAL5: Tour = { tourId: 't-thermal5', title: 'Камчатка: термальный маршрут', zone: 'avachinsky', activityType: 'hot_spring', durationHours: 5 * 24 };
const SNOW: Tour = { tourId: 't-snow', title: 'Снегоходы', zone: 'avachinsky', activityType: 'snowmobile' };
const HELI: Tour = { tourId: 't-heli', title: 'Облёт вулканов', zone: 'avachinsky', activityType: 'helicopter' };
const FISH: Tour = { tourId: 't-fish', title: 'Зимняя рыбалка', zone: 'avachinsky', activityType: 'fishing' };
/** Сезон по записи оператора кончился 15.09 — до дат поездки. */
const FAMILY_PAST: Tour = {
  tourId: 't-family', title: 'Семейный тур выходного дня', zone: 'avachinsky', activityType: 'fishing',
  durationHours: 2 * 24, seasonStart: `${NEXT - 1}-06-01`, seasonEnd: `${NEXT - 1}-09-15`,
};



import { planShapeWarnings, tourRuns } from '@/lib/planner/day-card-view';
import { NO_TOUR_DAY_TITLE } from '@/lib/planner/honest-days';
import { readFileSync } from 'node:fs';

const WEST: Tour = { tourId: 't-west', title: 'Рыбалка на западе', zone: 'western', activityType: 'fishing', durationHours: 72 };

describe('/planner: кейс владельца 24.11–04.12', () => {
  it('в чужую зону с невлезающим туром план не едет; термальный 5-дн. — блоком; пустых дней нет', async () => {
    KEEPS = { 't-malki': false, 't-thermal5': false, 't-fish': false, 't-family': false, 't-snow': false, 't-heli': false, 't-west': false };
    ON_REQUEST = new Set(['hot_spring', 'fishing', 'snowmobile', 'helicopter']);
    TOURS = { 'avachinsky:hot_spring': [MALKI, THERMAL5], 'avachinsky:fishing': [FAMILY_PAST, FISH], 'avachinsky:snowmobile': [SNOW],
      'avachinsky:helicopter': [HELI], 'western:fishing': [WEST] };
    const rec = await recommendTrip(OWNER);
    expect(rec.days).toHaveLength(11);
    expect(rec.days.some((d) => d.title === NO_TOUR_DAY_TITLE)).toBe(false);
    expect(rec.days.some((d) => d.type === 'travel')).toBe(false);
    expect(rec.days.some((d) => d.zone === 'western')).toBe(false);
    const runs = [...new Set([...tourRuns(rec.days as never).values()].map((r) => `${r.tourId}:${r.first}-${r.last}`))];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/^t-thermal5:\d+-\d+$/);
    for (const id of ['t-fish', 't-snow', 't-heli']) expect(rec.days.some((d) => d.realTour?.tourId === id)).toBe(true);
    expect(rec.days.some((d) => d.realTour?.tourId === 't-family')).toBe(false);
    const text = rec.warnings.map((w) => w.message).join('\n');
    expect(text).toMatch(/Не поместились в срок поездки[^\n]*Рыбалка на западе \(3 дн\.\)/);
    expect(text).not.toMatch(/термальный маршрут \(5 дн\.\)/);
    expect(text).not.toMatch(/вертолётные экскурсии без оператора/i);
    expect(planShapeWarnings(rec.warnings).filter((w) => w.severity === 'critical')).toHaveLength(0);
  });

  it('экран планера: заметки о плане под днями одним блоком, над днями — только критичное', () => {
    const src = readFileSync('app/planner/_PlannerClient.tsx', 'utf8');
    const notesAt = src.indexOf("PlanNotes notes={planShapeWarnings(recommendation.warnings ?? []).filter(w => w.severity !== 'critical')}");
    const safetyAt = src.indexOf('SafetyBlock items={safetyBlock(days');
    const daysAt = src.indexOf('Reorder.Group');
    expect(notesAt).toBeGreaterThan(daysAt);
    expect(safetyAt).toBeGreaterThan(notesAt);
    expect(src).not.toMatch(/filter\(w => w\.severity === 'important'\)\.map/);
  });
});

describe('PDF плана: заголовок сметы не отрывается от таблицы', () => {
  it('h2 держится со следующим, блок сметы не рвётся', async () => {
    const { buildPlanPrintHtml } = await import('@/lib/planner/print-html');
    const html = buildPlanPrintHtml({
      origin: 'https://vedarai.ru', dateRange: '', adults: 2, childAges: [], days: [], warnings: [], fmt: (n: number) => String(n),
      estimate: { people: 2, lines: [], total: { min: 0, max: 0 }, perPerson: { min: 0, max: 0 }, assumptions: [], unpriced: [] },
    } as never);
    expect(html).toMatch(/h2 \{ break-after: avoid; page-break-after: avoid; \}/);
    expect(html).toMatch(/\.estimate-block \{ break-inside: avoid;/);
    expect(html).toContain('class="section estimate-block"');
  });
});
