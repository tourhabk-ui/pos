import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import type { CustomerRow } from '@/lib/types/db-rows';
import { buildClientsSql, CLIENTS_SORT_COLUMNS, logScreenQueryFailure, type ClientsSortColumn } from '@/lib/operator/screen-queries';

export const dynamic = 'force-dynamic';


/**
 * GET /api/operator/clients
 * CRM: список клиентов оператора с пагинацией, поиском и фильтром по статусу
 */
export async function GET(request: NextRequest) {
  try {
    const userOrResponse = await requireOperator(request);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const partnerId = await getOperatorPartnerId(userOrResponse.userId);
    if (!partnerId) {
      return NextResponse.json(
        { success: false, error: 'Партнёрский профиль не найден' },
        { status: 404 }
      );
    }

    const { searchParams } = new URL(request.url);
    const search   = (searchParams.get('search') ?? '').trim();
    const status   = searchParams.get('status') ?? 'all';
    const page     = Math.max(1, parseInt(searchParams.get('page') ?? '1'));
    const limit    = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20')));
    const sortRaw  = searchParams.get('sort') ?? 'total_spent';
    const order    = searchParams.get('order') === 'asc' ? 'ASC' : 'DESC';
    const offset   = (page - 1) * limit;

    const searchParam = search ? `%${search}%` : '';

    const sortCol: ClientsSortColumn = (CLIENTS_SORT_COLUMNS as readonly string[]).includes(sortRaw)
      ? (sortRaw as ClientsSortColumn) : 'total_spent';
    const { countSql, dataSql } = buildClientsSql({
      search: search.length > 0,
      status: status !== 'all',
      sortCol,
      order,
    });

    const params: (string | number)[] = [partnerId];
    if (search) params.push(searchParam);
    if (status !== 'all') params.push(status);

    // COUNT запрос
    const countResult = await query(countSql, params);
    const total = (countResult.rows[0]?.total as number | undefined) ?? 0;

    // DATA запрос
    const dataResult = await query<CustomerRow>(dataSql, [...params, limit, offset]);

    const customers = dataResult.rows.map((r) => ({
      id:              r.id,
      name:            r.name,
      email:           r.email,
      phone:           r.phone ?? '',
      totalBookings:   r.total_bookings,
      totalSpent:      parseFloat(String(r.total_spent)),
      lastBookingDate: r.last_booking_date ? new Date(r.last_booking_date).toISOString() : null,
      status:          r.status,
    }));

    return NextResponse.json({
      success: true,
      data: {
        customers,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    // Текст ошибки PostgreSQL оператору не показывается — он уходит в лог с
    // SQLSTATE; на экране — понятная фраза (§4.0: ловить можно, молчать нельзя).
    logScreenQueryFailure('clients', err);
    return NextResponse.json({ success: false, error: 'Не удалось загрузить клиентов. Попробуйте обновить страницу.' }, { status: 500 });
  }
}
