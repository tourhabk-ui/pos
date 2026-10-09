/**
 * make_trip_plan: состав группы, уровень бюджета и цена плана (#2223).
 *
 * До 08.10 инструмент принимал только дни, интересы, дату, стиль и отдых, а
 * остальное подставлял молча: двое взрослых, «комфорт». Семья с детьми или
 * турист с тесным бюджетом получали план под чужой профиль. Разбивку цены
 * движок считал (`priceBreakdown`), но в ответ она не попадала.
 *
 * Сторож держит поведением, на настоящем `recommendTrip` с подменённым
 * хранилищем: дети меняют план и его цену; тур с ценой «за группу» не идёт в
 * сумму «на человека» и называется; бюджет меняет оценку жилья. И словами:
 * названное пересказывается как названное, допущение — как допущение; схема
 * MCP и схема Кузьмича — одна правда.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Tour { tourId: string; title: string; zone: string; activityType: string; priceUnit: string }
let TOURS: Record<string, Tour[]> = {};

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map((t) => ({
      tourId: t.tourId, title: t.title, shortDescription: null,
      operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 4.5, operatorReviewCount: 3,
      operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 10000, priceUnit: t.priceUnit,
      maxParticipants: 10, minParticipants: 1, durationHours: 8, difficulty: null,
      weatherDependent: false, seasonStart: null, seasonEnd: null, included: null,
      lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
    }))),
  fetchAvailabilityForTour: vi.fn(async (_id: string, from: string) =>
    [{ date: from, availableSlots: 10, bookedSlots: 0, remaining: 10, priceOverride: null }]),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  // Туров без календаря здесь нет (tests/unit/planner-on-request-tours).
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
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { recommendTrip, type TripProfile, type PriceBreakdown } from '@/lib/planner/engine';
import { estimateGroup, type GroupEstimate } from '@/lib/planner/estimate';
import {
  readAdults, readChildren, readBudgetTier, planAssumptions, formatPlanPrice,
} from '@/lib/kuzmich/trip-plan-tool';
import { TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOLS, PARAM_ENGLISH } from '@/lib/mcp/public-tools';

const BASE: TripProfile = {
  interests: ['volcano', 'bears', 'fishing'],
  arrivalDate: '2027-07-10', departureDate: '2027-07-16',
  adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort',
};

beforeEach(() => {
  TOURS = {
    'avachinsky:volcano': [{ tourId: 't-volc', title: 'Восхождение на Авачинский', zone: 'avachinsky', activityType: 'volcano', priceUnit: 'per_person' }],
    'avachinsky:fishing': [{ tourId: 't-fish', title: 'Рыбалка на Авче', zone: 'avachinsky', activityType: 'fishing', priceUnit: 'per_person' }],
  };
});

describe('движок: состав, бюджет и цена', () => {
  it('дети [6, 10]: занятие не по возрасту убрано из плана и названо (08.10)', async () => {
    // Решение владельца 08.10 («убери»): день 12+ не ставится в план семьи с
    // шестилетним ребёнком. До этого он стоял с пометкой «Детям < 12» на дне.
    const adults = await recommendTrip(BASE, { itinerary: 'plain' });
    const family = await recommendTrip({ ...BASE, children: [6, 10] }, { itinerary: 'plain' });
    const volcanoDays = (r: typeof adults) => r.days.filter((d) => d.activityType === 'volcano');
    expect(volcanoDays(adults).length).toBeGreaterThan(0);
    expect(volcanoDays(family)).toHaveLength(0);
    expect(family.childBlocked?.map((b) => b.interest)).toEqual(['volcano']);
    expect(adults.childBlocked).toBeUndefined();
    expect(family.warnings.some((w) => /в план не вошло — минимальный возраст 12 лет, младшему 6/.test(w.message))).toBe(true);
    expect(family.days.flatMap((d) => d.dayWarnings).some((w) => /Детям </.test(w))).toBe(false);
    // Цена изменилась вместе с планом: тура на вулкан в сумме больше нет.
    expect(family.priceBreakdown).not.toEqual(adults.priceBreakdown);
  });

  it('старшим детям ничего не убирается', async () => {
    const teens = await recommendTrip({ ...BASE, children: [13, 15] }, { itinerary: 'plain' });
    expect(teens.childBlocked).toBeUndefined();
    expect(teens.days.some((d) => d.activityType === 'volcano')).toBe(true);
  });

  it('тур с ценой «за группу» не складывается в сумму на человека и называется', async () => {
    const perPerson = await recommendTrip(BASE, { itinerary: 'plain' });
    TOURS['avachinsky:volcano'][0].priceUnit = 'per_tour';
    const perGroup = await recommendTrip(BASE, { itinerary: 'plain' });
    expect(perPerson.priceBreakdown.activityPricing.excluded).toBe(0);
    expect(perGroup.priceBreakdown.activityPricing.excluded).toBe(1);
    expect(perGroup.priceBreakdown.activityPricing.tourPriced).toBe(perPerson.priceBreakdown.activityPricing.tourPriced - 1);
    // 10 000 тура на вулкан ушли из нижней границы целиком.
    expect(perPerson.priceBreakdown.activities[0] - perGroup.priceBreakdown.activities[0]).toBe(10000);
  });

  it('тур за группу входит в итог на группу — один раз на группу (#2304)', async () => {
    TOURS['avachinsky:volcano'][0].priceUnit = 'per_tour';
    const rec = await recommendTrip(BASE, { itinerary: 'plain' });
    const e = estimateGroup(rec.days, { adults: 2, children: [], budgetTier: 'comfort' });
    const perGroup = e.lines.filter((l) => l.kind === 'tour' && l.basis.includes('за группу'));
    // Вместимость 10, вас двое — одна группа: 10 000 тура, верх вилки ×1.2.
    expect(perGroup.map((l) => l.total)).toEqual([[10000, 12000]]);
    // Всё остальное — ровно вилка на человека, умноженная на состав.
    expect(e.total).toEqual([
      rec.priceBreakdown.perPersonTotal[0] * 2 + 10000,
      rec.priceBreakdown.perPersonTotal[1] * 2 + 12000,
    ]);
  });

  it('уровень бюджета меняет оценку жилья', async () => {
    const eco = await recommendTrip({ ...BASE, budgetTier: 'economy' }, { itinerary: 'plain' });
    const prem = await recommendTrip({ ...BASE, budgetTier: 'premium' }, { itinerary: 'plain' });
    expect(eco.priceBreakdown.accommodation[0]).toBeLessThan(prem.priceBreakdown.accommodation[0]);
  });
});

describe('разбор слов: состав и бюджет', () => {
  it('взрослые: число 1–30, иначе двое и вслух', () => {
    expect(readAdults(undefined)).toEqual({ adults: 2, given: false, note: null });
    expect(readAdults('4')).toEqual({ adults: 4, given: true, note: null });
    expect(readAdults('3 человека').adults).toBe(3);
    expect(readAdults('много').note).toMatch(/не разобрал.*считаю двоих/);
    expect(readAdults('50').adults).toBe(2);
  });

  it('дети: возрасты строкой и массивом от MCP, неразобранное названо', () => {
    expect(readChildren('6, 10')).toEqual({ children: [6, 10], note: null });
    expect(readChildren('6,10').children).toEqual([6, 10]);
    expect(readChildren('[6, 10]').children).toEqual([6, 10]);
    expect(readChildren('нет')).toEqual({ children: [], note: null });
    const bad = readChildren('6, малыш');
    expect(bad.children).toEqual([6]);
    expect(bad.note).toMatch(/«малыш» не разобрал/);
    expect(readChildren('25').note).toMatch(/считаю без детей/);
  });

  it('бюджет: коды и русские слова, непонятное — «комфорт» и вслух', () => {
    expect(readBudgetTier('economy').tier).toBe('economy');
    expect(readBudgetTier('подешевле').tier).toBe('economy');
    expect(readBudgetTier('премиум').tier).toBe('premium');
    expect(readBudgetTier(undefined)).toEqual({ tier: 'comfort', given: false, note: null });
    const odd = readBudgetTier('как получится');
    expect(odd.tier).toBe('comfort');
    expect(odd.note).toMatch(/не разобрал/);
  });

  it('допущения: названное — как названное, не названное — как допущение', () => {
    const silent = planAssumptions({ adults: 2, adultsGiven: false, children: [], tier: 'comfort', tierGiven: false });
    expect(silent).toMatch(/^Считаю на двоих взрослых/);
    expect(silent).toMatch(/«комфорт» \(не назван — допущение\)/);
    const family = planAssumptions({ adults: 2, adultsGiven: true, children: [6, 10], tier: 'economy', tierGiven: true });
    expect(family).toMatch(/^Группа: 2 взр\., дети 6, 10 лет/);
    expect(family).toMatch(/«эконом»,/);
    expect(family).not.toMatch(/допущение/);
  });
});

describe('цена плана словами', () => {
  const pb = (over: Partial<PriceBreakdown> = {}): PriceBreakdown => ({
    activities: [30000, 36000], accommodation: [16000, 24000], transport: [2500, 5000],
    perPersonTotal: [48500, 65000],
    activityPricing: { tourPriced: 2, estimated: 1, excluded: 0 },
    ...over,
  });

  it('вилка на человека и из чего сложена', () => {
    const lines = formatPlanPrice(pb(), 'comfort', true);
    expect(lines[0]).toMatch(/^Ориентир на человека: 48\s500 ₽–65\s000 ₽ \(уровень «комфорт»\)/);
    expect(lines.join('\n')).toMatch(/2 — по ценам туров операторов; 1 — по справочной вилке вида активности, это не цена тура/);
    expect(lines.join('\n')).toMatch(/жильё: 16\s000 ₽–24\s000 ₽/);
    expect(lines.join('\n')).toMatch(/Перелёт до Камчатки в сумму не входит/);
    expect(lines.join('\n')).not.toMatch(/Без учёта/);
  });

  it('туры с ценой не за человека названы, а не спрятаны в сумме', () => {
    const lines = formatPlanPrice(pb({ activityPricing: { tourPriced: 1, estimated: 0, excluded: 2 } }), 'economy', true);
    expect(lines.join('\n')).toMatch(/Без учёта 2 туров: цена у них не за человека/);
  });

  it('плана нет — цены нет', () => {
    expect(formatPlanPrice(pb(), 'comfort', false)).toEqual([]);
  });

  const group = (over: Partial<GroupEstimate> = {}): GroupEstimate => ({
    people: 3, lines: [], total: [150000, 200000], perPerson: [50000, 66667], unpriced: [],
    fromTours: [90000, 108000], fromEstimates: [60000, 92000], assumptions: [], ...over,
  });

  it('итог на группу — после вилки на человека, перелёт по-прежнему вне суммы (#2304)', () => {
    const lines = formatPlanPrice(pb(), 'comfort', true, group());
    const text = lines.join('\n');
    expect(text).toMatch(/Итого на группу из 3 чел\.: 150\s000 ₽–200\s000 ₽ — туры по своей цене/);
    expect(lines.findIndex((l) => l.startsWith('Итого на группу'))).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).toBe('Перелёт до Камчатки в сумму не входит.');
  });

  it('тур за группу не «без учёта», а учтён в итоге на группу; нераспознанный — назван', () => {
    const lines = formatPlanPrice(pb({ activityPricing: { tourPriced: 1, estimated: 0, excluded: 2 } }), 'comfort', true, group({
      lines: [
        { kind: 'tour', label: 'Тур «Сплав», день 2', basis: '30 000 ₽ за группу', total: [30000, 36000], source: 'tour' },
        { kind: 'tour', label: 'Тур «Вертолёт», день 3', basis: '400 000 ₽', total: null, source: 'tour' },
      ],
      unpriced: ['Тур «Вертолёт», день 3'],
    }));
    const text = lines.join('\n');
    expect(text).not.toMatch(/Без учёта/);
    expect(text).toMatch(/В вилку на человека не вошёл 1 тур с ценой не за человека .* в итоге на группу он учтён/);
    expect(text).toMatch(/Не вошло ни в одну сумму .*: Тур «Вертолёт», день 3\./);
  });

  it('один человек — «итого на одного»; допущения сметы — строками', () => {
    const text = formatPlanPrice(pb(), 'comfort', true, group({
      people: 1, assumptions: ['Дети посчитаны по цене взрослого: скидок платформа не знает — уточняйте у оператора.'],
    })).join('\n');
    expect(text).toMatch(/Итого на одного: /);
    expect(text).toMatch(/Дети посчитаны по цене взрослого/);
  });
});

describe('схема: одна правда для MCP и Кузьмича', () => {
  const NEW = ['adults', 'children', 'budget_tier'];
  const spec = TOOL_REGISTRY.make_trip_plan;
  const defProps = Object.keys((spec.definition.function.parameters as { properties: Record<string, unknown> }).properties).sort();
  const mcp = PUBLIC_MCP_TOOLS.find((t) => t.name === 'make_trip_plan');
  const mcpProps = Object.keys((mcp?.inputSchema as { properties: Record<string, unknown> }).properties).sort();

  it('поля описания Кузьмича, MCP и английского слоя совпадают', () => {
    expect(mcpProps).toEqual(defProps);
    expect(Object.keys(PARAM_ENGLISH.make_trip_plan).sort()).toEqual(defProps);
    for (const k of NEW) expect(defProps).toContain(k);
  });

  it('валидатор пропускает новые поля, а не срезает их', () => {
    const parsed = spec.schema.safeParse({ adults: '2', children: [6, 10], budget_tier: 'эконом' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ adults: '2', children: '6,10', budget_tier: 'эконом' });
  });

  it('названное доходит до движка: инструмент и мозг Кузьмича передают поля', () => {
    const tool = readFileSync(join(process.cwd(), 'lib/kuzmich/trip-plan-tool.ts'), 'utf-8');
    const core = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');
    expect(tool).toMatch(/adults: group\.adults,\s*children: kids\.children,/);
    expect(tool).toMatch(/budgetTier: budget\.tier,/);
    // Итог на группу — тем же составом и уровнем, что ушли в движок (#2304).
    expect(tool).toMatch(/priceLines: formatPlanPrice\(rec\.priceBreakdown, budget\.tier, rec\.days\.length > 0,\s*estimateGroup\(rec\.days, \{ adults: group\.adults, children: kids\.children, budgetTier: budget\.tier \}\)\)/);
    expect(tool).toMatch(/formatPlanPrice\(planPrice\(plan\), plan\.params\.budgetTier, plan\.days\.length > 0, planEstimate\(plan\)\)/);
    expect(core).toMatch(/adults: args\.adults, children: args\.children, budget_tier: args\.budget_tier,/);
  });

  it('описание учит правке плана повторным вызовом', () => {
    // С #2224 у плана есть ID: дни правятся edit_trip_plan, а даты и состав —
    // повторным make_trip_plan с прежними аргументами плюс изменение.
    expect(spec.definition.function.description).toMatch(/вызови make_trip_plan снова с прежними аргументами плюс изменение/);
    expect(spec.definition.function.description).toMatch(/edit_trip_plan/);
  });
});
