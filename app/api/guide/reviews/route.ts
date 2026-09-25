import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { logGuideFailure } from '@/lib/guides/db-failure';

export const dynamic = 'force-dynamic';

/**
 * GET /api/guide/reviews — отзывы о гиде и их сводка.
 *
 * Название тура у отзыва НЕ выводится, и это не упущение. `guide_reviews.
 * booking_id` — uuid со ссылкой на легаси-таблицу `bookings`, а прежний
 * запрос соединял его с `operator_bookings.id` (bigint): 42883 на КАЖДОМ
 * вызове, экран отзывов отвечал 500 всегда. Связи отзыва с живой бронью в
 * схеме нет; появится писатель отзывов с `operator_bookings` — появится и
 * название тура. До тех пор — отзыв без названия, а не отказ всего списка.
 *
 * Почта туриста гиду не отдаётся: для ответа на отзыв она не нужна.
 */

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1, 'Страница — от 1').max(10_000).default(1),
  limit: z.coerce.number().int().min(1, 'Лимит — от 1 до 100').max(100, 'Лимит — от 1 до 100').default(20),
  filter: z.enum(['all', 'replied', 'unreplied', 'positive', 'negative']).default('all'),
});

const FILTER_SQL: Record<z.infer<typeof QuerySchema>['filter'], string> = {
  all: '',
  replied: ' AND gr.guide_reply IS NOT NULL',
  unreplied: ' AND gr.guide_reply IS NULL',
  positive: ' AND gr.rating >= 4',
  negative: ' AND gr.rating <= 2',
};

interface ReviewStatsRow {
  total_reviews: number;
  avg_rating: string | null;
  five_star: number;
  four_star: number;
  three_star: number;
  two_star: number;
  one_star: number;
  replied_count: number;
  unreplied_count: number;
  avg_professionalism: string | null;
  avg_knowledge: string | null;
  avg_communication: string | null;
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));

export async function GET(request: NextRequest) {
  const guideOrResponse = await requireRole(request, ['guide', 'admin']);
  if (guideOrResponse instanceof NextResponse) return guideOrResponse;

  const sp = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    page: sp.get('page') ?? undefined,
    limit: sp.get('limit') ?? undefined,
    filter: sp.get('filter') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' } as ApiResponse<null>,
      { status: 400 },
    );
  }
  const { page, limit, filter } = parsed.data;
  const offset = (page - 1) * limit;
  const filterSql = FILTER_SQL[filter];

  try {
    const guideId = await getGuidePartnerId(guideOrResponse.userId);
    if (!guideId) {
      return NextResponse.json({ success: false, error: 'Профиль гида не найден' } as ApiResponse<null>, { status: 404 });
    }

    const result = await query(
      `SELECT gr.id, gr.guide_id, gr.tourist_id, gr.rating,
              gr.professionalism_rating, gr.knowledge_rating, gr.communication_rating,
              gr.comment, gr.guide_reply, gr.guide_reply_at, gr.is_verified,
              gr.created_at, gr.updated_at,
              u.name AS tourist_name
       FROM guide_reviews gr
       LEFT JOIN users u ON gr.tourist_id = u.id
       WHERE gr.guide_id = $1 AND gr.is_public = true${filterSql}
       ORDER BY gr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [guideId, limit, offset],
    );

    const statsResult = await query<ReviewStatsRow>(
      `SELECT
        COUNT(*)::int AS total_reviews,
        AVG(rating)::text AS avg_rating,
        COUNT(*) FILTER (WHERE rating = 5)::int AS five_star,
        COUNT(*) FILTER (WHERE rating = 4)::int AS four_star,
        COUNT(*) FILTER (WHERE rating = 3)::int AS three_star,
        COUNT(*) FILTER (WHERE rating = 2)::int AS two_star,
        COUNT(*) FILTER (WHERE rating = 1)::int AS one_star,
        COUNT(*) FILTER (WHERE guide_reply IS NOT NULL)::int AS replied_count,
        COUNT(*) FILTER (WHERE guide_reply IS NULL)::int AS unreplied_count,
        AVG(professionalism_rating)::text AS avg_professionalism,
        AVG(knowledge_rating)::text AS avg_knowledge,
        AVG(communication_rating)::text AS avg_communication
      FROM guide_reviews
      WHERE guide_id = $1 AND is_public = true`,
      [guideId],
    );
    const stats = statsResult.rows[0];

    const countResult = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM guide_reviews gr
       WHERE gr.guide_id = $1 AND gr.is_public = true${filterSql}`,
      [guideId],
    );
    const totalCount = countResult.rows[0]?.count ?? 0;

    const reviews = result.rows.map((row) => ({
      id: row.id,
      guideId: row.guide_id,
      touristId: row.tourist_id,
      touristName: row.tourist_name ?? null,
      tourTitle: null,
      rating: row.rating,
      professionalismRating: row.professionalism_rating,
      knowledgeRating: row.knowledge_rating,
      communicationRating: row.communication_rating,
      comment: row.comment,
      guideReply: row.guide_reply,
      guideReplyAt: row.guide_reply_at,
      isVerified: row.is_verified,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return NextResponse.json({
      success: true,
      data: {
        reviews,
        stats: {
          totalReviews: stats.total_reviews,
          // null — отзывов нет; средняя из пустоты не ноль.
          avgRating: num(stats.avg_rating),
          distribution: {
            fiveStar: stats.five_star,
            fourStar: stats.four_star,
            threeStar: stats.three_star,
            twoStar: stats.two_star,
            oneStar: stats.one_star,
          },
          repliedCount: stats.replied_count,
          unrepliedCount: stats.unreplied_count,
          avgProfessionalism: num(stats.avg_professionalism),
          avgKnowledge: num(stats.avg_knowledge),
          avgCommunication: num(stats.avg_communication),
        },
        pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
      },
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('GET /api/guide/reviews', error);
    return NextResponse.json({ success: false, error: 'Ошибка при получении отзывов' } as ApiResponse<null>, { status: 500 });
  }
}
