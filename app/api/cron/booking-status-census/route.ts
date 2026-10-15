/**
 * GET /api/cron/booking-status-census — какие статусы броней лежат в базе на
 * самом деле. Bearer CRON_SECRET, только чтение, ничего не меняет.
 *
 * ЗАЧЕМ (аудит 15.10, A11). У `operator_bookings.booking_status` нет CHECK, и
 * словарей статусов было два, расходившихся между собой (`rejected` в одном,
 * `no_show` в другом). Словарь сведён в один (`lib/types/statuses.ts`), но
 * ставить CHECK по нему вслепую нельзя: строка вне словаря, которой никто не
 * видел, уронит VALIDATE — или, хуже, заставит «поправить» живые данные под
 * правило. Значения на проде до этой переписи не считал никто. Сначала
 * замер, потом CHECK — отдельным шагом.
 *
 * Что считает:
 *   - operator_bookings.booking_status — каждое значение с числом строк (всех
 *     и не удалённых), первым и последним появлением; какие вне единого
 *     словаря; есть ли `rejected` (писателя у него нет, читается он только в
 *     защитных WHERE);
 *   - у броней жилья (accommodation_bookings.status) и проката снаряжения
 *     (gear_rentals.status) своё поле статуса со своим перечнем — их значения
 *     считаются рядом, со своими CHECK, единым словарём они не судятся;
 *   - какие CHECK уже стоят на этих колонках в САМОЙ базе прода (дрейф после
 *     baseline из репозитория не виден).
 *
 * Отказ любого замера — 500 с именем замера и SQLSTATE: «переписи нет» не
 * равно «статусов вне словаря нет» (§4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { BOOKING_STATUSES } from '@/lib/types/statuses';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface StatusRow {
  status: string | null;
  rows: string;
  /** Только у operator_bookings: строки без deleted_at. У прочих таблиц мягкого удаления нет. */
  live?: string;
  first_at: string | null;
  last_at: string | null;
}

interface CheckRow {
  table_name: string;
  column_name: string;
  name: string;
  validated: boolean;
  def: string;
}

type Measure = 'operator_bookings' | 'accommodation_bookings' | 'gear_rentals' | 'check_constraints';

const OPERATOR_BOOKINGS_SQL = `
  SELECT booking_status AS status,
         COUNT(*)::text AS rows,
         COUNT(*) FILTER (WHERE deleted_at IS NULL)::text AS live,
         MIN(created_at)::text AS first_at,
         MAX(created_at)::text AS last_at
    FROM operator_bookings
   GROUP BY booking_status
   ORDER BY COUNT(*) DESC, booking_status`;

const ACCOMMODATION_BOOKINGS_SQL = `
  SELECT status,
         COUNT(*)::text AS rows,
         MIN(created_at)::text AS first_at,
         MAX(created_at)::text AS last_at
    FROM accommodation_bookings
   GROUP BY status
   ORDER BY COUNT(*) DESC, status`;

const GEAR_RENTALS_SQL = `
  SELECT status,
         COUNT(*)::text AS rows,
         MIN(created_at)::text AS first_at,
         MAX(created_at)::text AS last_at
    FROM gear_rentals
   GROUP BY status
   ORDER BY COUNT(*) DESC, status`;

// CHECK, которые база уже держит на трёх колонках статуса. Пустой ответ при
// успешном запросе — «CHECK нет», это знание; упавший запрос — «не знаю».
const CHECK_CONSTRAINTS_SQL = `
  SELECT rel.relname::text AS table_name,
         a.attname::text   AS column_name,
         c.conname::text   AS name,
         c.convalidated    AS validated,
         pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class rel     ON rel.oid = c.conrelid
    JOIN pg_namespace n   ON n.oid = rel.relnamespace
    JOIN pg_attribute a   ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'c'
     AND n.nspname = 'public'
     AND (rel.relname::text, a.attname::text) IN (('operator_bookings', 'booking_status'),
                                                  ('accommodation_bookings', 'status'),
                                                  ('gear_rentals', 'status'))
   ORDER BY rel.relname, c.conname`;

