/**
 * lib/planner/park-status.ts — закрытие парка и «статус парка не известен» на
 * днях плана поездки (разбор планера 06.11, слово владельца «Действуй»).
 *
 * До этой правки движок планера читал из тревог только два рода — извержение
 * и дорогу (lib/safety/active-warnings). Сводка «маршруты природных парков
 * закрыты на период межсезонья» красила места парка красным на карточке и в
 * ответах агенту, а план с днём в закрытом Налычево собирался как обычный, и
 * ни человек на /planner, ни агент через make_trip_plan о закрытии не узнавали.
 *
 * Привязка дня к парку — ТЕМ ЖЕ предикатом, что красит места
 * (`PARK_SCOPED_SQL`, lib/services/safety/alert-place-scope): своё правило
 * «какой маршрут в каком парке» разошлось бы с карточкой места. Ссылки дня:
 *  - самостоятельный маршрут — его id в каталоге маршрутов и мест (`routeId`);
 *  - тур — маршрут тура (`operator_tours.route_id`) и главное место тура
 *    (`operator_tours.main_place_id`, миграция 1286).
 * Строки «маршрут/место» собираются из `kamchatka_routes` и `places` так же,
 * как их собирает представление каталога (миграция 942): id и название.
 *
 * Дата решает. Тревога живая сейчас, а день плана может быть через полгода:
 *  - закрытие накрывает день до своего срока (`expires_at`) включительно — по
 *    дню Камчатки;
 *  - после срока сезонное закрытие без даты (`isIndefiniteClosure`) говорит
 *    «статус на дату дня не известен» — не дольше `PARK_UNKNOWN_MAX_DAYS` от
 *    сводки, как и сама строка «не знаю» (lib/services/safety/park-reopening);
 *  - закрытие с названной датой после неё ничего о дне не говорит;
 *  - строка «статус парка не известен» накрывает дни в том же пределе.
 * Плана без дат нет у человека, а у агента дата есть всегда; без неё день
 * судится «как сейчас».
 *
 * Не смогли прочитать — так и сказано в предупреждениях плана (§4.0), а не
 * «закрытий нет».
 */

import { PARK_SCOPED_SQL } from '@/lib/services/safety/alert-place-scope';
import { isIndefiniteClosure } from '@/lib/safety/park-closure';
import { PARK_UNKNOWN_MAX_DAYS } from '@/lib/safety/park-closure-terms';
import { UTC_WALL_NOW_SQL, utcWallIsoSql } from '@/lib/db/timestamp-iso';

export type PlanParkQuery = <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }>;

/** Живая тревога парка, привязанная к маршруту или туру дня. */
export interface PlanParkAlert {
  ref_kind: 'route' | 'tour';
  ref_id: string;
  alert_id: string;
  alert_type: 'park_closure' | 'park_status_unknown';
  title: string;
  description: string | null;
  /** Дата последней сводки (ISO, UTC). */
  published_iso: string;
  /** Срок строки (ISO, UTC). */
  expires_iso: string;
}

/**
 * Живые закрытия парков и «не знаю» по ссылкам дней. Маршрут — id каталога
 * (как `agent_route_knowledge.id`), тур — `operator_tours.id`.
 */
export const PLAN_PARK_ALERTS_SQL = `
  WITH refs AS (
    SELECT 'route'::text AS ref_kind, r AS ref_id, r AS ark_id
      FROM unnest($1::text[]) AS r
    UNION
    SELECT 'tour', ot.id::text, COALESCE(kr.ark_id, kr.id)::text
      FROM operator_tours ot
      JOIN kamchatka_routes kr ON kr.id = ot.route_id
     WHERE ot.id::text = ANY($2::text[])
    UNION
    SELECT 'tour', ot.id::text, pl.ark_id::text
      FROM operator_tours ot
      JOIN places pl ON pl.id = ot.main_place_id
     WHERE ot.id::text = ANY($2::text[])
       AND pl.ark_id IS NOT NULL
  ),
  ark AS (
    SELECT COALESCE(r.ark_id, r.id) AS id, r.title
      FROM kamchatka_routes r
     WHERE r.merged_into_id IS NULL
       AND COALESCE(r.ark_id, r.id)::text IN (SELECT ark_id FROM refs)
    UNION ALL
    SELECT p.ark_id AS id, p.name AS title
      FROM places p
     WHERE p.merged_into_id IS NULL
       AND p.ark_id::text IN (SELECT ark_id FROM refs)
  )
  SELECT DISTINCT refs.ref_kind, refs.ref_id, ea.id::text AS alert_id, ea.alert_type, ea.title, ea.description,
         ${utcWallIsoSql('COALESCE(ea.last_published_at, ea.created_at)')} AS published_iso,
         ${utcWallIsoSql('ea.expires_at')} AS expires_iso
    FROM refs
    JOIN ark ON ark.id::text = refs.ark_id
    JOIN external_alerts ea ON ea.expires_at > ${UTC_WALL_NOW_SQL} AND ${PARK_SCOPED_SQL}`;

