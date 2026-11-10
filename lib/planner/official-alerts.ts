/**
 * lib/planner/official-alerts.ts — штормовые предупреждения, паводок, лавины,
 * оползни и цунами на днях плана поездки (#2930, шаг 2 поправленного плана).
 *
 * До этой правки план получал из ленты `external_alerts` три рода: извержение
 * и дорогу (сводки МЧС, lib/safety/mchs-bulletin) и закрытия парков
 * (lib/planner/park-status). Штормовое предупреждение Росгидромета на день
 * переезда или паводок на день сплава в плане не появлялись вовсе — при том,
 * что «перед выездом» (#2969) их уже видит.
 *
 * Правило охвата — то же, что у «перед выездом» и у Rescue,
 * `matchOfficialAlerts` (lib/agents/evo/rescue-judge): своё правило «какое
 * предупреждение касается какого дня» разошлось бы с ними молча.
 *  - своя зона дня: severity 2+ касается любого дня; паводок любой силы —
 *    дня на воде;
 *  - без зоны: только паводок severity 2+ и только день на воде, с
 *    оговоркой «место по сводке не установлено»;
 *  - дата решает: предупреждение касается дня, только если действует в
 *    этот день по Камчатке. Плана без дат нет у человека; без даты день не
 *    судится — нынешний шторм о дне через месяц ничего не говорит.
 *
 * Рода — только те, что меняют решение о дне и не приходят в план другим
 * путём: вулкан и дорога — сводками МЧС, парки — своей проверкой.
 *
 * Не смогли прочитать — предупреждение плана «не прочитаны» (§4.0), а не
 * «предупреждений нет».
 */

import { matchOfficialAlerts, type OfficialAlert } from '@/lib/agents/evo/rescue-judge';
import { alertOrigin } from '@/lib/safety/alert-origin';
import { UTC_WALL_NOW_SQL, utcWallIsoSql } from '@/lib/db/timestamp-iso';
import { clipTitle, kamchatkaDateOf, type PlanParkQuery } from './park-status';
import { ZONE_NAMES, type ZoneId } from './constants';

/** Рода ленты, которые план берёт этой проверкой. */
export const PLAN_OFFICIAL_TYPES = ['weather', 'flood', 'avalanche', 'landslide', 'tsunami_warning'] as const;

export const PLAN_OFFICIAL_ALERTS_SQL = `
  SELECT id::int AS id, alert_type, severity::int AS severity, title, description, affected_zones,
         ${utcWallIsoSql('expires_at')} AS expires_at, source_url, external_id
    FROM external_alerts
   WHERE expires_at > ${UTC_WALL_NOW_SQL}
     AND alert_type = ANY($1::text[])
     AND (severity >= 2 OR alert_type = 'flood')
   ORDER BY severity DESC, created_at DESC
   LIMIT 100`;

export interface PlanOfficialAlert extends OfficialAlert {
  external_id: string | null;
}

/** Начало строки дня — по нему строку узнаёт правка плана (`isOfficialAlertNote`). */
const NOTE_PREFIX = 'Официальное предупреждение';

export function isOfficialAlertNote(text: string): boolean {
  return text.startsWith(`${NOTE_PREFIX} `) || text.startsWith(`${NOTE_PREFIX}:`);
}

/** Предупреждение плана, когда ленту прочитать не удалось. */
export const OFFICIAL_ALERTS_UNREAD_NOTE =
  'Штормовые предупреждения, паводок и лавинная опасность на дни плана не прочитаны — о них мы можем не знать. Обстановку проверьте ближе к выезду; экстренный вызов — 112.';

function ddmm(iso: string): string | null {
  const d = kamchatkaDateOf(iso);
  return d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : null;
}

/** Строка дня: что, чьё и до какого числа. */
export function officialAlertNote(alert: PlanOfficialAlert, unplaced: boolean): string {
  const source = alertOrigin(alert.external_id, alert.source_url)?.label ?? 'источник не распознан';
  const until = typeof alert.expires_at === 'string' ? ddmm(alert.expires_at) : ddmm(alert.expires_at.toISOString());
  const where = unplaced ? ' Место по сводке не установлено, а день — на воде.' : '';
  return `${NOTE_PREFIX} (${source}): «${clipTitle(alert.title)}»${until ? `, действует до ${until}` : ''}.${where} Решение о выходе — с оператором или гидом; экстренный вызов — 112.`;
}

