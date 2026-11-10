/**
 * tests/unit/planner-official-alerts.test.ts
 *
 * Штормовые предупреждения, паводок, лавины на днях плана (#2930, шаг 2).
 * Правило охвата — matchOfficialAlerts (то же, что «перед выездом»), здесь —
 * что доходит до дня и до плана. Вызовом:
 *  - своя зона и действует в день по Камчатке — строка дня; после срока — нет;
 *  - день без даты не судится;
 *  - паводок без зоны — только день на воде, с оговоркой «место не установлено»;
 *  - переезд — обе зоны, одна строка на предупреждение;
 *  - источник и срок в строке; отказ чтения — «не прочитаны», дни не тронуты;
 *  - движок: строка под днём и предупреждение плана; отказ — строка «не прочитаны»;
 *  - сдвиг дат: строка старой даты снята, новая поставлена; отказ — прежние остаются.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ official: [] as unknown[], officialFails: false }));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (String(sql).includes("AND (severity >= 2 OR alert_type = 'flood')")) {
        if (db.officialFails) throw Object.assign(new Error('down'), { code: '57P01' });
        return { rows: db.official };
      }
      return { rows: [] };
    }),
  },
}));
vi.mock('@/lib/safety/active-warnings', () => ({
  loadActiveWarnings: vi.fn(async () => ({ ok: true as const, warnings: [] })),
}));
vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async () => []),
  fetchAvailabilityForTour: vi.fn(async () => []),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>(['volcano'])),
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchTourKeepsSchedule: vi.fn(async () => false),
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
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn(async () => 'Пересказ плана.') }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));

import {
  applyPlanOfficialAlerts, isOfficialAlertNote, officialAlertNote, officialNotesByDay,
  OFFICIAL_ALERTS_UNREAD_NOTE, type PlanOfficialAlert,
} from '@/lib/planner/official-alerts';
import { recommendTrip, type DayPlan, type TripProfile } from '@/lib/planner/engine';
import { refreshDatedSafety } from '@/lib/planner/plan-safety-refresh';

/** Шторм Росгидромета на юг края до конца 25.10 по Камчатке (13:00 UTC = 01:00 26.10). */
const STORM: PlanOfficialAlert = {
  id: 1, alert_type: 'weather', severity: 2, title: 'Сильный ветер до 30 м/с, метель',
  description: null, affected_zones: ['avachinsky', 'eastern'], expires_at: '2026-10-25T11:59:00.000Z',
  source_url: null, external_id: 'meteoalert/2026-10-24-wind',
};
/** Паводок без зоны (река не опознана), severity 2. */
const FLOOD_UNPLACED: PlanOfficialAlert = {
  id: 2, alert_type: 'flood', severity: 2, title: 'Подъём уровня воды в реках',
  description: null, affected_zones: [], expires_at: '2026-10-30T00:00:00.000Z',
  source_url: null, external_id: 'mchs/flood-1',
};
/** Слабый ветер — severity 1, не паводок: дня не касается. */
const WEAK: PlanOfficialAlert = { ...STORM, id: 3, severity: 1, title: 'Ветер до 15 м/с' };

const dates: Record<number, string> = { 1: '2026-10-24', 2: '2026-10-25', 3: '2026-10-26' };
const dateOf = (n: number) => dates[n] ?? null;

