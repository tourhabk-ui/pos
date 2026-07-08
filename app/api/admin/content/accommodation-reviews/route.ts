import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/content/accommodation-reviews — список отзывов о жилье для
 * модерации. Зеркало /api/admin/content/reviews (туры), но по таблице
 * accommodation_reviews. Фильтр visible=true|false, поиск по автору/объекту/тексту.
 */
export async function GET(request: NextRequest) {
  const adminOrResponse = await requireAdmin(request);
  if (adminOrResponse instanceof NextResponse) return adminOrResponse;

  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')));
    const offset = (page - 1) * limit;
    const visible = searchParams.get('visible'); // 'true' | 'false'
    const search = searchParams.get('search');

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let i = 1;

    if (visible === 'true') conditions.push('r.is_visible = true');
    else if (visible === 'false') conditions.push('r.is_visible = false');

    if (search) {
      conditions.push(`(u.name ILIKE $${i} OR r.comment ILIKE $${i} OR a.name ILIKE $${i})`);
      params.push(`%${search}%`);
      i++;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM accommodation_reviews r
       LEFT JOIN users u ON r.user_id = u.id
       LEFT JOIN accommodations a ON r.accommodation_id = a.id
       ${whereClause}`,
      params
    );

    const rows = await query(
      `SELECT r.id, r.accommodation_id, r.user_id, r.overall_rating, r.comment,
              r.is_visible, r.created_at,
              u.name AS user_name,
              a.name AS accommodation_name
       FROM accommodation_reviews r
       LEFT JOIN users u ON r.user_id = u.id
       LEFT JOIN accommodations a ON r.accommodation_id = a.id
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    );

    const total = parseInt(countResult.rows[0]?.count ?? '0');
    return NextResponse.json({
      success: true,
      data: {
        reviews: rows.rows,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    } as ApiResponse<unknown>);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении отзывов' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
