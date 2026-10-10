/**
 * GET /api/stay/reviews — отзывы гостей об объектах владельца жилья (CRM,
 * хвосты фазы 1, #2325). Скоуп — partner_id владельца в самом SQL. Имя гостя —
 * «Имя Ф.», как на странице объекта: полное имя для ответа на отзыв не нужно.
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { getStayPartnerId, requireStayOwner, stayCheckUnavailableResponse, StayCheckUnavailableError } from '@/lib/auth/stay-helpers';
import { publicReviewerName } from '@/lib/reviews/public-name';

export const dynamic = 'force-dynamic';

const LIMIT = 50;

interface Row {
  id: string;
  accommodation_name: string;
  user_name: string | null;
  rating: number;
  title: string | null;
  comment: string | null;
  is_visible: boolean | null;
  owner_reply: string | null;
  created_at: Date;
}

export async function GET(request: NextRequest) {
  const auth = await requireStayOwner(request);
  if (auth instanceof NextResponse) return auth;

  let partnerId: string | null;
  try {
    partnerId = await getStayPartnerId(auth.userId);
  } catch (err) {
    if (err instanceof StayCheckUnavailableError) return stayCheckUnavailableResponse();
    throw err;
  }
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Профиль владельца жилья не найден' }, { status: 404 });
  }

  try {
    const { rows } = await query<Row>(
      `SELECT r.id, a.name AS accommodation_name, u.name AS user_name, r.overall_rating AS rating,
              r.title, r.comment, r.is_visible, r.owner_reply, r.created_at
         FROM accommodation_reviews r
         JOIN accommodations a ON a.id = r.accommodation_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE a.partner_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [partnerId, LIMIT],
    );
    return NextResponse.json({
      success: true,
      data: {
        reviews: rows.map((r) => ({
          id: r.id,
          accommodationName: r.accommodation_name,
          userName: publicReviewerName(r.user_name),
          rating: r.rating,
          title: r.title,
          comment: r.comment,
          isVisible: r.is_visible !== false,
          ownerReply: r.owner_reply,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      },
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[stay-reviews] отзывы не прочитаны, SQLSTATE', code);
    return NextResponse.json({ success: false, error: 'Не удалось загрузить отзывы, попробуйте позже' }, { status: 503 });
  }
}
