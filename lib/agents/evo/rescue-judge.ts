/**
 * Суждения Rescue о ближайших бронях — чистые функции, без БД и сети.
 *
 * Вынесены из rescue-agent.ts 25.09, когда выяснилось, что оба вопроса
 * «опасен ли день брони» задавались так, что ответить «не знаю» было нельзя:
 *
 * 1. Прогноз погоды. Отказ Open-Meteo давал пустой список, и бронь тихо
 *    пропускалась; бронь через три дня не проверялась вовсе (прогноз
 *    запрашивался на три дня, считая сегодняшний); пропуск кода погоды
 *    становился кодом 0 — «Ясно»; ветер тревогой не был вообще, хотя на
 *    Камчатке именно он чаще всего отменяет выход на склон.
 * 2. Официальные предупреждения. Сводка Минтура 25.09 прямо велела
 *    «сплавы на рафтах и резиновых лодках по рекам зоны предупреждения
 *    исключить», а Rescue смотрел только модель погоды: сплав, забронированный
 *    на следующий день, не дал бы ни одного сигнала.
 */

import type { ForecastResult } from '@/lib/planner/intelligence';
import { DANGEROUS_WMO_CODES, FOG_WMO_CODES, wmoHazardLabel } from '@/lib/weather/wmo-hazard';
import { HAZARD_THRESHOLDS, isoDate } from '@/lib/weather/ensemble';

export type DayVerdict =
  | { kind: 'hazard'; labels: string[] }
  | { kind: 'fog' }
  | { kind: 'calm'; description: string }
  | { kind: 'unknown'; reason: string };

/**
 * Суждение о дне брони по суточному прогнозу.
 *
 * Известная опасность главнее неизвестности: если код погоды — ливень, а
 * ветра в ответе нет, это тревога, а не «не знаю». Но «спокойно» говорится
 * только когда известны оба — и код, и ветер. Порог ветра — тот же, что у
 * ансамбля (HAZARD_THRESHOLDS.windKmh): два порога на одну опасность уже
 * были бы двумя правилами.
 */
export function judgeForecastDay(forecast: ForecastResult, date: string): DayVerdict {
  if (!forecast.ok) return { kind: 'unknown', reason: `прогноз не загрузился (${forecast.reason})` };
  const day = forecast.days.find((d) => d.date === date);
  if (!day) return { kind: 'unknown', reason: `дня ${date} нет в прогнозе` };

  const labels: string[] = [];
  if (day.weatherCode !== null && DANGEROUS_WMO_CODES.has(day.weatherCode)) {
    labels.push(wmoHazardLabel(day.weatherCode) ?? 'опасная погода');
  }
  if (day.windKmh !== null && day.windKmh >= HAZARD_THRESHOLDS.windKmh) {
    labels.push(`ветер до ${Math.round(day.windKmh)} км/ч`);
  }
  if (labels.length > 0) return { kind: 'hazard', labels };

  const missing = [
    day.weatherCode === null ? 'кода погоды' : null,
    day.windKmh === null ? 'ветра' : null,
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) return { kind: 'unknown', reason: `в прогнозе нет ${missing.join(' и ')}` };

  if (day.weatherCode !== null && FOG_WMO_CODES.has(day.weatherCode)) return { kind: 'fog' };
  return { kind: 'calm', description: day.description ?? 'без описания' };
}

// ── Официальные предупреждения ──────────────────────────────────────────────

/**
 * Выход на воду: сплав, лодка, каяк. Паводок и запрет сплава касаются их
 * напрямую, а пешего тура у той же реки — через переправы, и это уже
 * уровень severity 2, общий для всех.
 */
const WATER_ACTIVITIES = new Set([
  'rafting', 'boat_trip', 'boat', 'kayak', 'kayaking', 'sea_kayak', 'canoe', 'sup', 'river',
]);

export function isWaterTour(activityType: string | null, locationType: string | null): boolean {
  const a = (activityType ?? '').trim().toLowerCase();
  const l = (locationType ?? '').trim().toLowerCase();
  return WATER_ACTIVITIES.has(a) || l === 'river';
}

export interface UpcomingBooking {
  id: number;
  booking_date: string | Date;
  tour_title: string;
  participants: number;
  activity_type: string | null;
  location_type: string | null;
  /** Зона маршрута тура (`kamchatka_routes.zone`); null — у тура нет маршрута или зоны. */
  zone: string | null;
}

export interface OfficialAlert {
  id: number;
  alert_type: string;
  severity: number;
  title: string;
  description: string | null;
  affected_zones: string[] | null;
  expires_at: string | Date;
  source_url: string | null;
}

export interface OfficialMatch {
  booking: UpcomingBooking;
  alert: OfficialAlert;
  /** Предупреждение без зоны, взятое по роду тура: место не установлено. */
  unplaced: boolean;
}

/** Камчатка — UTC+12 без перехода на летнее время. */
const KAMCHATKA_OFFSET = '+12:00';

/** Действует ли предупреждение в день брони: истекает позже начала этого дня. */
function activeOn(alert: OfficialAlert, day: string): boolean {
  const expires = new Date(alert.expires_at).getTime();
  const dayStart = Date.parse(`${day}T00:00:00${KAMCHATKA_OFFSET}`);
  return Number.isFinite(expires) && Number.isFinite(dayStart) && expires > dayStart;
}

/**
 * Какие официальные предупреждения касаются каких броней.
 *
 * - Своя зона: severity 2+ касается любого тура; паводок любой силы — тура
 *   на воде.
 * - Без зоны (река не опознана, место не названо): только паводок severity 2+
 *   и только тура на воде — с пометкой «место не установлено». Остальное без
 *   зоны остаётся в общей ленте: «не установлено где» не значит «везде»
 *   (тот же принцип, что в safety-ingest с 17.09).
 * - Бронь без зоны маршрута сверить с зональными предупреждениями нельзя —
 *   она называется в `unassessed`, если такие предупреждения вообще есть.
 */
export function matchOfficialAlerts(
  bookings: UpcomingBooking[],
  alerts: OfficialAlert[],
): { matches: OfficialMatch[]; unassessed: string[] } {
  const matches: OfficialMatch[] = [];
  const unassessed: string[] = [];
  const zonedSerious = alerts.some((a) => a.severity >= 2 && (a.affected_zones ?? []).length > 0);

  for (const booking of bookings) {
    const day = isoDate(booking.booking_date);
    if (!day) {
      unassessed.push(`бронь #${booking.id}: дата не прочиталась`);
      continue;
    }
    const water = isWaterTour(booking.activity_type, booking.location_type);
    if (!booking.zone && zonedSerious) {
      unassessed.push(`бронь #${booking.id}: у тура нет зоны маршрута`);
    }
    for (const alert of alerts) {
      if (!activeOn(alert, day)) continue;
      const zones = alert.affected_zones ?? [];
      const flood = alert.alert_type === 'flood';
      if (zones.length === 0) {
        if (flood && water && alert.severity >= 2) matches.push({ booking, alert, unplaced: true });
        continue;
      }
      if (!booking.zone || !zones.includes(booking.zone)) continue;
      if (alert.severity >= 2 || (flood && water)) matches.push({ booking, alert, unplaced: false });
    }
  }
  return { matches, unassessed };
}
