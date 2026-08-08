import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface TripShareTour {
  id: string;
  title: string;
  base_price: string;
  operator_name: string;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ success: false, error: 'Неверный токен' }, { status: 400 });
  }

  try {
    const { rows } = await pool.query<{
      id: string;
      title: string;
      arrival_date: string | null;
      departure_date: string | null;
      places: string[];
      activities: string[];
      days: unknown;
      transport_by_day: unknown;
    }>(
      `SELECT id, title, arrival_date, departure_date, places, activities, days, transport_by_day
       FROM user_trips
       WHERE share_token = $1 AND is_public = TRUE AND deleted_at IS NULL`,
      [token]
    );

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден или не опубликован' }, { status: 404 });
    }

    // Туры к дням плана: по activityType (+зона дня), тот же подбор, что у
    // /api/planner/tours-for-day. Сохранённые дни туров не несут (схема
    // сохранения режет realTour), поэтому резолвим на чтении — публичная
    // страница плана должна вести к брони, а не быть витриной цен «от-до»:
    // «план, который бронирует» — наше отличие от планировщиков TAAFT
    // (разведка 08.08, карт-бланш владельца). Сбой подбора не роняет план.
    const days = Array.isArray(rows[0]!.days) ? rows[0]!.days as Array<{ activityType?: string; type?: string }> : [];
    const activities = [...new Set(
      days
        .filter((d) => d.activityType && (d.type === undefined || d.type === 'activity'))
        .map((d) => d.activityType as string),
    )];
    const topTours: Record<string, TripShareTour> = {};
    await Promise.all(activities.map(async (activity) => {
      try {
        const { rows: tours } = await pool.query<TripShareTour>(`
          SELECT
            ot.id, ot.title, ot.base_price::text,
            p.name AS operator_name
          FROM operator_tours ot
          JOIN partners p ON p.id = ot.operator_id
          WHERE ot.activity_type = $1
            AND ot.is_active = true AND ot.is_published = true AND ot.deleted_at IS NULL
          ORDER BY ot.rating DESC NULLS LAST, ot.base_price ASC
          LIMIT 1
        `, [activity]);
        if (tours[0]) topTours[activity] = tours[0];
      } catch { /* тур-подсказка необязательна */ }
    }));

    return NextResponse.json({ success: true, data: { ...rows[0], top_tours: topTours } });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
