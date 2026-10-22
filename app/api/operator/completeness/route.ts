/**
 * GET /api/operator/completeness
 * Check tour completeness: which required/recommended fields are missing
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { missingFields, blockerLabel, type ReadinessRow } from '@/lib/tours/readiness';
import { COMPLETENESS_TOURS_SQL, logScreenQueryFailure } from '@/lib/operator/screen-queries';

export const dynamic = 'force-dynamic';

interface TourCompletenessRow {
  id: string; title: string | null; description: string | null; short_description: string | null;
  base_price: number | null; max_participants: number | null; min_participants: number | null;
  location_type: string | null; activity_type: string | null; location_name: string | null;
  latitude: number | null; longitude: number | null; duration_hours: number | null;
  difficulty: string | null; season_start: string | null; season_end: string | null;
  duration_type: string | null; included: string[] | null; not_included: string[] | null;
  what_to_bring: string[] | null; tour_image: string | null; photos: string[] | null;
  price_old: number | null; price_unit: string | null;
  is_active: boolean | null;
  is_published: boolean | null;
  /** Ответ шлюза каталога (publicTourSql) — видит ли тур турист (#2642). */
  on_storefront: boolean;
  // Поля готовности к лентам (04.09): кабинет обязан судить тем же правилом,
  // что и ленты на Авито с Яндексом.
  pickup_type: ReadinessRow['pickup_type'];
  pickup_details_chars: number;
  has_meeting_point: boolean;
  has_cancellation_policy: boolean;
  has_operator_contact: boolean;
}

interface TourCompletion {
  tour_id: string;
  tour_title: string | null;
  is_active: boolean | null;
  is_published: boolean | null;
  /**
   * Тур в каталоге Ведара — по шлюзу каталога, а не по одному флагу. До #2642
   * экран судил по `is_published`, и выключенный тур числился «Опубликован».
   */
  on_storefront: boolean;
  required_score: number; // 0-100: title, description, price, activity_type, tour_image
  recommended_score: number; // 0-100: short_desc, season, difficulty, included, etc
  total_score: number; // weighted: 70% required, 30% recommended
  missing_required: string[];
  missing_recommended: string[];
  /**
   * Готовность к ЧУЖИМ витринам — отдельный вопрос от заполненности карточки.
   *
   * Разошлись они дорого: кабинет считал тур полным при описании в 20 знаков,
   * а витрины требуют 300 и вдобавок ответ «как турист попадает на тур». То
   * есть оператор видел «сто процентов заполнено», а его тур молча не уходил
   * ни на Авито, ни в Яндекс. Экран, который говорит «готово» там, где не
   * готово, хуже отсутствующего.
   *
   * Ленты берут только туры с витрины Ведара (lib/channels/ready-tours.ts),
   * поэтому «готов» — это витрина И пустой список блокеров. Черновик со
   * всеми полями до #2642 числился «Готов к выкладке», а в ленту не уходил.
   */
  marketplace_ready: boolean;
  marketplace_blockers: Array<{ field: string; label: string }>;
}