/** День плана, как его видит проверка: структурно, без цикла импорта с движком. */
export interface OfficialPlanDay {
  day: number;
  type: string;
  zone: ZoneId;
  title: string;
  activityType?: string;
  dayWarnings: string[];
}

/** Зоны дня: у переезда — обе, их названия стоят в заголовке; Петропавловск — Авачинская. */
export function dayZones(d: { type: string; zone: ZoneId; title: string }): ZoneId[] {
  const zones = new Set<ZoneId>([d.zone]);
  if (d.type === 'travel') {
    for (const [id, name] of Object.entries(ZONE_NAMES) as Array<[ZoneId, string]>) {
      if (d.title.includes(name)) zones.add(id);
    }
    if (d.title.includes('Петропавловск')) zones.add('avachinsky');
  }
  return [...zones];
}

/**
 * Строки дней по предупреждениям (чистая — под тестом без базы). День без
 * даты не судится. Возвращает номера дней со строками.
 */
export function officialNotesByDay(
  days: readonly Pick<OfficialPlanDay, 'day' | 'type' | 'zone' | 'title' | 'activityType'>[],
  dateOfDay: (dayNum: number) => string | null,
  alerts: readonly PlanOfficialAlert[],
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const d of days) {
    const date = dateOfDay(d.day);
    if (!date) continue;
    const bookings = dayZones(d).map((zone) => ({
      id: d.day, booking_date: date, tour_title: d.title, participants: 1,
      activity_type: d.activityType ?? null, location_type: null, zone,
    }));
    const { matches } = matchOfficialAlerts(bookings, [...alerts]);
    const notes: string[] = [];
    const seen = new Set<number>();
    for (const m of matches) {
      if (seen.has(m.alert.id)) continue;
      seen.add(m.alert.id);
      notes.push(officialAlertNote(m.alert as PlanOfficialAlert, m.unplaced));
    }
    if (notes.length > 0) out.set(d.day, notes);
  }
  return out;
}

/**
 * Проверить дни плана: строки ставятся первыми в день (как закрытие парка),
 * без повторов. Отказ чтения — предупреждение «не прочитаны» и строка в лог с
 * SQLSTATE; дни при этом не трогаются.
 */
export async function applyPlanOfficialAlerts(
  days: OfficialPlanDay[],
  dateOfDay: (dayNum: number) => string | null,
  query: PlanParkQuery,
): Promise<{ unread: boolean; days: number[] }> {
  if (!days.some((d) => dateOfDay(d.day) !== null)) return { unread: false, days: [] };
  let alerts: PlanOfficialAlert[];
  try {
    alerts = (await query<PlanOfficialAlert>(PLAN_OFFICIAL_ALERTS_SQL, [[...PLAN_OFFICIAL_TYPES]])).rows;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
    console.error('[planner] штормовые и паводковые предупреждения на дни плана не прочитались, SQLSTATE', code);
    return { unread: true, days: [] };
  }
  const byDay = officialNotesByDay(days, dateOfDay, alerts);
  for (const [dayNum, notes] of byDay) {
    const target = days.find((d) => d.day === dayNum);
    if (!target) continue;
    target.dayWarnings.unshift(...notes.filter((n) => !target.dayWarnings.includes(n)));
  }
  return { unread: false, days: [...byDay.keys()].sort((a, b) => a - b) };
}

/** Предупреждение плана: какие дни задеты. Пусто — null. */
export function officialAlertsPlanWarning(dayNums: readonly number[]): string | null {
  if (dayNums.length === 0) return null;
  const which = dayNums.length === 1 ? `День ${dayNums[0]}` : `Дни ${dayNums.join(', ')}`;
  return `${which}: действует официальное предупреждение (шторм, паводок, лавины, оползни или цунами) — строка под днём.`;
}
