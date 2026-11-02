/**
 * Обстановка на день выезда: чтение входов, запись, журнал отправок (#2969).
 *
 * Правило суждения — `lib/trips/situation` (чистое). Здесь — где что лежит:
 *  - выезды: брони (`operator_bookings`) и заявки (`leads.source_data.date`,
 *    `tour_id`) на нужные дни;
 *  - координаты тура: свои (`operator_tours.latitude/longitude`), иначе
 *    главного места, иначе маршрута; зона — маршрута, иначе места;
 *  - погода: прогноз Open-Meteo на ЭТИ координаты (один запрос на точку);
 *  - официальные предупреждения: `external_alerts` тем же правилом, что у
 *    Rescue (`matchOfficialAlerts`);
 *  - опасность зоны: оценка `danger-analysis` (`getZoneAssessment`).
 * Каждый вход читается в своём try: отказ одного — «не смог проверить» в
 * строке, а не «спокойно» и не падение всего прогона (§4.0).
 */
import { pool } from '@/lib/db-pool';
import { fetchForecastDays, type ForecastResult } from '@/lib/planner/intelligence';
import { judgeForecastDay, matchOfficialAlerts, type OfficialAlert } from '@/lib/agents/evo/rescue-judge';
import { ZONE_NAMES, zoneName } from '@/lib/safety/zone-names';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';
import {
  judgeSituation, situationFingerprint, situationLine,
  type Situation, type SituationKind, type ZoneDangerInput,
} from '@/lib/trips/situation';

export interface DepartingTour {
  tourId: number;
  date: string;
  title: string;
  operatorId: string;
  activityType: string | null;
  locationType: string | null;
  zone: string | null;
  lat: number | null;
  lng: number | null;
  /** Сколько броней и живых заявок на этот день. */
  travellers: number;
}

const sqlState = (err: unknown) => (err as { code?: string })?.code ?? 'нет SQLSTATE';

export const DEPARTING_TOURS_SQL = `
  WITH trips AS (
    SELECT b.operator_tour_id AS tour_id, b.booking_date AS d
      FROM operator_bookings b
     WHERE b.deleted_at IS NULL
       AND b.booking_status IN ('new', 'confirmed', 'pending_payment')
       AND b.booking_date = ANY($1::date[])
    UNION ALL
    SELECT (l.source_data->>'tour_id')::bigint, (l.source_data->>'date')::date
      FROM leads l
     WHERE l.source_data->>'tour_id' ~ '^[0-9]{1,18}$'
       AND l.source_data->>'date' = ANY($2::text[])
       AND COALESCE(l.is_self, false) = false
       AND l.status NOT IN ('lost', 'converted')
  )
  SELECT ot.id::int AS tour_id, t.d::text AS d, COUNT(*)::int AS travellers,
         ot.title, ot.operator_id::text AS operator_id, ot.activity_type, ot.location_type,
         COALESCE(kr.zone, p.zone) AS zone,
         COALESCE(ot.latitude, p.lat, kr.lat)::float8 AS lat,
         COALESCE(ot.longitude, p.lng, kr.lng)::float8 AS lng
    FROM trips t
    JOIN operator_tours ot ON ot.id = t.tour_id
    LEFT JOIN places p ON p.id = ot.main_place_id
    LEFT JOIN kamchatka_routes kr ON kr.id = ot.route_id
   GROUP BY ot.id, t.d, ot.title, ot.operator_id, ot.activity_type, ot.location_type, kr.zone, p.zone,
            ot.latitude, p.lat, kr.lat, ot.longitude, p.lng, kr.lng
   ORDER BY t.d, ot.id`;

export async function loadDepartingTours(dates: readonly string[]): Promise<DepartingTour[]> {
  const { rows } = await pool.query<{
    tour_id: number; d: string; travellers: number; title: string; operator_id: string;
    activity_type: string | null; location_type: string | null; zone: string | null;
    lat: number | null; lng: number | null;
  }>(DEPARTING_TOURS_SQL, [[...dates], [...dates]]);
  return rows.map((r) => ({
    tourId: Number(r.tour_id), date: r.d.slice(0, 10), title: r.title, operatorId: r.operator_id,
    activityType: r.activity_type, locationType: r.location_type, zone: r.zone,
    lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng),
    travellers: Number(r.travellers),
  }));
}