export async function GET(request: NextRequest) {
  const userOrResponse = await requireOperator(request);
  if (userOrResponse instanceof NextResponse) {
    return userOrResponse;
  }

  const userId = userOrResponse.userId;

  try {
    const partnerId = await getOperatorPartnerId(userId);
    if (!partnerId) {
      // Форма ответа ОБЯЗАНА совпадать с обычным случаем ниже (data — объект
      // {stats, tours}, не массив): клиент (_CompletenessClient.tsx)
      // деструктурирует `const { stats, tours } = data`, а пустой массив —
      // truthy, `!data` его не ловит. Расхождение формы валило страницу
      // белым экраном для любого оператора без записи в partners (аудит
      // кабинета оператора).
      return NextResponse.json({
        success: true,
        data: {
          stats: { totalTours: 0, avgTotalScore: 0, fullyComplete: 0, criticallyIncomplete: 0 },
          tours: [],
        },
      });
    }

    const { rows: tours } = await pool.query<TourCompletenessRow>(
      COMPLETENESS_TOURS_SQL,
      [partnerId]
    );

    const completions: TourCompletion[] = tours.map(tour => {
      // REQUIRED fields (70% of total score)
      const required = {
        title: !!tour.title?.trim(),
        description: !!tour.description?.trim() && tour.description.length >= 20,
        base_price: tour.base_price && tour.base_price > 0,
        activity_type: !!tour.activity_type,
        tour_image: !!tour.tour_image || (tour.photos && Array.isArray(tour.photos) && tour.photos.length > 0),
      };

      const requiredFilled = Object.values(required).filter(Boolean).length;
      const requiredScore = (requiredFilled / Object.keys(required).length) * 100;

      const missingRequired = Object.entries(required)
        .filter(([, filled]) => !filled)
        .map(([field]) => field);

      // Готовность к чужим витринам — общим правилом, а не своим.
      const marketplaceBlockers = missingFields({
        id: Number(tour.id),
        title: tour.title ?? '',
        operator_id: null,
        operator_name: null,
        description_chars: tour.description?.length ?? 0,
        photo_count: Array.isArray(tour.photos) ? tour.photos.length : (tour.tour_image ? 1 : 0),
        base_price: tour.base_price,
        duration_hours: tour.duration_hours,
        pickup_type: tour.pickup_type,
        pickup_details_chars: tour.pickup_details_chars,
        has_meeting_point: tour.has_meeting_point,
        has_cancellation_policy: tour.has_cancellation_policy,
        has_coords: !!(tour.latitude && tour.longitude),
        has_operator_contact: tour.has_operator_contact,
        included_count: Array.isArray(tour.included) ? tour.included.length : 0,
        program_steps: 0,
      });

      // RECOMMENDED fields (30% of total score)
      const recommended = {
        short_description: !!tour.short_description?.trim(),
        season_dates: !!tour.season_start && !!tour.season_end,
        difficulty: !!tour.difficulty,
        included: tour.included && Array.isArray(tour.included) && tour.included.length > 0,
        not_included: tour.not_included && Array.isArray(tour.not_included) && tour.not_included.length > 0,
        what_to_bring: tour.what_to_bring && Array.isArray(tour.what_to_bring) && tour.what_to_bring.length > 0,
        location_name: !!tour.location_name?.trim(),
        coordinates: tour.latitude && tour.longitude,
        duration_hours: tour.duration_hours && tour.duration_hours > 0,
        price_unit: !!tour.price_unit,
      };

      const recommendedFilled = Object.values(recommended).filter(Boolean).length;
      const recommendedScore = (recommendedFilled / Object.keys(recommended).length) * 100;

      const missingRecommended = Object.entries(recommended)
        .filter(([, filled]) => !filled)
        .map(([field]) => field);

      // Weighted total (required 70%, recommended 30%)
      const totalScore = (requiredScore * 0.7 + recommendedScore * 0.3);

      return {
        tour_id: tour.id,
        tour_title: tour.title,
        is_active: tour.is_active,
        is_published: tour.is_published,
        on_storefront: tour.on_storefront === true,
        required_score: Math.round(requiredScore),
        recommended_score: Math.round(recommendedScore),
        total_score: Math.round(totalScore),
        marketplace_ready: tour.on_storefront === true && marketplaceBlockers.length === 0,
        marketplace_blockers: marketplaceBlockers.map((f) => ({ field: f, label: blockerLabel(f) })),
        missing_required: missingRequired,
        missing_recommended: missingRecommended,
      };
    });

    // Calculate operator-level stats
    const avgTotalScore = completions.length > 0
      ? Math.round(completions.reduce((sum, t) => sum + t.total_score, 0) / completions.length)
      : 0;

    const fullyComplete = completions.filter(t => t.total_score === 100).length;
    const criticallyIncomplete = completions.filter(t => t.required_score < 100).length;

    return NextResponse.json({
      success: true,
      data: {
        stats: {
          totalTours: completions.length,
          avgTotalScore,
          fullyComplete,
          criticallyIncomplete,
          // publishedTours снят (ревью #2642): считался по одному is_published
          // — выключенный тур числился опубликованным, — а читателя у поля не
          // было ни одного. Экран считает витрину сам, по on_storefront.
        },
        tours: completions,
      },
    });
  } catch (error) {
    logScreenQueryFailure('completeness', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить полноту туров. Попробуйте обновить страницу.' },
      { status: 500 }
    );
  }
}