const DICTIONARY: readonly string[] = BOOKING_STATUSES;

function shapeStatus(r: StatusRow) {
  return {
    status: r.status,
    rows: Number(r.rows),
    ...(r.live !== undefined ? { live: Number(r.live) } : {}),
    first_at: r.first_at,
    last_at: r.last_at,
  };
}

function checksFor(checks: CheckRow[] | null, table: string) {
  if (checks === null) return null;
  return checks
    .filter((c) => c.table_name === table)
    .map((c) => ({ name: c.name, column: c.column_name, validated: c.validated, def: c.def }));
}

function sqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }

  const measures: Array<[Measure, string]> = [
    ['operator_bookings', OPERATOR_BOOKINGS_SQL],
    ['accommodation_bookings', ACCOMMODATION_BOOKINGS_SQL],
    ['gear_rentals', GEAR_RENTALS_SQL],
    ['check_constraints', CHECK_CONSTRAINTS_SQL],
  ];
  const settled = await Promise.allSettled(measures.map(([, sql]) => pool.query(sql)));

  const failed: Array<{ measure: Measure; sqlstate: string | null }> = [];
  const got = new Map<Measure, unknown[]>();
  settled.forEach((s, i) => {
    const measure = measures[i][0];
    if (s.status === 'fulfilled') {
      got.set(measure, s.value.rows);
    } else {
      const sqlstate = sqlstateOf(s.reason);
      failed.push({ measure, sqlstate });
      console.error(
        `[booking-status-census] замер ${measure} не выполнился`,
        `sqlstate=${sqlstate ?? 'нет кода'}`,
        s.reason instanceof Error ? s.reason.message : s.reason,
      );
    }
  });

  const checks = (got.get('check_constraints') as CheckRow[] | undefined) ?? null;

  const opRows = got.get('operator_bookings') as StatusRow[] | undefined;
  const operatorBookings = opRows === undefined ? null : (() => {
    const byStatus = opRows.map((r) => ({ ...shapeStatus(r), in_dictionary: r.status !== null && DICTIONARY.includes(r.status) }));
    const outside = byStatus.filter((r) => !r.in_dictionary);
    const seen = new Set(opRows.map((r) => r.status));
    return {
      column: 'booking_status',
      total_rows: byStatus.reduce((n, r) => n + r.rows, 0),
      by_status: byStatus,
      outside_dictionary: outside,
      outside_dictionary_rows: outside.reduce((n, r) => n + r.rows, 0),
      rejected_rows: byStatus.find((r) => r.status === 'rejected')?.rows ?? 0,
      dictionary_without_rows: DICTIONARY.filter((s) => !seen.has(s)),
      // CHECK по словарю проверяет ВСЕ строки, включая мягко удалённые.
      check_by_dictionary_would_validate_now: outside.length === 0,
      check_constraints: checksFor(checks, 'operator_bookings'),
    };
  })();

  const ownTable = (measure: 'accommodation_bookings' | 'gear_rentals') => {
    const rows = got.get(measure) as StatusRow[] | undefined;
    if (rows === undefined) return null;
    const byStatus = rows.map(shapeStatus);
    return {
      column: 'status',
      total_rows: byStatus.reduce((n, r) => n + r.rows, 0),
      by_status: byStatus,
      check_constraints: checksFor(checks, measure),
    };
  };

  const body = {
    ok: failed.length === 0,
    probe: 'booking_status_census_v1',
    checked_at: new Date().toISOString(),
    dictionary: DICTIONARY,
    operator_bookings: operatorBookings,
    own_status_columns: {
      accommodation_bookings: ownTable('accommodation_bookings'),
      gear_rentals: ownTable('gear_rentals'),
    },
    failed,
  };
  return NextResponse.json(failed.length === 0 ? body : { ...body, error: 'перепись выполнилась не целиком' }, {
    status: failed.length === 0 ? 200 : 500,
  });
}