export const OFFICIAL_ALERTS_SQL = `
  SELECT id, alert_type, severity, title, description, affected_zones, expires_at, source_url
    FROM external_alerts
   WHERE expires_at > ${UTC_WALL_NOW_SQL}
     AND (severity >= 2 OR alert_type = 'flood')
   ORDER BY severity DESC, created_at DESC
   LIMIT 200`;

export const ZONE_DANGER_SQL = `SELECT risk_level FROM v_current_danger WHERE zone = $1 LIMIT 1`;

/** Источники одного прогона: прогноз по точке и лента предупреждений читаются один раз. */
export interface SituationSources {
  forecast(lat: number, lng: number): Promise<ForecastResult>;
  officials(): Promise<OfficialAlert[] | 'failed'>;
  zone(zone: string): Promise<ZoneDangerInput | null | 'failed'>;
}

export function liveSources(): SituationSources {
  const forecasts = new Map<string, Promise<ForecastResult>>();
  let alerts: Promise<OfficialAlert[] | 'failed'> | null = null;
  const zones = new Map<string, Promise<ZoneDangerInput | null | 'failed'>>();
  return {
    forecast(lat, lng) {
      const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
      if (!forecasts.has(key)) forecasts.set(key, fetchForecastDays(lat, lng, 5));
      return forecasts.get(key)!;
    },
    officials() {
      alerts ??= pool.query<OfficialAlert>(OFFICIAL_ALERTS_SQL).then((r) => r.rows, (err: unknown) => {
        console.error('[trip-situation] лента предупреждений не прочиталась, SQLSTATE', sqlState(err));
        return 'failed' as const;
      });
      return alerts;
    },
    zone(zone) {
      if (!zones.has(zone)) {
        // Та же вьюха, что у getZoneAssessment (danger-analyst-agency): сам модуль
        // агентства не импортируется — он тянет модель, а крону она не нужна.
        zones.set(zone, pool.query<{ risk_level: ZoneDangerInput['level'] }>(ZONE_DANGER_SQL, [zone]).then(
          (r) => (r.rows[0] ? { name: zoneName(zone), level: r.rows[0].risk_level } : null),
          (err: unknown) => {
            console.error('[trip-situation] оценка зоны не прочиталась:', zone, sqlState(err));
            return 'failed' as const;
          },
        ));
      }
      return zones.get(zone)!;
    },
  };
}

/** Оценивается четыре зоны модели опасности; прочие метки (охват по координатам) — нет. */
const isZone = (z: string | null): z is string => z !== null && Object.prototype.hasOwnProperty.call(ZONE_NAMES, z);

/** Обстановка одного выезда по источникам прогона. */
export async function situationFor(tour: DepartingTour, src: SituationSources): Promise<Situation> {
  let weather = null;
  if (tour.lat !== null && tour.lng !== null && Number.isFinite(tour.lat) && Number.isFinite(tour.lng)) {
    try {
      weather = judgeForecastDay(await src.forecast(tour.lat, tour.lng), tour.date);
    } catch (err) {
      weather = { kind: 'unknown' as const, reason: `прогноз не загрузился (${err instanceof Error ? err.message : 'сбой'})` };
    }
  }
  const feed = await src.officials();
  let officials: OfficialAlert[] | 'failed' = 'failed';
  let unassessed = false;
  if (feed !== 'failed') {
    const m = matchOfficialAlerts([{
      id: tour.tourId, booking_date: tour.date, tour_title: tour.title, participants: tour.travellers,
      activity_type: tour.activityType, location_type: tour.locationType, zone: tour.zone,
    }], feed);
    officials = [...new Map(m.matches.map((x) => [x.alert.id, x.alert])).values()];
    unassessed = m.unassessed.length > 0;
  }
  const zoneDanger = isZone(tour.zone) ? await src.zone(tour.zone) : null;
  return judgeSituation({ weather, officials, officialsUnassessed: unassessed, zoneDanger });
}