export async function loadPlanParkAlerts(
  query: PlanParkQuery,
  refs: { routeIds: readonly string[]; tourIds: readonly string[] },
): Promise<PlanParkAlert[]> {
  if (refs.routeIds.length === 0 && refs.tourIds.length === 0) return [];
  const { rows } = await query<PlanParkAlert>(PLAN_PARK_ALERTS_SQL, [[...refs.routeIds], [...refs.tourIds]]);
  return rows;
}

const DAY_MS = 86_400_000;
const KAMCHATKA_OFFSET_MS = 12 * 3_600_000;

/** День Камчатки (UTC+12, без летнего времени) для момента ISO — YYYY-MM-DD. */
export function kamchatkaDateOf(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + KAMCHATKA_OFFSET_MS).toISOString().slice(0, 10);
}

/** «02.11» — день сводки по Камчатке. */
function ddmm(iso: string): string {
  const d = kamchatkaDateOf(iso);
  return d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : 'дата не записана';
}

/**
 * Заголовок сводки — цитата источника и бывает длинным (сводка 02.11 — 140
 * знаков); в строке дня он укорачивается по слову, а не обрывается на букве.
 */
export function clipTitle(title: string, max = 160): string {
  const t = title.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, '')}…`;
}

function addDays(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export interface ParkDayNote {
  severity: 'critical' | 'important';
  text: string;
}

/**
 * Что тревога парка говорит о дне плана. `dayIso` — дата дня (YYYY-MM-DD);
 * `null` — даты нет, день судится «как сейчас». `todayIso` — сегодня по
 * Камчатке (для «как сейчас»). null — о дне тревога ничего не говорит.
 */
export function parkNoteForDay(alert: PlanParkAlert, dayIso: string | null, todayIso: string): ParkDayNote | null {
  const day = dayIso ?? todayIso;
  const published = kamchatkaDateOf(alert.published_iso);
  const horizon = published ? addDays(published, PARK_UNKNOWN_MAX_DAYS) : null;
  if (alert.alert_type === 'park_status_unknown') {
    if (horizon !== null && day > horizon) return null;
    return {
      severity: 'important',
      text: `${alert.title}. Уточните у дирекции парка, открыты ли маршруты, до выхода.`,
    };
  }
  const until = kamchatkaDateOf(alert.expires_iso);
  if (until === null || day <= until) {
    return {
      severity: 'critical',
      text: `Закрытие парка по сводке от ${ddmm(alert.published_iso)}: «${clipTitle(alert.title)}». Перед выходом уточните у дирекции парка.`,
    };
  }
  if (isIndefiniteClosure(`${alert.title} ${alert.description ?? ''}`) && horizon !== null && day <= horizon) {
    return {
      severity: 'important',
      text: `Статус парка на этот день не известен: сводка от ${ddmm(alert.published_iso)} сообщала о закрытии маршрутов без даты открытия, сводку об открытии мы пока не нашли. Уточните у дирекции парка.`,
    };
  }
  return null;
}

/** День плана, как его видит проверка: номер, дата, ссылки. */
export interface ParkCheckDay {
  day: number;
  title: string;
  dayIso: string | null;
  routeId?: string;
  tourId?: string;
}

export interface ParkDayVerdict {
  day: number;
  notes: ParkDayNote[];
}

export interface ParkPlanWarning {
  severity: 'critical' | 'important';
  message: string;
}

/**
 * Разложить тревоги по дням и собрать предупреждения плана: одно на тревогу,
 * с номерами дней. Чистая — под тестом без базы.
 */
export function parkVerdicts(
  days: readonly ParkCheckDay[],
  alerts: readonly PlanParkAlert[],
  todayIso: string,
): { perDay: ParkDayVerdict[]; warnings: ParkPlanWarning[] } {
  const perDay: ParkDayVerdict[] = [];
  const byAlert = new Map<string, { note: ParkDayNote; days: number[] }>();
  for (const d of days) {
    const mine = alerts.filter((a) =>
      (a.ref_kind === 'route' && d.routeId !== undefined && a.ref_id === d.routeId)
      || (a.ref_kind === 'tour' && d.tourId !== undefined && a.ref_id === d.tourId));
    const seen = new Set<string>();
    const notes: ParkDayNote[] = [];
    for (const a of mine) {
      if (seen.has(a.alert_id)) continue;
      seen.add(a.alert_id);
      const note = parkNoteForDay(a, d.dayIso, todayIso);
      if (!note) continue;
      notes.push(note);
      const key = `${a.alert_id}|${note.severity}`;
      const entry = byAlert.get(key) ?? { note, days: [] };
      if (!entry.days.includes(d.day)) entry.days.push(d.day);
      byAlert.set(key, entry);
    }
    if (notes.length > 0) {
      notes.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'critical' ? -1 : 1));
      perDay.push({ day: d.day, notes });
    }
  }
  const warnings: ParkPlanWarning[] = [...byAlert.values()].map(({ note, days: nums }) => ({
    severity: note.severity,
    message: `${nums.length === 1 ? `День ${nums[0]}` : `Дни ${nums.join(', ')}`}: ${note.text}`,
  }));
  warnings.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'critical' ? -1 : 1));
  return { perDay, warnings };
}

/** Предупреждение плана, когда статус парков прочитать не удалось. */
export const PARK_STATUS_UNREAD_NOTE =
  'Статус природных парков на дни плана проверить не удалось: о закрытии мы можем не знать. Перед выходом уточните у дирекции парка.';

/** День плана, который проверка дополняет: структурно, без цикла импорта с движком. */
export interface ParkPlanDay {
  day: number;
  title: string;
  dayWarnings: string[];
  routeId?: string;
  realTour?: { tourId: string };
}

/**
 * Проверить дни плана на закрытие парков и «не знаю»: строки дня ставятся
 * ПЕРВЫМИ (агент видит три строки дня, и закрытие не должно уступить место
 * совету про ботинки), предупреждения плана возвращаются отсортированными —
 * сначала закрытие. Отказ чтения — предупреждение «проверить не удалось» и
 * строка в лог с SQLSTATE, а не тишина.
 */
export async function applyPlanParkStatus(
  days: ParkPlanDay[],
  dateOfDay: (dayNum: number) => string | null,
  query: PlanParkQuery,
  now: Date = new Date(),
): Promise<{ warnings: ParkPlanWarning[]; unread: boolean }> {
  const routeIds = [...new Set(days.map((d) => d.routeId).filter((v): v is string => typeof v === 'string' && v !== ''))];
  const tourIds = [...new Set(days.map((d) => d.realTour?.tourId).filter((v): v is string => typeof v === 'string' && v !== ''))];
  if (routeIds.length === 0 && tourIds.length === 0) return { warnings: [], unread: false };
  let alerts: PlanParkAlert[];
  try {
    alerts = await loadPlanParkAlerts(query, { routeIds, tourIds });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
    console.error('[planner] статус парков на дни плана не прочитался, SQLSTATE', code);
    return { warnings: [{ severity: 'important', message: PARK_STATUS_UNREAD_NOTE }], unread: true };
  }
  if (alerts.length === 0) return { warnings: [], unread: false };
  const todayIso = kamchatkaDateOf(now.toISOString()) ?? now.toISOString().slice(0, 10);
  const { perDay, warnings } = parkVerdicts(
    days.map((d) => ({ day: d.day, title: d.title, dayIso: dateOfDay(d.day), routeId: d.routeId, tourId: d.realTour?.tourId })),
    alerts,
    todayIso,
  );
  for (const v of perDay) {
    const target = days.find((d) => d.day === v.day);
    if (!target) continue;
    const lines = v.notes.map((n) => n.text).filter((t) => !target.dayWarnings.includes(t));
    target.dayWarnings.unshift(...lines);
  }
  return { warnings, unread: false };
}
