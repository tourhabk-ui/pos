// @vitest-environment node
/**
 * Rescue: прогноз и официальные предупреждения на день брони (25.09).
 *
 * До этого дня на вопрос «опасен ли день брони» нельзя было ответить
 * «не знаю»:
 * - отказ Open-Meteo давал пустой список — бронь тихо пропускалась;
 * - бронь через три дня выпадала за край (прогноз на три дня, считая сегодня);
 * - пропуск кода погоды становился кодом 0 — «Ясно», пропуск ветра — штилем;
 * - ветер тревогой не был вообще;
 * - официальный запрет «сплавы … исключить» (сводка Минтура 25.09) Rescue
 *   не видел: он смотрел только модель погоды.
 *
 * Сторож держит:
 * 1. загрузчик: отказ — `{ ok: false }` и строка в логе, пропуск — null;
 * 2. суждение о дне: «не знаю» отдельно от «спокойно», ветер — тревога,
 *    известная опасность главнее пропуска;
 * 3. сверку с официальными предупреждениями по зоне маршрута и роду тура;
 * 4. подключение: Rescue зовёт обе проверки, день ищет по дате, без эмодзи.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchForecastDays, type ForecastResult } from '@/lib/planner/intelligence';
import {
  judgeForecastDay, matchOfficialAlerts, isWaterTour,
  type UpcomingBooking, type OfficialAlert,
} from '@/lib/agents/evo/rescue-judge';
import { HAZARD_THRESHOLDS } from '@/lib/weather/ensemble';
import { wmoHazardLabel } from '@/lib/weather/wmo-hazard';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const day = (over: Partial<Extract<ForecastResult, { ok: true }>['days'][number]> = {}) => ({
  date: '2026-09-26', tempMax: 9, tempMin: 2, precipMm: 0, windKmh: 12, weatherCode: 1,
  description: 'Малооблачно', ...over,
});
const ok = (...days: ReturnType<typeof day>[]): ForecastResult => ({ ok: true, days });

describe('загрузчик прогноза', () => {
  it('отказ сети — ok:false с причиной и строкой в логе, а не пустой список', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await fetchForecastDays(51.11, 157.11, 5);
    expect(r).toEqual({ ok: false, reason: 'ETIMEDOUT' });
    expect(err).toHaveBeenCalled();
  });

  it('HTTP 503 — тоже отказ, а не «дней нет»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await fetchForecastDays(51.12, 157.12, 5);
    expect(r.ok).toBe(false);
  });

  it('пропуск значения — null, а не ноль («Ясно» и штиль)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      daily: {
        time: ['2026-09-26'],
        temperature_2m_max: [8], temperature_2m_min: [1], precipitation_sum: [null],
        wind_speed_10m_max: [null], weather_code: [null],
      },
    }), { status: 200 })));
    const r = await fetchForecastDays(51.13, 157.13, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.days[0]).toMatchObject({ windKmh: null, weatherCode: null, precipMm: null, description: null });
  });
});

describe('суждение о дне брони', () => {
  it('прогноз не загрузился — «не знаю», с причиной', () => {
    expect(judgeForecastDay({ ok: false, reason: 'HTTP 503' }, '2026-09-26'))
      .toEqual({ kind: 'unknown', reason: 'прогноз не загрузился (HTTP 503)' });
  });

  it('дня в прогнозе нет — «не знаю», а не пропуск брони', () => {
    expect(judgeForecastDay(ok(day({ date: '2026-09-25' })), '2026-09-28').kind).toBe('unknown');
  });

  it('сильный ветер при ясном небе — тревога (раньше молчание)', () => {
    const v = judgeForecastDay(ok(day({ windKmh: HAZARD_THRESHOLDS.windKmh + 5, weatherCode: 0 })), '2026-09-26');
    expect(v.kind).toBe('hazard');
    if (v.kind === 'hazard') expect(v.labels.join()).toMatch(/ветер до 45 км\/ч/);
  });

  it('опасный код без ветра — всё равно тревога: известное главнее пропуска', () => {
    expect(judgeForecastDay(ok(day({ weatherCode: 65, windKmh: null })), '2026-09-26').kind).toBe('hazard');
  });

  it('пропуск кода или ветра без опасности — «не знаю», не «спокойно»', () => {
    for (const over of [{ weatherCode: null }, { windKmh: null }]) {
      const v = judgeForecastDay(ok(day(over)), '2026-09-26');
      expect(v.kind).toBe('unknown');
    }
  });

  it('туман — отдельный исход, спокойный день — спокойный', () => {
    expect(judgeForecastDay(ok(day({ weatherCode: 45 })), '2026-09-26').kind).toBe('fog');
    expect(judgeForecastDay(ok(day()), '2026-09-26')).toEqual({ kind: 'calm', description: 'Малооблачно' });
  });

  it('код 82 — «очень сильный ливень», не «шквал»', () => {
    expect(wmoHazardLabel(82)).toBe('очень сильный ливень');
  });
});

const booking = (over: Partial<UpcomingBooking> = {}): UpcomingBooking => ({
  id: 7, booking_date: '2026-09-26', tour_title: 'Сплав по реке Быстрая', participants: 4,
  activity_type: 'rafting', location_type: 'river', zone: 'western', ...over,
});
const alert = (over: Partial<OfficialAlert> = {}): OfficialAlert => ({
  id: 1, alert_type: 'flood', severity: 2, title: 'Ожидаются разливы на реках',
  description: 'Сплавы на рафтах … необходимо исключить.', affected_zones: ['western'],
  expires_at: '2026-09-30T00:00:00Z', source_url: 'https://kamgov.ru/mintur', ...over,
});

describe('сверка с официальными предупреждениями', () => {
  it('сводка 25.09: паводок с запретом в западной зоне — сплав на завтра найден', () => {
    const { matches } = matchOfficialAlerts([booking()], [alert()]);
    expect(matches).toHaveLength(1);
    expect(matches[0].unplaced).toBe(false);
  });

  it('паводок severity 1 касается тура по воде, но не пешего', () => {
    const weak = alert({ severity: 1 });
    expect(matchOfficialAlerts([booking()], [weak]).matches).toHaveLength(1);
    const hike = booking({ activity_type: 'trekking', location_type: 'volcano' });
    expect(matchOfficialAlerts([hike], [weak]).matches).toHaveLength(0);
  });

  it('чужая зона не касается', () => {
    expect(matchOfficialAlerts([booking({ zone: 'avachinsky' })], [alert()]).matches).toHaveLength(0);
  });

  it('предупреждение истекло до дня брони — не касается', () => {
    const gone = alert({ expires_at: '2026-09-25T10:00:00Z' });
    expect(matchOfficialAlerts([booking()], [gone]).matches).toHaveLength(0);
  });

  it('паводок без зоны — только туру по воде и с пометкой «место не установлено»', () => {
    const unplaced = alert({ affected_zones: [] });
    const r = matchOfficialAlerts([booking(), booking({ id: 8, activity_type: 'trekking', location_type: null })], [unplaced]);
    expect(r.matches.map((m) => m.booking.id)).toEqual([7]);
    expect(r.matches[0].unplaced).toBe(true);
  });

  it('тур без зоны маршрута — назван «не сверено», а не пропущен молча', () => {
    const r = matchOfficialAlerts([booking({ zone: null, activity_type: 'trekking', location_type: null })], [alert()]);
    expect(r.matches).toHaveLength(0);
    expect(r.unassessed[0]).toMatch(/нет зоны маршрута/);
  });

  it('тур по воде: rafting, лодка или место «река»', () => {
    expect(isWaterTour('rafting', null)).toBe(true);
    expect(isWaterTour('boat_trip', null)).toBe(true);
    expect(isWaterTour(null, 'river')).toBe(true);
    expect(isWaterTour('trekking', 'volcano')).toBe(false);
  });
});

describe('подключено', () => {
  const src = read('lib/agents/evo/rescue-agent.ts');

  it('скан зовёт обе проверки, и отказ каждой уходит в failed_checks', () => {
    expect(src).toMatch(/take\('погодные угрозы', await checkWeatherThreats\(\)\)/);
    expect(src).toMatch(/take\('официальные предупреждения', await checkOfficialAlerts\(\)\)/);
  });

  it('день ищется по дате через честный загрузчик, не по номеру и не через нули', () => {
    expect(src).toContain('judgeForecastDay(await fetchForecastDays(');
    expect(src).not.toMatch(/fetchWeatherForecast|forecast\[daysAhead\]|daysUntil/);
  });

  it('паводок на туре по воде — critical: только он уходит в Telegram', () => {
    expect(src).toMatch(/const critical = alert\.severity >= 3 \|\| \(waterFlood && alert\.severity >= 2\)/);
  });

  it('в тревогах Rescue нет эмодзи', () => {
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