export async function saveSituation(tourId: number, date: string, s: Situation): Promise<void> {
  await pool.query(
    `INSERT INTO trip_situations (tour_id, trip_date, kind, line, fingerprint, checked_at)
     VALUES ($1, $2::date, $3, $4, $5, now())
     ON CONFLICT (tour_id, trip_date) DO UPDATE
       SET kind = EXCLUDED.kind, line = EXCLUDED.line, fingerprint = EXCLUDED.fingerprint, checked_at = now()`,
    [tourId, date, s.kind, situationLine(s), situationFingerprint(s)],
  );
}

export { readStoredSituations, type StoredSituation } from '@/lib/trips/situation-read';

// ── Получатели и журнал ─────────────────────────────────────────────────────

export interface TouristRecipient {
  kind: 'tourist_booking' | 'tourist_lead';
  ref: string;
  tourId: number;
  channel: 'max' | 'telegram' | null;
  chatId: string | null;
}

/**
 * Туристы выезда: бронь — чат бота из metadata или привязанный Telegram/MAX
 * аккаунта (как у напоминания за сутки); заявка — MAX гостя по ключу статуса
 * (`leads.guest_max_chat_id`). Канала нет — получатель всё равно в списке:
 * «нет канала» пишется в журнал, а не пропадает.
 */
export const TOURIST_RECIPIENTS_SQL = `
  SELECT 'tourist_booking' AS kind, b.id::text AS ref, b.operator_tour_id::int AS tour_id,
         CASE WHEN COALESCE(b.metadata->>'platform', 'telegram') = 'max' THEN 'max' ELSE 'telegram' END AS channel,
         COALESCE(b.metadata->>'tg_chat_id', COALESCE(u.telegram_chat_id, u.telegram_id)::text) AS chat_id
    FROM operator_bookings b
    LEFT JOIN users u ON u.id = b.user_id
   WHERE b.deleted_at IS NULL
     AND b.booking_status IN ('new', 'confirmed', 'pending_payment')
     AND b.booking_date = $1::date
  UNION ALL
  SELECT 'tourist_lead', l.id::text, (l.source_data->>'tour_id')::int,
         CASE WHEN l.guest_max_chat_id IS NULL THEN NULL ELSE 'max' END,
         l.guest_max_chat_id::text
    FROM leads l
   WHERE l.source_data->>'tour_id' ~ '^[0-9]{1,9}$'
     AND l.source_data->>'date' = $1::text
     AND COALESCE(l.is_self, false) = false
     AND l.status NOT IN ('lost', 'converted')`;

export async function loadTouristRecipients(date: string): Promise<TouristRecipient[]> {
  const { rows } = await pool.query<{ kind: TouristRecipient['kind']; ref: string; tour_id: number; channel: 'max' | 'telegram' | null; chat_id: string | null }>(
    TOURIST_RECIPIENTS_SQL, [date],
  );
  return rows.map((r) => ({
    kind: r.kind, ref: r.ref, tourId: Number(r.tour_id),
    channel: r.chat_id ? r.channel : null, chatId: r.chat_id,
  }));
}

/** Последний отправленный отпечаток получателю на этот день; null — не слали. */
export async function lastSentFingerprint(kind: string, ref: string, date: string): Promise<string | null> {
  const { rows } = await pool.query<{ fingerprint: string }>(
    `SELECT fingerprint FROM trip_situation_notices
      WHERE recipient_kind = $1 AND recipient_ref = $2 AND trip_date = $3::date AND outcome = 'sent'
      ORDER BY created_at DESC LIMIT 1`,
    [kind, ref, date],
  );
  return rows[0]?.fingerprint ?? null;
}

export async function logNotice(n: {
  kind: 'tourist_booking' | 'tourist_lead' | 'operator'; ref: string; tourId: number; date: string;
  fingerprint: string; outcome: 'sent' | 'failed' | 'no_channel' | 'not_risk' | 'unchanged';
  channel?: string | null; reason?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO trip_situation_notices (recipient_kind, recipient_ref, tour_id, trip_date, fingerprint, outcome, channel, reason)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)`,
    [n.kind, n.ref, n.tourId, n.date, n.fingerprint, n.outcome, n.channel ?? null, n.reason ? n.reason.slice(0, 300) : null],
  );
}
