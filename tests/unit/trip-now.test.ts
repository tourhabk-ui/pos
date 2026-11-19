// @vitest-environment node
/**
 * Сохранённый план, перепроверенный сегодня (#3394, слово владельца 19.11
 * «начни с обновления плана ближе к датам»).
 *
 * Вызовом:
 *  - lib/trips/trip-now: что появилось и что ушло в строках безопасности дня
 *    (правило планера `refreshDatedSafety` на настоящих строках), места тура
 *    на дату для всей группы, прогноз только в горизонте; сохранённый план не
 *    меняется; прошедшие дни не проверяются; «не прочиталось» не выдаётся за
 *    «ничего не изменилось»;
 *  - GET /api/trips/[id]/now: только владельцу, чужая и неверная — 404, сбой
 *    базы — 500 со словами и SQLSTATE в логе.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { checkTripNow, groupSize, safetyChanges, type SavedTripForNow, type TripNowDeps } from '@/lib/trips/trip-now';
import { officialAlertNote, OFFICIAL_ALERTS_UNREAD_NOTE, type PlanOfficialAlert } from '@/lib/planner/official-alerts';
import type { TripDayAvailability } from '@/lib/trips/day-availability';
import type { TripDayForecast } from '@/lib/trips/day-fresh';

const STORM: PlanOfficialAlert = {
  id: 1, alert_type: 'weather', severity: 2, title: 'Сильный ветер до 30 м/с, метель',
  description: null, affected_zones: ['avachinsky', 'eastern'], expires_at: '2026-10-25T11:59:00.000Z',
  source_url: null, external_id: 'meteoalert/2026-10-24-wind',
};
const OLD_NOTE = officialAlertNote({ ...STORM, id: 9, title: 'Старый шторм' }, false);
const NEW_NOTE = officialAlertNote(STORM, false);

// 24.10.2026, полдень по Камчатке.
const NOW = new Date('2026-10-24T00:00:00Z');

let official: PlanOfficialAlert[] = [STORM];
let officialFails = false;
const availabilityCalls: Array<[string, string, number]> = [];
const forecastCalls: string[] = [];
let forecastAnswer: TripDayForecast | null = null;

const FORECAST: TripDayForecast = {
  date: '2026-10-24', tempMin: -3, tempMax: 2, windKmh: 55, precipMm: 12, description: 'метель', bad: true,
};

function deps(): TripNowDeps {
  return {
    safety: {
      loadWarnings: async () => ({ ok: true, warnings: [] }),
      parkQuery: async <T,>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("alert_type = 'flood'")) {
          if (officialFails) throw Object.assign(new Error('down'), { code: '57P01' });
          return { rows: official as unknown as T[] };
        }
        return { rows: [] };
      },
    },
    availability: async (tourId, date, need): Promise<TripDayAvailability> => {
      availabilityCalls.push([tourId, date, need]);
      return { date, remaining: 1, state: 'short', checkedAt: NOW.toISOString() };
    },
    forecast: async (_coords, date) => { forecastCalls.push(date); return forecastAnswer ? { ...forecastAnswer, date } : null; },
    now: () => NOW,
  };
}

function trip(over: Partial<SavedTripForNow> = {}): SavedTripForNow {
  return {
    arrival_date: '2026-10-24',
    party: { adults: 2, children: [7] },
    days: [
      { day: 1, type: 'activity', zone: 'avachinsky', title: 'Авачинский вулкан', coords: [53.25, 158.83],
        realTour: { tourId: '45' }, dayWarnings: [OLD_NOTE, 'Возьмите палки.'] },
      { day: 2, type: 'rest', zone: 'avachinsky', title: 'Термальные источники', coords: [53.0, 158.4], dayWarnings: [] },
    ],
    ...over,
  };
}

beforeEach(() => {
  official = [STORM];
  officialFails = false;
  availabilityCalls.length = 0;
  forecastCalls.length = 0;
  forecastAnswer = FORECAST;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('checkTripNow — что изменилось с дня сохранения', () => {
  it('новое предупреждение — «появилось», устаревшее — «больше не действует»; прочие строки дня не трогаются', async () => {
    const saved = trip();
    const r = await checkTripNow(saved, deps());
    if (r.state !== 'checked') throw new Error(r.state);
    const d1 = r.days.find((d) => d.day === 1)!;
    expect(d1.added).toEqual([NEW_NOTE]);
    expect(d1.gone).toEqual([OLD_NOTE]);
    expect(r.safety_changed).toBe(true);
    expect(r.plan_warnings.some((w) => /^Дни? 1(, 2)?: действует официальное предупреждение/.test(w))).toBe(true);
    expect(r.checked_at).toBe(NOW.toISOString());
    // Сохранённый план не меняется.
    expect(saved.days[0].dayWarnings).toEqual([OLD_NOTE, 'Возьмите палки.']);
  });

  it('ничего не изменилось — пусто и «не изменилось», а не выдуманная перемена', async () => {
    const saved = trip({ days: [{ ...trip().days[0], dayWarnings: [NEW_NOTE, 'Возьмите палки.'] }] });
    const r = await checkTripNow(saved, deps());
    if (r.state !== 'checked') throw new Error(r.state);
    expect(r.days[0]).toMatchObject({ added: [], gone: [] });
    expect(r.safety_changed).toBe(false);
  });

  it('предупреждения не прочитались — прежние строки остаются, план говорит «не прочитаны»', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    officialFails = true;
    const r = await checkTripNow(trip(), deps());
    if (r.state !== 'checked') throw new Error(r.state);
    expect(r.days[0].gone).toEqual([]);
    expect(r.plan_warnings).toContain(OFFICIAL_ALERTS_UNREAD_NOTE);
  });

  it('места тура — на дату дня для всей группы (двое взрослых и ребёнок); у дня без тура мест нет', async () => {
    const r = await checkTripNow(trip(), deps());
    if (r.state !== 'checked') throw new Error(r.state);
    expect(availabilityCalls).toEqual([['45', '2026-10-24', 3]]);
    expect(r.days[0].availability?.state).toBe('short');
    expect(r.days[1].availability).toBeNull();
  });

  it('дата выезда тура записана в дне — места на неё, а не на календарную дату дня', async () => {
    const days = [{ ...trip().days[0], availableDate: '2026-10-26' }];
    await checkTripNow(trip({ days }), deps());
    expect(availabilityCalls[0][1]).toBe('2026-10-26');
  });

  it('прогноз — только у дня занятия с координатами; у дня отдыха не спрашивается', async () => {
    const r = await checkTripNow(trip(), deps());
    if (r.state !== 'checked') throw new Error(r.state);
    expect(forecastCalls).toEqual(['2026-10-24']);
    expect(r.days[0]).toMatchObject({ weather_state: 'ok', weather: { bad: true } });
    expect(r.days[1]).toMatchObject({ weather_state: 'not_checked', weather: null });
  });

  it('дата дальше 16 суток — прогноз не спрашивается, «рано»; в горизонте не пришёл — «не получен»', async () => {
    const far = await checkTripNow(trip({ arrival_date: '2026-11-20' }), deps());
    if (far.state !== 'checked') throw new Error(far.state);
    expect(forecastCalls).toEqual([]);
    expect(far.days[0].weather_state).toBe('later');
    forecastAnswer = null;
    const near = await checkTripNow(trip(), deps());
    if (near.state !== 'checked') throw new Error(near.state);
    expect(near.days[0].weather_state).toBe('unavailable');
  });

  it('прошедшие дни не проверяются; поездка целиком прошла — «прошла» с последним днём', async () => {
    const started = await checkTripNow(trip({ arrival_date: '2026-10-23' }), deps());
    if (started.state !== 'checked') throw new Error(started.state);
    expect(started.days.map((d) => d.day)).toEqual([2]);
    expect(availabilityCalls).toEqual([]);
    expect(await checkTripNow(trip({ arrival_date: '2026-10-01' }), deps())).toEqual({ state: 'past', last_day: '2026-10-02' });
  });

  it('без дат — «дат нет», источники не спрашиваются', async () => {
    expect(await checkTripNow(trip({ arrival_date: null }), deps())).toEqual({ state: 'no_dates' });
    expect(await checkTripNow(trip({ days: [] }), deps())).toEqual({ state: 'no_dates' });
    expect(availabilityCalls).toEqual([]);
    expect(forecastCalls).toEqual([]);
  });
});

describe('какой день можно заменить черновиком (#3394, срез 2)', () => {
  it('занятие и отдых — можно; прилёт и день многодневного тура — нет; занятие дня названо', async () => {
    const days = [
      { day: 1, type: 'arrival', zone: 'avachinsky', title: 'Прилёт', dayWarnings: [] },
      { day: 2, type: 'activity', zone: 'avachinsky', title: 'Вулкан', activityType: 'volcano', realTour: { tourId: '45' }, dayWarnings: [] },
      { day: 3, type: 'activity', zone: 'eastern', title: 'Медведи', activityType: 'bears', realTour: { tourId: '77' }, dayWarnings: [] },
      { day: 4, type: 'activity', zone: 'eastern', title: 'Медведи — день 2', activityType: 'bears', realTour: { tourId: '77' }, dayWarnings: [] },
      { day: 5, type: 'rest', zone: 'avachinsky', title: 'Отдых', dayWarnings: [] },
      { day: 6, zone: 'avachinsky', title: 'День без рода', dayWarnings: [] },
    ];
    const r = await checkTripNow(trip({ days }), deps());
    if (r.state !== 'checked') throw new Error(r.state);
    const by = (n: number) => r.days.find((d) => d.day === n)!;
    expect([1, 2, 3, 4, 5, 6].map((n) => by(n).replaceable)).toEqual([false, true, false, false, true, true]);
    expect(by(2).activity).toBe('volcano');
    expect(by(5).activity).toBeNull();
    expect(by(6).activity).toBeNull();
  });
});

describe('мелкие правила', () => {
  it('группа: не записана — один человек; дети считаются', () => {
    expect(groupSize(null)).toBe(1);
    expect(groupSize({ adults: 2, children: [5, 9] })).toBe(4);
    expect(groupSize({ adults: 0, children: [] })).toBe(1);
  });
  it('сравнение строк: порядок не важен, повтор не считается переменой', () => {
    expect(safetyChanges(['a', 'b'], ['b', 'a'])).toEqual({ added: [], gone: [] });
    expect(safetyChanges(['a'], ['b'])).toEqual({ added: ['b'], gone: ['a'] });
  });
});

// ─── Дверь ──────────────────────────────────────────────────────────────────

const r = vi.hoisted(() => ({
  user: 'u1' as string | null,
  query: vi.fn(),
  check: vi.fn(),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: async () => (r.user
    ? { userId: r.user }
    : NextResponse.json({ success: false, error: 'Требуется вход' }, { status: 401 })),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => r.query(...a) } }));

describe('GET /api/trips/[id]/now — только владельцу', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const call = async (id = ID) => {
    const { GET } = await import('@/app/api/trips/[id]/now/route');
    const res = await GET(new NextRequest(`http://x/api/trips/${id}/now`), { params: Promise.resolve({ id }) });
    return { status: res.status, body: await res.json() as { success: boolean; error?: string; data?: { state: string } } };
  };

  beforeEach(() => {
    r.user = 'u1';
    r.query.mockReset();
  });

  it('без входа — 401, база не спрашивается', async () => {
    r.user = null;
    expect((await call()).status).toBe(401);
    expect(r.query).not.toHaveBeenCalled();
  });

  it('неверный id — 404 без запроса; чужая или удалённая поездка — 404 по условию владельца', async () => {
    expect((await call('nope')).status).toBe(404);
    expect(r.query).not.toHaveBeenCalled();
    r.query.mockResolvedValue({ rows: [] });
    const res = await call();
    expect(res.status).toBe(404);
    const [sql, params] = r.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/user_id = \$2/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(params).toEqual([ID, 'u1']);
  });

  it('своя поездка — перепроверка по календарным датам; сбой базы — 500 со словами и SQLSTATE в логе', async () => {
    r.query.mockResolvedValue({ rows: [{
      id: ID, user_id: 'u1', title: 'Поездка', arrival_date: '2026-01-01', departure_date: '2026-01-02',
      days: [{ day: 1, zone: 'avachinsky', title: 'День', type: 'activity' }], party: null, updated_at: new Date(),
    }] });
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(ok.body.data?.state).toBe('past');

    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r.query.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    const bad = await call();
    expect(bad.status).toBe(500);
    expect(bad.body.error).toBe('Проверить план сейчас не получилось — попробуйте чуть позже');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[trips/now]'), '57014', 'timeout');
  });
});