describe('строки дней по официальным предупреждениям', () => {
  const day = (n: number, over: Partial<{ type: string; zone: 'avachinsky' | 'eastern' | 'western' | 'northern'; title: string; activityType: string }> = {}) => ({
    day: n, type: 'activity', zone: 'avachinsky' as const, title: `День ${n}`, ...over,
  });

  it('своя зона, действует в день — строка; на следующий день после срока — нет', () => {
    const byDay = officialNotesByDay([day(1), day(2), day(3)], dateOf, [STORM]);
    expect([...byDay.keys()]).toEqual([1, 2]);
    expect(byDay.get(1)).toEqual([officialAlertNote(STORM, false)]);
  });

  it('строка: источник, заголовок, срок по Камчатке, 112', () => {
    const note = officialAlertNote(STORM, false);
    expect(note).toBe('Официальное предупреждение (Росгидромет (meteoalert.meteoinfo.ru)): «Сильный ветер до 30 м/с, метель», действует до 25.10. Решение о выходе — с оператором или гидом; экстренный вызов — 112.');
    expect(isOfficialAlertNote(note)).toBe(true);
    expect(isOfficialAlertNote('Возьмите палки.')).toBe(false);
  });

  it('чужая зона и слабое предупреждение — не касаются; день без даты не судится', () => {
    expect(officialNotesByDay([day(1, { zone: 'western' })], dateOf, [STORM]).size).toBe(0);
    expect(officialNotesByDay([day(1)], dateOf, [WEAK]).size).toBe(0);
    expect(officialNotesByDay([day(1)], () => null, [STORM]).size).toBe(0);
  });

  it('паводок без зоны — только день на воде, с оговоркой «место не установлено»', () => {
    const byDay = officialNotesByDay(
      [day(1, { activityType: 'rafting', zone: 'western' }), day(2, { activityType: 'volcano' })],
      dateOf, [FLOOD_UNPLACED],
    );
    expect([...byDay.keys()]).toEqual([1]);
    expect(byDay.get(1)![0]).toMatch(/Место по сводке не установлено, а день — на воде\./);
  });

  it('переезд — обе зоны из заголовка, одна строка на предупреждение', () => {
    const travel = day(1, { type: 'travel', zone: 'western', title: 'Переезд: Западная зона → Восточная зона' });
    expect(officialNotesByDay([travel], dateOf, [STORM]).get(1)).toEqual([officialAlertNote(STORM, false)]);
  });

  it('отказ чтения — «не прочитаны», дни не тронуты, SQLSTATE в логе', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const days = [{ ...day(1), dayWarnings: ['Возьмите палки.'] }];
    const res = await applyPlanOfficialAlerts(days, dateOf, async () => { throw Object.assign(new Error('x'), { code: '42P01' }); });
    expect(res).toEqual({ unread: true, days: [] });
    expect(days[0].dayWarnings).toEqual(['Возьмите палки.']);
    expect(err.mock.calls.some((c) => c.join(' ').includes('42P01'))).toBe(true);
    err.mockRestore();
  });

  it('строка встаёт первой в день и не повторяется', async () => {
    const days = [{ ...day(1), dayWarnings: ['Возьмите палки.'] }];
    const q = async <T,>() => ({ rows: [STORM] as unknown as T[] });
    expect(await applyPlanOfficialAlerts(days, dateOf, q)).toEqual({ unread: false, days: [1] });
    await applyPlanOfficialAlerts(days, dateOf, q);
    expect(days[0].dayWarnings).toEqual([officialAlertNote(STORM, false), 'Возьмите палки.']);
  });
});

const PROFILE: TripProfile = {
  interests: ['volcano'], arrivalDate: '2026-10-24', departureDate: '2026-10-27',
  adults: 2, children: [], fitnessLevel: 'active', budgetTier: 'comfort', tripOrigin: 'local',
};

describe('движок планера', () => {
  beforeEach(() => { db.official = []; db.officialFails = false; });

  it('шторм на даты поездки — строка под днём прилёта и предупреждение плана', async () => {
    db.official = [STORM];
    const rec = await recommendTrip(PROFILE, { itinerary: 'plain' });
    const arrival = rec.days.find((d) => d.day === 1)!;
    expect(arrival.dayWarnings[0]).toBe(officialAlertNote(STORM, false));
    expect(rec.days.find((d) => d.day === 3)?.dayWarnings.some(isOfficialAlertNote) ?? false).toBe(false);
    expect(rec.warnings.some((w) => /^Дни? 1(, 2)?: действует официальное предупреждение/.test(w.message))).toBe(true);
  });

  it('лента не прочиталась — план говорит «не прочитаны», а не молчит', async () => {
    db.officialFails = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rec = await recommendTrip(PROFILE, { itinerary: 'plain' });
    expect(rec.warnings.some((w) => w.message === OFFICIAL_ALERTS_UNREAD_NOTE)).toBe(true);
    expect(rec.days.every((d) => !d.dayWarnings.some(isOfficialAlertNote))).toBe(true);
  });
});

describe('сдвиг дат плана', () => {
  const planDay = (n: number, warnings: string[]): DayPlan => ({
    day: n, type: 'activity', zone: 'avachinsky', title: `День ${n}`, description: '', activityType: 'volcano',
    priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'],
    difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: warnings,
  } as unknown as DayPlan);

  it('строка старой даты снята, на новую дату — поставлена заново', async () => {
    const old = officialAlertNote({ ...STORM, id: 9, title: 'Старый шторм' }, false);
    const days = [planDay(1, [old, 'Возьмите палки.'])];
    const res = await refreshDatedSafety(days, '2026-10-24', [1], false, {
      loadWarnings: async () => ({ ok: true, warnings: [] }),
      parkQuery: async <T,>(sql: string) => ({ rows: (sql.includes("alert_type = 'flood'") ? [STORM] : []) as unknown as T[] }),
    });
    expect(days[0].dayWarnings).toEqual([officialAlertNote(STORM, false), 'Возьмите палки.']);
    expect(res.warnings.some((w) => /^День 1: действует официальное предупреждение/.test(w))).toBe(true);
  });

  it('не прочиталось — прежние строки остаются, план говорит «не прочитаны»', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const old = officialAlertNote(STORM, false);
    const days = [planDay(1, [old])];
    const res = await refreshDatedSafety(days, '2026-10-24', [1], false, {
      loadWarnings: async () => ({ ok: true, warnings: [] }),
      parkQuery: async <T,>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("alert_type = 'flood'")) throw Object.assign(new Error('down'), { code: '57P01' });
        return { rows: [] };
      },
    });
    expect(days[0].dayWarnings).toEqual([old]);
    expect(res.warnings).toContain(OFFICIAL_ALERTS_UNREAD_NOTE);
  });
});
