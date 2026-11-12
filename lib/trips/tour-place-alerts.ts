/**
 * Действующие предупреждения, которые относятся к главному месту тура.
 *
 * Относит их к месту ТОТ ЖЕ предикат, которым пересчёт красит статус места
 * (`ALERT_MATCH_SQL`, lib/services/safety/alert-place-scope): дорога и пожар
 * — координатой, землетрясение — силой сотрясения, извержение и запрет у
 * вулкана — вулканом, закрытие парка — парком, остальное — зоной места, а
 * «юг края» и дальние округа — координатами места. Своей копии правила здесь
 * нет намеренно.
 *
 * Зачем отдельный запрос (план «после отказа», этап 2в, три прохода ревью
 * 12.11). Проверка дат после отказа по погоде сначала сверяла предупреждения
 * с туром сравнением зон — правилом Rescue (`matchOfficialAlerts`). Для
 * напоминаний это приближение годится, для слова «проверено» — нет:
 *  - закрытие парка пишется без зон, и одно такое делало бы «непроверенной»
 *    каждую дату у каждого тура;
 *  - запрет подходить к вулкану несёт зону и совпадал с любым туром этой
 *    зоны — морская прогулка получала «причину отказа: вулкан Мутновский», а
 *    после срока записи в ленте (не запрета) назывались другие даты;
 *  - предупреждения жёлтого уровня (severity 1) лента Rescue не читает вовсе,
 *    а человеку говорилось «официальные предупреждения проверены».
 * Две копии одного правила расходятся молча (шапка lib/routes/collect-signals)
 * — поэтому здесь предикат один и тот же, что у карточки места.
 *
 * Читаются предупреждения уровня 1 и выше: уровень 0 — справки, отбои и
 * учебные проверки. Уровень не записан — считается предупреждением: «не знаю,
 * насколько серьёзно» не равно «не серьёзно» (§4.0).
 *
 * Место — только живое главное место тура (как в lib/safety/tour-place-status):
 * его зона отдаётся отдельно — без зоны зональные предупреждения к месту не
 * относятся НИ ОДНО, и «предупреждений нет» про такое место сказать нельзя.
 */
import { pool } from '@/lib/db-pool';
import { UTC_WALL_NOW_SQL, utcWallIsoSql } from '@/lib/db/timestamp-iso';
import { ALERT_MATCH_SQL } from '@/lib/services/safety/alert-place-scope';

export interface PlaceAlert {
  id: string;
  alert_type: string | null;
  severity: number;
  title: string;
  /** Срок записи в ленте, ISO в UTC. Начала у предупреждения нет: оно действует с выпуска. */
  expires_at: string;
}

export interface TourPlaceAlerts {
  /** Зона главного места; null — не записана. */
  zone: string | null;
  /** По убыванию уровня. */
  alerts: PlaceAlert[];
}

/**
 * `ark` — место в том же виде, в каком его видит предикат у пересчёта статуса
 * (вьюха agent_route_knowledge для мест: id — ark_id, title — name; 942).
 * Вьюха здесь не читается: новый код берёт место из `places` (§4.1).
 */
export const TOUR_PLACE_ALERTS_SQL = `
  SELECT ark.zone AS place_zone,
         ea.id::text AS id, ea.alert_type, COALESCE(ea.severity, 1)::int AS severity, ea.title,
         ${utcWallIsoSql('ea.expires_at')} AS expires_at
    FROM operator_tours ot
    JOIN LATERAL (
      SELECT mp.ark_id AS id, mp.name AS title, mp.lat, mp.lng, mp.zone, mp.location_type
        FROM places mp
       WHERE mp.id = ot.main_place_id AND mp.is_visible = TRUE AND mp.merged_into_id IS NULL
    ) ark ON TRUE
    LEFT JOIN external_alerts ea
      ON ea.expires_at > ${UTC_WALL_NOW_SQL}
     AND COALESCE(ea.severity, 1) >= 1
     AND (${ALERT_MATCH_SQL})
   WHERE ot.id = $1::bigint
   ORDER BY COALESCE(ea.severity, 1) DESC, ea.expires_at DESC NULLS LAST, ea.id
   LIMIT 100`;

interface Row {
  place_zone: string | null;
  id: string | null;
  alert_type: string | null;
  severity: number | null;
  title: string | null;
  expires_at: string | null;
}

/**
 * Одно предупреждение, переизданное источником под разными номерами (тот же
 * заголовок), — одна строка: пересчёт статуса места склеивает их так же
 * (`DISTINCT ON (lrs_id, title)` в safety-ingest). Оставляется запись с
 * наибольшим уровнем и самым поздним сроком: переиздание продлевает действие.
 */
export function mergeRepublished(alerts: readonly PlaceAlert[]): PlaceAlert[] {
  const byTitle = new Map<string, PlaceAlert>();
  for (const a of alerts) {
    const key = a.title.replace(/\s+/g, ' ').trim().toLowerCase();
    const was = byTitle.get(key);
    if (!was) { byTitle.set(key, { ...a }); continue; }
    was.severity = Math.max(was.severity, a.severity);
    if (Date.parse(a.expires_at) > Date.parse(was.expires_at)) was.expires_at = a.expires_at;
  }
  return [...byTitle.values()].sort((x, y) => y.severity - x.severity || x.title.localeCompare(y.title, 'ru'));
}

/**
 * null — у тура нет живого главного места. Отказ базы — исключение: вызывающий
 * называет его «не смог проверить», а не «предупреждений нет».
 */
export async function loadTourPlaceAlerts(tourId: number): Promise<TourPlaceAlerts | null> {
  const { rows } = await pool.query<Row>(TOUR_PLACE_ALERTS_SQL, [tourId]);
  if (rows.length === 0) return null;
  const alerts: PlaceAlert[] = [];
  for (const r of rows) {
    if (r.id === null || r.expires_at === null) continue;
    alerts.push({
      id: r.id, alert_type: r.alert_type, severity: Number(r.severity ?? 1),
      title: (r.title ?? '').trim() || 'без названия', expires_at: r.expires_at,
    });
  }
  return { zone: rows[0].place_zone, alerts: mergeRepublished(alerts) };
}
