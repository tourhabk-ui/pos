// @vitest-environment node
/**
 * Замена дня сохранённой поездки новым черновиком (#3394, срез 2; слово
 * владельца 19.11 «3394 срез 2 делай»; #3347, рек. 2 «при новом
 * предупреждении — предложить замену дня как новый черновик»).
 *
 * Вызовом lib/trips/trip-replace-day с настоящим правилом плана
 * (`applyPlanEdit`, `replace_day`) и подставным движком подбора:
 *  - день заменяется тем, что подобрал движок, остальные дни — как сохранены,
 *    состав и даты — из поездки;
 *  - результат ложится черновиком с поверхностью 'cabinet', сама поездка не
 *    меняется;
 *  - строки нового дня — как есть: замена не обещает, что предупреждение снято;
 *  - отказы словами: каркас поездки, день прошёл, занятие только в другой зоне,
 *    состава или дат нет, занятие неизвестно; черновик не записался — «failed».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DayPlan, TripRecommendation } from '@/lib/planner/engine';
import type { EditablePlan, EditDeps } from '@/lib/planner/plan-edit';
import type { SafetyRefreshDeps } from '@/lib/planner/plan-safety-refresh';
import { editablePlanFromTrip, replaceTripDay, type ReplaceDayDeps, type SavedTripForReplace } from '@/lib/trips/trip-replace-day';
import { officialAlertNote, type PlanOfficialAlert } from '@/lib/planner/official-alerts';

const STORM: PlanOfficialAlert = {
  id: 1, alert_type: 'weather', severity: 2, title: 'Сильный ветер до 30 м/с, метель',
  description: null, affected_zones: ['avachinsky'], expires_at: '2026-12-31T11:59:00.000Z',
  source_url: null, external_id: 'meteoalert/2026-12-02-wind',
};

/** Сохранённая поездка — как её хранит user_trips (без полей движка). */
function trip(over: Partial<SavedTripForReplace> = {}): SavedTripForReplace {
  return {
    arrival_date: '2026-12-01',
    departure_date: '2026-12-04',
    activities: ['volcano', 'thermal'],
    party: { adults: 2, children: [8], budgetTier: 'comfort' },
    days: [
      { day: 1, type: 'arrival', zone: 'avachinsky', title: 'Прилёт', activityType: 'arrival', priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'jeep' },
      { day: 2, type: 'activity', zone: 'avachinsky', title: 'Авачинский вулкан', activityType: 'volcano', priceFrom: 0, priceTo: 0, coords: [53.25, 158.83], defaultTransport: 'jeep', dayWarnings: ['Старое предупреждение'] },
      { day: 3, type: 'rest', zone: 'avachinsky', title: 'Отдых', activityType: 'rest', priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking' },
      { day: 4, type: 'departure', zone: 'avachinsky', title: 'Вылет', activityType: 'departure', priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'jeep' },
    ],
    ...over,
  };
}

const engineDay = (n: number, type: DayPlan['type'], title: string, extra: Partial<DayPlan> = {}): DayPlan => ({
  day: n, type, zone: 'avachinsky', title, description: '', activityType: type === 'activity' ? 'thermal' : type,
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'jeep', allowedTransports: ['jeep'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
});

let miniDay: DayPlan | null = null;
const recommend = vi.fn(async (): Promise<TripRecommendation> => ({
  days: miniDay ? [engineDay(1, 'arrival', 'Прилёт'), miniDay, engineDay(3, 'departure', 'Вылет')] : [],
  warnings: [],
} as unknown as TripRecommendation));
const safety: SafetyRefreshDeps = {
  loadWarnings: async () => ({ ok: true, warnings: [] }),
  parkQuery: async <T,>() => ({ rows: [] as T[] }),
};
const saved: Array<[EditablePlan, string, string | undefined]> = [];
let saveId: string | null = '11111111-2222-4333-8444-555555555555';

function deps(): ReplaceDayDeps {
  const edit: EditDeps = { recommend, safety, today: () => '2026-11-19' };
  return {
    edit,
    save: async (plan, surface, wishes) => { saved.push([plan, surface, wishes]); return saveId; },
    now: () => new Date('2026-11-19T00:00:00Z'),
  };
}

beforeEach(() => {
  recommend.mockClear();
  miniDay = engineDay(2, 'activity', 'Паратунка', { activityType: 'thermal', dayWarnings: ['Возьмите купальник.'] });
  saved.length = 0;
  saveId = '11111111-2222-4333-8444-555555555555';
});

describe('replaceTripDay', () => {
  it('день заменён, остальные — как сохранены; черновик «cabinet» с составом и датами поездки', async () => {
    const t = trip();
    const before = JSON.stringify(t);
    const r = await replaceTripDay(t, 2, 'thermal', deps());
    if (r.state !== 'drafted') throw new Error(JSON.stringify(r));
    expect(r.draft_id).toBe('11111111-2222-4333-8444-555555555555');
    expect(r.day).toMatchObject({ day: 2, date: '2026-12-02', title: 'Паратунка', zone: 'avachinsky' });
    expect(r.day.warnings).toContain('Возьмите купальник.');
    expect(r.note).toContain('было «Авачинский вулкан», стало «Паратунка»');

    expect(saved).toHaveLength(1);
    const [plan, surface, wishes] = saved[0];
    expect(surface).toBe('cabinet');
    expect(wishes).toBeUndefined();
    expect(plan.params).toMatchObject({ arrivalDate: '2026-12-01', departureDate: '2026-12-04', adults: 2, children: [8], budgetTier: 'comfort' });
    expect(plan.days.map((d) => d.title)).toEqual(['Прилёт', 'Паратунка', 'Отдых', 'Вылет']);
    // Подбор — мини-поездкой на дату дня, той же группой.
    expect(recommend).toHaveBeenCalledWith(expect.objectContaining({ interests: ['thermal'], adults: 2, children: [8] }));
    // Сохранённая поездка не тронута.
    expect(JSON.stringify(t)).toBe(before);
  });

  it('штормовое по зоне остаётся и на новом дне — строка показана как есть, а не спрятана', async () => {
    // Строки парков и штормов ставит дню движок подбора на его дату
    // (recommendTrip → applyPlanOfficialAlerts): подставной движок делает то же.
    miniDay = engineDay(2, 'activity', 'Паратунка', { activityType: 'thermal', dayWarnings: [officialAlertNote(STORM, false)] });
    const r = await replaceTripDay(trip(), 2, 'thermal', deps());
    if (r.state !== 'drafted') throw new Error(JSON.stringify(r));
    expect(r.day.warnings).toContain(officialAlertNote(STORM, false));
  });

  it('прилёт и вылет не заменяются; занятие только в другой зоне — отказ словами', async () => {
    const arrival = await replaceTripDay(trip(), 1, 'thermal', deps());
    expect(arrival).toMatchObject({ state: 'refused' });
    expect((arrival as { reason: string }).reason).toMatch(/день прилёта/);
    miniDay = engineDay(2, 'activity', 'Озерная', { activityType: 'thermal', zone: 'western' });
    const far = await replaceTripDay(trip(), 2, 'thermal', deps());
    expect((far as { reason: string }).reason).toMatch(/только в зоне/);
    expect(saved).toHaveLength(0);
  });

  it('день уже прошёл — «поздно», движок не зовётся', async () => {
    const r = await replaceTripDay(trip({ arrival_date: '2026-11-17', departure_date: '2026-11-20' }), 2, 'thermal', deps());
    expect(r).toEqual({ state: 'refused', reason: 'День 2 уже прошёл — заменять его поздно.' });
    expect(recommend).not.toHaveBeenCalled();
  });

  it('без состава группы и без дат — отказ словами, без выдуманной группы', async () => {
    const noParty = await replaceTripDay(trip({ party: null }), 2, 'thermal', deps());
    expect((noParty as { reason: string }).reason).toMatch(/без состава группы/);
    const noDates = await replaceTripDay(trip({ arrival_date: null }), 2, 'thermal', deps());
    expect((noDates as { reason: string }).reason).toMatch(/не записаны даты/);
    expect(recommend).not.toHaveBeenCalled();
  });

  it('незнакомое занятие и «уже это» — отказ', async () => {
    expect(await replaceTripDay(trip(), 2, 'paragliding', deps())).toMatchObject({ state: 'refused' });
    const same = await replaceTripDay(trip(), 2, 'volcano', deps());
    expect((same as { reason: string }).reason).toMatch(/уже «вулканы»/);
  });

  it('черновик не записался — «failed» словами, а не «готово»', async () => {
    saveId = null;
    const r = await replaceTripDay(trip(), 2, 'thermal', deps());
    expect(r).toEqual({ state: 'failed', reason: 'Замена подобрана, но черновик не записался — попробуйте ещё раз.' });
  });
});

describe('editablePlanFromTrip', () => {
  it('род дня не записан — занятие; строки дня — только строки; интересы — только известные', () => {
    const r = editablePlanFromTrip(trip({
      activities: ['volcano', 'skydiving'],
      days: [{ day: 1, zone: 'avachinsky', title: 'День', dayWarnings: ['a', 5] }],
    }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.days[0]).toMatchObject({ type: 'activity', dayWarnings: ['a'] });
    expect(r.plan.params.interests).toEqual(['volcano']);
  });
  it('день без номера или зоны — «дни не читаются»', () => {
    expect(editablePlanFromTrip(trip({ days: [{ title: 'x' }] }))).toEqual({ ok: false, reason: 'Дни поездки не читаются — подобрать замену не получилось.' });
  });
});
