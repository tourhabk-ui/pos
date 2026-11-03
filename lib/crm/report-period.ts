/**
 * Отчёт оператора за период для чата MAX/Telegram (K.ai-план, PR-A1;
 * решения владельца 03.11: считать И по дате создания брони, И по дате
 * поездки; деньги — только оплаченные; без округления).
 *
 * Только чтение и только числа: ни имён, ни телефонов — отчёт уходит и в
 * Telegram (pd-guard). Период — по камчатскому времени (UTC+12, без
 * перехода), неделя — пн–вс.
 */
import { pool } from '@/lib/db-pool';

export type ReportPeriod = 'this_week' | 'last_week' | 'this_month' | 'last_month';
export const REPORT_PERIODS: readonly ReportPeriod[] = ['this_week', 'last_week', 'this_month', 'last_month'];

const KAMCHATKA_OFFSET_MS = 12 * 3_600_000;

/** Границы периода: даты YYYY-MM-DD включительно, по Камчатке. */
export function periodRange(period: ReportPeriod, nowMs: number): { from: string; to: string } {
  const k = new Date(nowMs + KAMCHATKA_OFFSET_MS); // UTC-геттеры = камчатское время
  const y = k.getUTCFullYear(); const m = k.getUTCMonth(); const d = k.getUTCDate();
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  if (period === 'this_month') return { from: iso(Date.UTC(y, m, 1)), to: iso(Date.UTC(y, m + 1, 0)) };
  if (period === 'last_month') return { from: iso(Date.UTC(y, m - 1, 1)), to: iso(Date.UTC(y, m, 0)) };
  const dow = (k.getUTCDay() + 6) % 7; // пн = 0
  const monday = Date.UTC(y, m, d - dow - (period === 'last_week' ? 7 : 0));
  return { from: iso(monday), to: iso(monday + 6 * 86_400_000) };
}

export interface BookingCounts { total: number; byStatus: Record<string, number>; paidRub: number; perTour: Array<{ title: string; n: number }> }
export interface PeriodReport { period: ReportPeriod; from: string; to: string; byCreated: BookingCounts; byTrip: BookingCounts; leads: number }

interface Row { basis: 'created' | 'trip'; title: string; status: string; n: number | string; paid: number | string | null }

/** Камчатские сутки from..to → границы timestamptz для created_at. */
function createdBounds(from: string, to: string): [string, string] {
  const start = Date.parse(`${from}T00:00:00Z`) - KAMCHATKA_OFFSET_MS;
  const end = Date.parse(`${to}T00:00:00Z`) + 86_400_000 - KAMCHATKA_OFFSET_MS;
  return [new Date(start).toISOString(), new Date(end).toISOString()];
}

export const REPORT_SQL = `
  SELECT x.basis, t.title, b.booking_status AS status, COUNT(*)::int AS n,
         COALESCE(SUM(b.final_price) FILTER (WHERE b.payment_status = 'paid'), 0) AS paid
    FROM operator_bookings b
    JOIN operator_tours t ON t.id = b.operator_tour_id
    CROSS JOIN LATERAL (VALUES
      ('created', b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz),
      ('trip', b.booking_date BETWEEN $4::date AND $5::date)
    ) AS x(basis, hit)
   WHERE t.operator_id = $1::uuid AND b.deleted_at IS NULL AND x.hit
   GROUP BY x.basis, t.title, b.booking_status`;

export const LEADS_SQL = `
  SELECT COUNT(*)::int AS n FROM leads
   WHERE operator_id = $1 AND is_self = FALSE AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`;

export function foldRows(rows: readonly Row[], basis: Row['basis']): BookingCounts {
  const out: BookingCounts = { total: 0, byStatus: {}, paidRub: 0, perTour: [] };
  const tours = new Map<string, number>();
  for (const r of rows) {
    if (r.basis !== basis) continue;
    const n = Number(r.n);
    out.total += n;
    out.byStatus[r.status] = (out.byStatus[r.status] ?? 0) + n;
    out.paidRub += Number(r.paid ?? 0);
    tours.set(r.title, (tours.get(r.title) ?? 0) + n);
  }
  out.perTour = [...tours].map(([title, n]) => ({ title, n })).sort((a, b) => b.n - a.n || a.title.localeCompare(b.title, 'ru'));
  return out;
}

/** null — не прочиталось (цифры не выдумываем). */
export async function loadPeriodReport(partnerId: string, period: ReportPeriod, nowMs: number = Date.now()): Promise<PeriodReport | null> {
  const { from, to } = periodRange(period, nowMs);
  const [cs, ce] = createdBounds(from, to);
  try {
    const [b, l] = await Promise.all([
      pool.query<Row>(REPORT_SQL, [partnerId, cs, ce, from, to]),
      pool.query<{ n: number | string }>(LEADS_SQL, [partnerId, cs, ce]),
    ]);
    return { period, from, to, byCreated: foldRows(b.rows, 'created'), byTrip: foldRows(b.rows, 'trip'), leads: Number(l.rows[0]?.n ?? 0) };
  } catch (err) {
    console.error('[report-period] не прочитан, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return null;
  }
}

const STATUS_RU: Record<string, string> = {
  new: 'новых', confirmed: 'подтверждено', pending_payment: 'ждёт оплаты', completed: 'состоялось', cancelled: 'отменено', no_show: 'не пришли',
};
const STATUS_ORDER = ['new', 'confirmed', 'pending_payment', 'completed', 'cancelled', 'no_show'];

const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
/** Без округления: рубли как есть, копейки — если есть. */
export function rub(v: number): string {
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/\u00a0/g, ' ')} ₽`;
}
function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function countsLines(c: BookingCounts): string[] {
  if (c.total === 0) return ['броней нет'];
  const parts = STATUS_ORDER.filter((s) => c.byStatus[s]).map((s) => `${STATUS_RU[s]} ${c.byStatus[s]}`);
  for (const s of Object.keys(c.byStatus)) if (!STATUS_ORDER.includes(s)) parts.push(`${s} ${c.byStatus[s]}`);
  const lines = [`броней ${c.total}: ${parts.join(', ')}`, `оплачено: ${rub(c.paidRub)}`];
  const top = c.perTour.slice(0, 5).map((t) => `«${esc(t.title)}» — ${t.n}`);
  if (top.length) lines.push(`по турам: ${top.join('; ')}${c.perTour.length > 5 ? ` и ещё ${c.perTour.length - 5}` : ''}`);
  return lines;
}

export const PERIOD_LABEL: Record<ReportPeriod, string> = {
  this_week: 'Эта неделя', last_week: 'Прошлая неделя', this_month: 'Этот месяц', last_month: 'Прошлый месяц',
};
export const REPORT_FAILED_TEXT = 'Не смог прочитать брони — цифры не показываю. Попробуйте позже или откройте отчёт на сайте.';

/** Текст отчёта (HTML для MAX/Telegram). Без ПД. */
export function periodReportText(r: PeriodReport | null): string {
  if (!r) return REPORT_FAILED_TEXT;
  return [
    `<b>${PERIOD_LABEL[r.period]}: ${ru(r.from)}–${ru(r.to)}</b>`,
    `Новых заявок: ${r.leads}`,
    '',
    '<b>По дате оформления брони</b>',
    ...countsLines(r.byCreated).map((s) => `• ${s}`),
    '',
    '<b>По дате поездки</b>',
    ...countsLines(r.byTrip).map((s) => `• ${s}`),
    '',
    'Оплачено — только брони со статусом оплаты «оплачено». Время — камчатское.',
  ].join('\n');
}
