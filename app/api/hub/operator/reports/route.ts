/**
 * GET /api/hub/operator/reports?type=bookings|finance|clients&format=json|csv
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';

export const dynamic = 'force-dynamic';

function toCSV(rows: Record<string, unknown>[], headers: Record<string, string>): string {
  const keys = Object.keys(headers);
  const head = keys.map(k => headers[k]).join(';');
  const body = rows.map(r =>
    keys.map(k => {
      const v = String(r[k] ?? '');
      return v.includes(';') || v.includes('"') || v.includes('\n')
        ? `"${v.replace(/"/g, '""')}"`
        : v;
    }).join(';')
  ).join('\n');
  return '\uFEFF' + head + '\n' + body; // BOM for Excel
}

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
    // Комиссия — по ДОГОВОРНОЙ ставке оператора (partners.commission_current),
    // не по захардкоженным 10%: тот же баг уже находили и чинили в
    // /api/operator/finance (аудит ставок 04.08) — здесь он завёлся заново
    // отдельной копией расчёта. Совпадение с 10% сегодня — только потому,
    // что миграция 811 выставила его всем операторам по умолчанию.
    const rows = await pool.query<Record<string, unknown>>(
      `SELECT DATE_TRUNC('month', ob.created_at)::date::text AS month,
              COUNT(*) AS bookings,
              SUM(ob.final_price) AS revenue,
              SUM(ob.final_price * COALESCE(p.commission_current, 10) / 100) AS platform_fee,
              SUM(ob.final_price * (1 - COALESCE(p.commission_current, 10) / 100)) AS net
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
       LEFT JOIN partners p ON p.id = ot.operator_id
       WHERE ot.operator_id = $1
         AND ob.payment_status = 'paid'
         AND ob.deleted_at IS NULL
       GROUP BY 1 ORDER BY 1 DESC
       LIMIT 24`,
      [operatorId]
    );

    if (format === 'csv') {
      const csv = toCSV(rows.rows, {
        month: 'Месяц', bookings: 'Бронирований', revenue: 'Выручка',
        platform_fee: 'Комиссия платформы', net: 'Чистая выручка',
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
