/**
 * GET /api/routes/[id]
 * Один маршрут по UUID + предложения операторов из marketplace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { pool } from '@/lib/db-pool';
import { extractTrackpoints, decimateTrack } from '@/lib/routes/track';
import { collapseOperationalAlerts } from '@/lib/routes/operational-alerts';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Некорректный ID' }, { status: 400 });
  }

  try {
    const result = await query(
      `SELECT
         ark.id, ark.route_dedupe_key, ark.route_id, ark.category, ark.location_type, ark.activity_type,
         ark.title, ark.description, ark.lat, ark.lng, ark.source_url, ark.source_name, ark.payload, ark.created_at,
         COALESCE(kr.kuzmich_review, ark.kuzmich_review) AS kuzmich_review,
         -- Только реальные фото (wikimedia / ручная загрузка): AI-генерации не
         -- показываются, вместо них честный градиент (решение владельца 2026-07-17)
         (ari.route_id IS NOT NULL AND ari.model IN ('wikimedia', 'manual-upload')) AS has_real_image,
         kr.mchs_registration_required,
         kr.mchs_phone,
         kr.park_name,
         kr.park_approval_url,
         kr.hazards,
         kr.equipment     AS kr_equipment,
         kr.distance_km,
         kr.elevation_gain_m,
         kr.elevation_loss_m,
         kr.elevation_min_m,
         kr.elevation_max_m,
         kr.surface_types,
         kr.duration_hours AS kr_duration_hours,
         kr.pdf_url,
         kr.official_passport_url,
         kr.passport_agency,
         kr.ark_id AS kr_ark_id,
         pk.slug AS park_slug,
         COALESCE(kr.geometry, krs.geometry) AS geometry
       FROM agent_route_knowledge ark
       LEFT JOIN ai_route_images ari ON ari.route_id = ark.id
       LEFT JOIN kamchatka_routes kr ON kr.id = ark.id
       LEFT JOIN LATERAL (
         -- Трек места может жить отдельной строкой kamchatka_routes
         -- (точка «Гора Замок» ↔ её маршрут): связь через metadata.place_ark_id
         -- или общий source_url — та же логика, что в GPX-экспорте
         SELECT geometry FROM kamchatka_routes k2
         WHERE k2.geometry IS NOT NULL
           AND k2.id <> ark.id
           AND (
             k2.metadata->>'place_ark_id' = ark.id::text
             OR (ark.source_url IS NOT NULL AND k2.source_url = ark.source_url)
           )
         LIMIT 1
       ) krs ON TRUE
       LEFT JOIN LATERAL (
         SELECT slug FROM parks
         WHERE kr.park_name IS NOT NULL
           AND kr.park_name ILIKE '%' || search_term || '%'
           AND is_active
         LIMIT 1
       ) pk ON TRUE
       WHERE ark.id = $1 AND ark.is_visible = TRUE`,
      [id]
    );

    if (!result.rows[0]) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    }

    // Increment view count (fire-and-forget)
    pool.query('UPDATE kamchatka_routes SET view_count = view_count + 1 WHERE id = $1', [id]).catch(() => {});

    const r = result.rows[0];
    const payload = (r.payload as Record<string, unknown>) ?? {};

    // Загружаем предложения операторов из operator_tours (через v_route_marketplace)
    let offers: unknown[] = [];
    {
      const offersResult = await query(
        `SELECT
           tour_id,
           tour_name,
           tour_short_desc,
           tour_price_base,
           price_old,
           price_unit,
           effective_price,
           tour_duration_hours,
           duration_type,
           multi_day_count,
           tour_difficulty,
           max_group_size,
           min_group_size,
           tour_rating,
           tour_review_count,
           included,
           season_start,
           season_end,
           operator_id,
           operator_name,
           operator_slug,
           operator_rating,
           operator_review_count,
           operator_verified,
           tour_image,
           operator_hero_image,
           commission_rate,
           next_departure_date,
           next_departure_slots,
           marketplace_score
         FROM v_route_marketplace
         WHERE route_id = $1
         ORDER BY marketplace_score DESC`,
        [id]
      );

      offers = offersResult.rows.map(o => ({
        tourId:           Number(o.tour_id),
        tourName:         o.tour_name as string,
        shortDesc:        (o.tour_short_desc as string | null) ?? null,
        priceBase:        o.tour_price_base != null ? Number(o.tour_price_base) : null,
        priceOld:         o.price_old != null ? Number(o.price_old) : null,
        priceUnit:        (o.price_unit as string | null) ?? null,
        effectivePrice:   o.effective_price != null ? Number(o.effective_price) : null,
        durationHours:    o.tour_duration_hours != null ? Number(o.tour_duration_hours) : null,
        durationType:     (o.duration_type as string | null) ?? null,
        multiDayCount:    o.multi_day_count != null ? Number(o.multi_day_count) : null,
        difficulty:       (o.tour_difficulty as string | null) ?? null,
        maxGroupSize:     o.max_group_size != null ? Number(o.max_group_size) : null,
        minGroupSize:     o.min_group_size != null ? Number(o.min_group_size) : null,
        rating:           o.tour_rating != null ? Number(o.tour_rating) : null,
        reviewCount:      o.tour_review_count != null ? Number(o.tour_review_count) : null,
        included:         (o.included as unknown[]) ?? [],
        seasonStart:      (o.season_start as string | null) ?? null,
        seasonEnd:        (o.season_end as string | null) ?? null,
        operator: {
          id:           o.operator_id as string,
          name:         o.operator_name as string,
          slug:         (o.operator_slug as string | null) ?? null,
          rating:       o.operator_rating != null ? Number(o.operator_rating) : null,
          reviewCount:  o.operator_review_count != null ? Number(o.operator_review_count) : null,
          verified:     o.operator_verified as boolean,
        },
        tourImage:        (o.tour_image as string | null) ?? null,
        operatorHeroImage: (o.operator_hero_image as string | null) ?? null,
        nextDeparture:    (o.next_departure_date as string | null) ?? null,
        nextSlots:        o.next_departure_slots != null ? Number(o.next_departure_slots) : null,
      }));
    }

    // Waypoints
    const waypointsResult = await query(
      `SELECT rw.position, rw.is_start, rw.is_end, rw.notes,
         p.ark_id AS place_id, p.name AS place_name, p.location_type,
         p.lat AS place_lat, p.lng AS place_lng,
         sp.altitude_m, sp.hazard_types
       FROM route_waypoints rw
       JOIN places p ON p.id = rw.place_id
       LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
       WHERE rw.route_id = $1
         AND p.is_visible = TRUE
       ORDER BY rw.position`,
      [id]
    ).catch(() => ({ rows: [] }));

    // Оперативные ограничения точек маршрута: точечные сообщения
    // (alert_message из PATCH /api/admin/places/[id]/status и миграций),
    // закрытия (is_open=false) и зонные алерты (active_alerts из
    // safety-ingest). hazards — статичный перечень опасностей, а это —
    // живой статус «прямо сейчас».
    const operationalResult = await query(
      `SELECT p.name AS place_name, p.ark_id AS place_id,
              rs.is_open, rs.alert_message, rs.active_alerts, rs.alert_severity
       FROM route_waypoints rw
       JOIN places p ON p.id = rw.place_id
       JOIN location_real_time_status rs ON rs.agent_route_id = p.ark_id
       WHERE rw.route_id = $1
         AND p.is_visible = TRUE
         AND (
           (rs.alert_message IS NOT NULL AND (rs.alert_expires_at IS NULL OR rs.alert_expires_at > NOW()))
           OR rs.is_open = FALSE
           OR COALESCE(array_length(rs.active_alerts, 1), 0) > 0
         )
       ORDER BY rw.position`,
      [id]
    ).catch(() => ({ rows: [] }));

    // Отзывы о маршруте — запрос перенесён из /api/routes/detail/[id]
    // (карточка B, объединена с этой). Привязка через legacy ark_id.
    const reviewsResult = await query(
      `SELECT rv.id, rv.rating, rv.comment, rv.created_at,
         COALESCE(u.name, 'Турист') AS author_name
       FROM reviews rv
       LEFT JOIN users u ON u.id = rv.user_id
       WHERE rv.tour_id::text = $1
       ORDER BY rv.created_at DESC
       LIMIT 5`,
      [(r.kr_ark_id as string | null) ?? id]
    ).catch(() => ({ rows: [] }));

    return NextResponse.json({
      success: true,
      data: {
        id:           r.id as string,
        slug:         r.route_dedupe_key as string,
        routeId:      (r.route_id as string | null) ?? null,
        category:     r.category as string,
        locationType: (r.location_type as string | null) ?? null,
        activityType: (r.activity_type as string | null) ?? null,
        title:        r.title as string,
        description: (r.description as string | null) ?? '',
        lat:         r.lat != null ? parseFloat(r.lat as string) : null,
        lng:         r.lng != null ? parseFloat(r.lng as string) : null,
        sourceUrl:   (r.source_url as string | null) ?? null,
        sourceName:  (r.source_name as string | null) ?? null,
        priceFrom:   payload.price_from != null ? Number(payload.price_from) : null,
        season:      (payload.season as string | null) ?? null,
        difficulty:  (payload.difficulty as string | null) ?? null,
        durationDays: payload.duration_days != null ? Number(payload.duration_days) : null,
        bestMonths:  (payload.best_months as string[] | null) ?? null,
        altitude:    payload.altitude != null ? Number(payload.altitude) : null,
        groupSizeMax: payload.group_size_max != null ? Number(payload.group_size_max) : null,
        dangerLevel: (payload.danger_level as string | null) ?? null,
        equipment:   (r.kr_equipment as string[] | null) ?? (payload.required_equipment as string[] | null) ?? null,
        photos:      (payload.photos as string[] | null) ?? null,
        kuzmichReview: (r.kuzmich_review as string | null) ?? null,
        hasRealImage: Boolean(r.has_real_image),
        mchsRequired:    (r.mchs_registration_required as boolean | null) ?? false,
        mchsPhone:       (r.mchs_phone as string | null) ?? null,
        parkName:        (r.park_name as string | null) ?? null,
        parkApprovalUrl: (r.park_approval_url as string | null) ?? null,
        parkSlug:        (r.park_slug as string | null) ?? null,
        hazards:         (r.hazards as string[] | null) ?? null,
        distanceKm:      r.distance_km != null ? Number(r.distance_km) : null,
        elevationGainM:  r.elevation_gain_m != null ? Number(r.elevation_gain_m) : null,
        elevationLossM:  r.elevation_loss_m != null ? Number(r.elevation_loss_m) : null,
        elevationMinM:   r.elevation_min_m != null ? Number(r.elevation_min_m) : null,
        elevationMaxM:   r.elevation_max_m != null ? Number(r.elevation_max_m) : null,
        surfaceTypes:    (r.surface_types as string[] | null) ?? null,
        durationHours:   r.kr_duration_hours != null ? Number(r.kr_duration_hours) : null,
        pdfUrl:          (r.pdf_url as string | null) ?? null,
        officialPassportUrl: (r.official_passport_url as string | null) ?? null,
        passportAgency:      (r.passport_agency as string | null) ?? null,
        // GPS-трек для карты: [lat, lng][], прорежен до ~600 точек.
        // null = трека нет нигде (geometry, payload.geometry, payload.track)
        track: (() => {
          const pts = decimateTrack(extractTrackpoints(
            r.geometry as { type?: string; coordinates?: number[][] } | null,
            payload,
          ));
          return pts.length >= 2 ? pts.map(p => [p.lat, p.lng] as [number, number]) : null;
        })(),
        reviews: reviewsResult.rows.map(rv => ({
          id:         String(rv.id),
          rating:     rv.rating != null ? Number(rv.rating) : null,
          comment:    (rv.comment as string | null) ?? null,
          authorName: rv.author_name as string,
          createdAt:  rv.created_at as string,
        })),
        createdAt:   r.created_at as string,
        waypoints: waypointsResult.rows.map(w => ({
          position:     Number(w.position),
          isStart:      w.is_start as boolean,
          isEnd:        w.is_end as boolean,
          notes:        w.notes as string | null,
          placeId:      w.place_id as string,
          placeName:    w.place_name as string,
          locationType: w.location_type as string | null,
          lat:          w.place_lat != null ? parseFloat(w.place_lat as string) : null,
          lng:          w.place_lng != null ? parseFloat(w.place_lng as string) : null,
          altitudeM:    w.altitude_m != null ? Number(w.altitude_m) : null,
          hazardTypes:  (w.hazard_types as string[]) ?? [],
        })),
        offers,
        // Зонные алерты (общие для >=2 точек) схлопываются в один блок на
        // маршрут, у точек остаётся только своё — см. lib/routes/operational-alerts
        ...collapseOperationalAlerts(
          operationalResult.rows.map(a => ({
            place_id:       a.place_id as string,
            place_name:     a.place_name as string,
            is_open:        a.is_open as boolean | null,
            alert_message:  a.alert_message as string | null,
            active_alerts:  a.active_alerts as string[] | null,
            alert_severity: a.alert_severity as number | null,
          })),
        ),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки маршрута', details: process.env.NODE_ENV === 'development' ? msg : undefined },
      { status: 500 }
    );
  }
}
