/**
 * GET /api/hub/operator/reports?type=bookings|finance|clients&format=json|csv
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { toCSV } from '@/lib/operator/csv';
import { CANCELLED_STATUS_PARAM } from '@/lib/payments/release-eligibility';
import { PLATFORM_COMMISSION_PERCENT } from '@/lib/payments/commission';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireOperator(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const type   = searchParams.get('type')   ?? 'bookings';
  const format = searchParams.get('format') ?? 'json';

  // Общий helper (lib/auth/operator-helpers.ts): партнёр может держать
  // несколько записей под одним user_id (гид + оператор — обычный
  // камчатский случай), выбор без фильтра по category возвращал бы
  // произвольную из них.
  const operatorId = await getOperatorPartnerId(auth.userId);
  if (!operatorId) return NextResponse.json({ error: 'Not an operator' }, { status: 403 });

  if (type === 'bookings') {
    const rows = await pool.query<Record<string, unknown>>(
      `SELECT ob.id,
              ot.title AS tour,
              ob.booking_date::text AS date,
              ob.tourist_name AS client,
              ob.tourist_phone AS phone,
              ob.participants,
              ob.final_price,
              ob.booking_status AS status,
              ob.payment_status AS payment,
              ob.created_at::text AS created
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       WHERE ot.operator_id = $1 AND ob.deleted_at IS NULL
       ORDER BY ob.created_at DESC
       LIMIT 500`,
      [operatorId]
    );

    if (format === 'csv') {
      const csv = toCSV(rows.rows, {
        id: 'ID', tour: 'Тур', date: 'Дата', client: 'Клиент',
        phone: 'Телефон', participants: 'Участников', final_price: 'Сумма',
        status: 'Статус', payment: 'Оплата', created: 'Создано',
      });
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="bookings-${Date.now()}.csv"`,
        },
      });
    }
    return NextResponse.json({ data: rows.rows, total: rows.rowCount ?? 0 });
  }

  if (type === 'finance') {
    // Источник — брони, а НЕ tour_payments, и это решение (25.09):
    // tour_payments пишут только CloudPayments-вебхук кабинета и
    // /api/bookings/tour, а оплата по СБП Точки (QR из чата Кузьмича)
    // строки там не оставляет. Отчёт из tour_payments молча потерял бы
    // целый канал оплаты — неполнота выглядела бы как «продаж нет».
    //
    // Что исправлено против прежней версии:
    //   • отменённые брони (все статусы отмены — CANCELLED_BOOKING_STATUSES,
    //     тот же список, что гейтит выплату) больше не считаются выручкой;
    //   • комиссия берётся ЗАФИКСИРОВАННАЯ при оплате (operator_commissions.
    //     amount — её пишет recordCommissionFromBooking во всех трёх
    //     приёмниках), а текущая ставка партнёра — только там, где записи о
    //     начислении нет. Прежде вся история пересчитывалась по сегодняшней
    //     ставке: поменяй её владелец — поменялось бы прошлое;
    //   • сколько броней посчитано по текущей ставке, отчёт говорит сам
    //     (fee_estimated_bookings) — «зафиксировано» и «оценено» не одно и то же;
    //   • месяц — по дате оплаты (paid_at), а не создания брони.
    const rows = await pool.query<Record<string, unknown>>(
      `SELECT DATE_TRUNC('month', COALESCE(ob.paid_at, ob.created_at))::date::text AS month,
              COUNT(*) AS bookings,
              SUM(ob.final_price) AS revenue,
              SUM(COALESCE(oc.amount, ob.final_price * COALESCE(p.commission_current, $3) / 100)) AS platform_fee,
              SUM(ob.final_price - COALESCE(oc.amount, ob.final_price * COALESCE(p.commission_current, $3) / 100)) AS net,
              COUNT(*) FILTER (WHERE oc.amount IS NULL) AS fee_estimated_bookings
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       LEFT JOIN partners p ON p.id = ot.operator_id
       LEFT JOIN LATERAL (
         SELECT SUM(c.amount) AS amount
           FROM operator_commissions c
          WHERE c.booking_id = ob.id AND c.status <> 'cancelled'
       ) oc ON TRUE
       WHERE ot.operator_id = $1
         AND ob.payment_status = 'paid'
         AND ob.booking_status <> ALL($2::text[])
         AND ob.deleted_at IS NULL
       GROUP BY 1 ORDER BY 1 DESC
       LIMIT 24`,
      [operatorId, CANCELLED_STATUS_PARAM, PLATFORM_COMMISSION_PERCENT]
    );

    if (format === 'csv') {
      const csv = toCSV(rows.rows, {
        month: 'Месяц', bookings: 'Бронирований', revenue: 'Выручка',
        platform_fee: 'Комиссия платформы', net: 'Чистая выручка',
        fee_estimated_bookings: 'Комиссия по текущей ставке (броней)',
      });
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="finance-${Date.now()}.csv"`,
        },
      });
    }
    return NextResponse.json({ data: rows.rows });
  }

  if (type === 'clients') {
    const rows = await pool.query<Record<string, unknown>>(
      `SELECT ob.tourist_name AS name,
              ob.tourist_phone AS phone,
              ob.tourist_email AS email,
              COUNT(*) AS bookings,
              SUM(ob.final_price) AS total_spent,
              MAX(ob.created_at)::text AS last_booking
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       WHERE ot.operator_id = $1
         AND ob.deleted_at IS NULL
         AND ob.tourist_name IS NOT NULL
       GROUP BY ob.tourist_name, ob.tourist_phone, ob.tourist_email
       ORDER BY COUNT(*) DESC
       LIMIT 300`,
      [operatorId]
    );

    if (format === 'csv') {
      const csv = toCSV(rows.rows, {
        name: 'Имя', phone: 'Телефон', email: 'Email',
        bookings: 'Бронирований', total_spent: 'Потрачено', last_booking: 'Последнее',
      });
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="clients-${Date.now()}.csv"`,
        },
      });
    }
    return NextResponse.json({ data: rows.rows, total: rows.rowCount ?? 0 });
  }

  return NextResponse.json({ error: 'Неизвестный тип отчёта' }, { status: 400 });
}
