import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getTouristProfile } from '@/lib/auth/tourist-helpers';
import { getBalance } from '@/lib/eco/ledger';
import {
  touristTravelStats, tripsTimeline, categoryStats, recentReviews, upcomingTrips,
} from '@/lib/tourist/cabinet';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tourist/stats — сводка кабинета туриста.
 *
 * До 10.09 читала tourist_trips и tourist_reviews — таблицы, которых нет ни в
 * одной миграции и не было на проде: 500 на каждый вызов, а дашборд рисовал
 * на 500 пустой кабинет (issue #1771). Теперь всё из настоящих таблиц через
 * lib/tourist/cabinet; форма ответа сохранена — дашборд читает
 * profile_summary / trips_timeline / category_stats / recent_reviews /
 * upcoming_trips как раньше.
 */
export async function GET(request: NextRequest) {
  const userOrResponse = await requireAuth(request);
  if (userOrResponse instanceof NextResponse) return userOrResponse;
  const userId = userOrResponse.userId;

  try {
    const profile = await getTouristProfile(userId);
    const profileId = profile && typeof profile.id === 'string' ? profile.id : null;

    const [overview, timeline, categories, reviews, upcoming] = await Promise.all([
      touristTravelStats(userId, profileId),
      tripsTimeline(userId),
      categoryStats(userId),
      recentReviews(userId),
      upcomingTrips(userId),
    ]);

    // Эко — из реестра, а не из tourist_profiles.loyalty_points: витрина
    // обязана показывать то же число, что кошелёк (/api/eco/wallet).
    const ecoBalance = await getBalance(userId).catch(() => 0);

    return NextResponse.json({
      success: true,
      data: {
        overview,
        profile_summary: {
          loyalty_tier: null,
          loyalty_points: ecoBalance,
          total_trips: overview.completed_trips,
          total_spent: overview.total_spent,
          average_rating: overview.average_rating_given,
          member_since: profile?.created_at ?? null,
        },
        trips_timeline: timeline,
        category_stats: categories,
        recent_reviews: reviews,
        upcoming_trips: upcoming,
      },
    } as ApiResponse<unknown>);
  } catch (error) {
    const e = error as Error & { code?: string };
    console.error('[tourist/stats] отказ базы', { sqlstate: e?.code, message: e?.message });
    return NextResponse.json(
      { success: false, error: 'Не удалось собрать статистику. Попробуйте обновить страницу.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
