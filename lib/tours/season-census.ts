/**
 * Перепись сезонов живых туров: какие туры сегодня принимают заявку на ЛЮБУЮ
 * дату и почему (#3347, план по открытым задачам 14.11).
 *
 * Правило 08.10 (`lib/tours/request-window.ts`): у тура без календаря дата
 * принимается только внутри записанного сезона — пока сезон не кончился.
 * Сезон прошёл или не записан — окна нет, дату согласует оператор. Сезон при
 * этом записывают вперёд (миграция 1183). В ноябре сезон 2026 года кончился у
 * всех летних туров, у которых он записан только на этот год, и такой тур
 * принимает и зимнюю дату — в форме заявки, в планере, у ИИ-агента.
 *
 * Сколько таких туров, из репозитория не видно. Перепись их называет; сезон
 * следующего года она НЕ придумывает: его знает только оператор (§4.0).
 *
 * Тур с календарём считается отдельно: его даты — слово оператора о каждой
 * дате, и сезон на них не влияет.
 *
 * Только чтение. В ответе — названия туров и компаний с витрины; имён людей,
 * телефонов и заявок нет.
 */
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { keepsScheduleSql } from '@/lib/tours/schedule';
import { requestWindow, type RequestWindow } from '@/lib/tours/request-window';

export const TOUR_SEASON_CENSUS_SQL = `
  SELECT ot.id::text AS id, ot.title, ot.activity_type,
         p.name AS partner_name,
         ot.season_start::text AS season_start, ot.season_end::text AS season_end,
         ot.duration_type, ot.multi_day_count, ot.duration_hours,
         ${keepsScheduleSql('ot.id')} AS keeps_schedule
    FROM operator_tours ot
    JOIN partners p ON p.id = ot.operator_id
   WHERE ${publicTourSql('ot')}
   ORDER BY p.name, ot.title, ot.id`;

export interface SeasonCensusRow {
  id: string;
  title: string | null;
  activity_type: string | null;
  partner_name: string | null;
  season_start: string | null;
  season_end: string | null;
  duration_type: string | null;
  multi_day_count: number | string | null;
  duration_hours: number | string | null;
  keeps_schedule: boolean;
}

/**
 * Что сезон тура значит сегодня:
 *   `running`      — сезон идёт, дата принимается внутри него;
 *   `ahead`        — сезон записан вперёд, до него дата не принимается;
 *   `past`         — записанный сезон кончился: дата принимается любая;
 *   `not_recorded` — сезон не записан: дата принимается любая;
 *   `too_short`    — сезон короче самого тура: запись сезона неверна, окна нет.
 */
export type SeasonState = 'running' | 'ahead' | 'past' | 'not_recorded' | 'too_short';

export const SEASON_STATES: readonly SeasonState[] = ['running', 'ahead', 'past', 'not_recorded', 'too_short'];

function num(v: number | string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function seasonStateOf(w: RequestWindow, today: string): SeasonState {
  if (w.kind === 'season') return w.seasonStart > today ? 'ahead' : 'running';
  return w.why;
}

export interface SeasonCensusTour {
  id: string;
  title: string | null;
  partner: string | null;
  activity_type: string | null;
  season_start: string | null;
  season_end: string | null;
  state: SeasonState;
}

export interface SeasonCensus {
  today: string;
  tours_total: number;
  /** Туры с календарём: их даты — слово оператора, сезон на них не влияет. */
  with_calendar: number;
  without_calendar: number;
  /** Туры без календаря по состоянию сезона. */
  without_calendar_by_state: Record<SeasonState, number>;
  /** Без календаря и без действующего окна сезона: заявка на любую дату. */
  accepts_any_date_total: number;
  accepts_any_date: SeasonCensusTour[];
  verdict: string;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Разбор строк переписи. Чистая функция: `today` — день по Камчатке. */
export function buildSeasonCensus(rows: readonly SeasonCensusRow[], today: string): SeasonCensus {
  const byState: Record<SeasonState, number> = { running: 0, ahead: 0, past: 0, not_recorded: 0, too_short: 0 };
  const anyDate: SeasonCensusTour[] = [];
  let withCalendar = 0;

  for (const r of rows) {
    if (r.keeps_schedule) { withCalendar += 1; continue; }
    const state = seasonStateOf(requestWindow({
      season_start: r.season_start, season_end: r.season_end,
      duration_type: r.duration_type, multi_day_count: num(r.multi_day_count), duration_hours: num(r.duration_hours),
    }, today), today);
    byState[state] += 1;
    if (state === 'past' || state === 'not_recorded' || state === 'too_short') {
      anyDate.push({
        id: r.id, title: r.title, partner: r.partner_name, activity_type: r.activity_type,
        season_start: r.season_start, season_end: r.season_end, state,
      });
    }
  }

  const total = rows.length;
  const without = total - withCalendar;
  let verdict: string;
  if (total === 0) {
    // Ноль при нулевом входе — не «всё хорошо» (§4.0).
    verdict = 'Живых туров на витрине перепись не нашла — судить не о чем; проверьте отбор.';
  } else if (anyDate.length === 0) {
    verdict = `Туров на витрине ${total}. Заявку на любую дату не принимает ни один: у туров без календаря сезон идёт или записан вперёд.`;
  } else {
    verdict = `Туров на витрине ${total}, без календаря ${without}. Заявку на любую дату ${plural(anyDate.length, 'принимает', 'принимают', 'принимают')} `
      + `${anyDate.length}: сезон прошёл — ${byState.past}, сезон не записан — ${byState.not_recorded}, сезон короче тура — ${byState.too_short}. `
      + 'Сезон следующего года знает только оператор: перепись его не выводит.';
  }

  return {
    today,
    tours_total: total,
    with_calendar: withCalendar,
    without_calendar: without,
    without_calendar_by_state: byState,
    accepts_any_date_total: anyDate.length,
    accepts_any_date: anyDate,
    verdict,
  };
}

export async function runTourSeasonCensus(today: string): Promise<SeasonCensus> {
  const { rows } = await pool.query(TOUR_SEASON_CENSUS_SQL);
  return buildSeasonCensus(rows as SeasonCensusRow[], today);
}
