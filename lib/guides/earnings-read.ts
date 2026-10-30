/**
 * Начисления гиду — одно чтение для кабинета на сайте (`GET /api/guide/earnings`)
 * и экрана «Заработок» в чате кабинета (lib/guides/chat-role, слово владельца
 * 30.10 «гид должен полностью управлять своей ролью из MAX»).
 *
 * Писателя `guide_earnings` в коде нет (lib/auth/guide-helpers.ts: он
 * проектируется вместе с выплатой, это решение владельца). Поэтому пустой
 * ответ — обычное состояние, и итоги при нуле строк — `null` («начислений не
 * было»), а не 0 ₽. Отменённое в суммы не идёт. Отказ базы — исключение:
 * вызывающий говорит «не загрузилось», а не «ноль».
 */

import { query } from '@/lib/database';

export const EARNINGS_PERIODS = ['week', 'month', 'year', 'all'] as const;
export type EarningsPeriod = (typeof EARNINGS_PERIODS)[number];
/** Окно чтения: периоды сайта и «30 дней» сводки чата. */
export type EarningsWindow = EarningsPeriod | '30d';

/** Граница периода — параметром-интервалом, без склейки строк в SQL. */
const PERIOD_INTERVAL: Record<EarningsWindow, string | null> = {
  week: '7 days',
  '30d': '30 days',
  month: '1 month',
  year: '1 year',
  all: null,
};

// Дата начисления: записанная дата, иначе дата выплаты, иначе создания строки.
const EARNING_DATE = `COALESCE(ge.date, ge.payment_date, ge.created_at::date)`;

interface EarningRow {
  id: string;
  amount: string;
  payment_status: string | null;
  payment_date: string | null;
  earning_date: string;
  notes: string | null;
  tour_name: string | null;
  tour_date: string | null;
}

interface SummaryRow {
  item_count: number;
  total_earned: string | null;
  total_paid: string | null;
  total_pending: string | null;
  tours_completed: number;
}

export interface GuideEarnings {
  period: EarningsWindow;
  summary: {
    count: number;
    totalEarnings: number | null;
    paid: number | null;
    pendingPayment: number | null;
    toursWithEarnings: number | null;
    averagePerItem: number | null;
  };
  items: Array<{
    id: string;
    amount: number;
    status: 'paid' | 'cancelled' | 'pending' | 'unknown';
    date: string;
    paymentDate: string | null;
    tourName: string | null;
    tourDate: string | null;
    notes: string | null;
  }>;
}

export async function readGuideEarnings(guideId: string, period: EarningsWindow): Promise<GuideEarnings> {
  const interval = PERIOD_INTERVAL[period];
  // $2 — интервал периода или NULL («за всё время»).
  const periodSql = `($2::interval IS NULL OR ${EARNING_DATE} >= CURRENT_DATE - $2::interval)`;

  const itemsResult = await query<EarningRow>(
    `SELECT ge.id, ge.amount::text AS amount, ge.payment_status,
            to_char(ge.payment_date, 'YYYY-MM-DD') AS payment_date,
            to_char(${EARNING_DATE}, 'YYYY-MM-DD') AS earning_date,
            ge.notes,
            gs.title AS tour_name,
            to_char(gs.tour_date, 'YYYY-MM-DD') AS tour_date
     FROM guide_earnings ge
     LEFT JOIN guide_schedule gs ON ge.schedule_id = gs.id
     WHERE ge.guide_id = $1 AND ${periodSql}
     ORDER BY ${EARNING_DATE} DESC, ge.created_at DESC
     LIMIT 500`,
    [guideId, interval],
  );

  // Отменённое в суммы не идёт; суммы при нуле строк — NULL, не 0.
  const summaryResult = await query<SummaryRow>(
    `SELECT
       COUNT(*) FILTER (WHERE ge.payment_status IS DISTINCT FROM 'cancelled')::int                         AS item_count,
       (SUM(ge.amount) FILTER (WHERE ge.payment_status IS DISTINCT FROM 'cancelled'))::text                AS total_earned,
       (SUM(ge.amount) FILTER (WHERE ge.payment_status = 'paid'))::text                      AS total_paid,
       (SUM(ge.amount) FILTER (WHERE ge.payment_status = 'pending'))::text                   AS total_pending,
       COUNT(DISTINCT ge.schedule_id) FILTER (WHERE ge.payment_status IS DISTINCT FROM 'cancelled')::int   AS tours_completed
     FROM guide_earnings ge
     WHERE ge.guide_id = $1 AND ${periodSql}`,
    [guideId, interval],
  );
  const s = summaryResult.rows[0];
  const count = s?.item_count ?? 0;
  const money = (v: string | null | undefined): number | null =>
    count === 0 ? null : v == null ? 0 : Number(v);
  const totalEarned = money(s?.total_earned);

  return {
    period,
    summary: {
      count,
      totalEarnings: totalEarned,
      paid: money(s?.total_paid),
      pendingPayment: money(s?.total_pending),
      // Туры считаются по строкам расписания; начисление без привязки
      // к расписанию в это число не входит — и сказано об этом на экране.
      toursWithEarnings: count === 0 ? null : s?.tours_completed ?? 0,
      averagePerItem: count === 0 || totalEarned === null ? null : Math.round(totalEarned / count),
    },
    items: itemsResult.rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      status: r.payment_status === 'paid' || r.payment_status === 'cancelled' || r.payment_status === 'pending' ? r.payment_status : 'unknown',
      date: r.earning_date,
      paymentDate: r.payment_date,
      tourName: r.tour_name,
      tourDate: r.tour_date,
      notes: r.notes,
    })),
  };
}
