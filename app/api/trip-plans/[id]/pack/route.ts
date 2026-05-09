/**
 * GET /api/trip-plans/[id]/pack
 * Возвращает полный набор данных для офлайн-кэша:
 * план + маршрут + точки + профили безопасности + SOS-контакты.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || id.length < 10) {
    return NextResponse.json({ success: false, error: 'Некорректный ID' }, { status: 400 });
  }

  // ── 1. Plan + Route ──────────────────────────────────────────────────────────
  const planRes = await query(
    `SELECT p.id, p.route_id, p.title, p.start_date, p.days, p.experience, p.itinerary, p.created_at,
            r.title AS route_title, r.description AS route_description,
            r.zone, r.difficulty, r.distance_km, r.elevation_gain_m, r.duration_hours,
            r.season, r.route_type, r.hazards, r.equipment,
            r.mchs_registration_required, r.mchs_phone, r.park_name, r.park_approval_url,
            r.geometry, r.lat, r.lng
     FROM trip_plans p
     JOIN kamchatka_routes r ON r.id = p.route_id
     WHERE p.id = $1::uuid`,
    [id]
  );

  if (!planRes.rows[0]) {
    return NextResponse.json({ success: false, error: 'План не найден' }, { status: 404 });
  }
  const plan = planRes.rows[0];

  // ── 2. Waypoints + places + safety + realtime ────────────────────────────────
  const wpRes = await query(
    `SELECT w.position, w.notes AS waypoint_notes,
            p.id AS place_id, p.name, p.description, p.location_type,
            p.lat, p.lng, p.ark_id,
            sp.altitude_m, sp.difficulty_level, sp.hazard_types,
            sp.nearest_medical_km, sp.sat_communicator_required,
            sp.capacity_per_day, sp.terrain_type,
            rt.is_open, rt.current_crowds, rt.alert_message
     FROM route_waypoints w
     JOIN places p ON p.id = w.place_id
     LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
     LEFT JOIN location_real_time_status rt ON rt.agent_route_id = p.ark_id
     WHERE w.route_id = $1::uuid
     ORDER BY w.position`,
    [plan.route_id]
  );

  // ── 3. Photos (один запрос на все точки) ─────────────────────────────────────
  const placeArkIds = wpRes.rows.map(w => w.ark_id).filter(Boolean) as string[];
  const photosRes = placeArkIds.length > 0
    ? await query(
        `SELECT route_id, image_url, alt_text
         FROM ai_route_images
         WHERE route_id = ANY($1::uuid[])
         ORDER BY sort_order
         LIMIT 60`,
        [placeArkIds]
      )
    : { rows: [] };

  const photosByPlace: Record<string, { url: string; alt: string | null }[]> = {};
  for (const ph of photosRes.rows) {
    const rid = ph.route_id as string;
    if (!photosByPlace[rid]) photosByPlace[rid] = [];
    photosByPlace[rid].push({ url: ph.image_url as string, alt: ph.alt_text as string | null });
  }

  // ── 4. SOS contacts (hardcoded — работают без сети) ──────────────────────────
  const sosContacts = [
    { id: 'mchs-112',       name: 'МЧС / Единый номер',        phone: '112',                type: 'mchs'    },
    { id: 'mchs-kamchatka', name: 'МЧС Камчатский край',       phone: '+7 (4152) 23-53-62', type: 'mchs'    },
    { id: 'rescue-pkgo',    name: 'ПСО «Камчатка» (ПКГО)',     phone: '+7 (4152) 41-27-30', type: 'rescue'  },
    { id: 'medical-103',    name: 'Скорая медицинская помощь',  phone: '103',                type: 'medical' },
  ];

  return NextResponse.json({
    success: true,
    data: {
      plan: {
        id:         plan.id         as string,
        title:      plan.title      as string,
        startDate:  plan.start_date as string | null,
        days:       plan.days       as number,
        experience: plan.experience as string,
        itinerary:  plan.itinerary  as unknown,
        createdAt:  plan.created_at as string,
      },
      route: {
        id:             plan.route_id             as string,
        title:          plan.route_title          as string,
        description:    plan.route_description    as string | null,
        zone:           plan.zone                 as string | null,
        difficulty:     plan.difficulty           as string | null,
        distanceKm:     plan.distance_km          != null ? parseFloat(plan.distance_km as string) : null,
        elevationGainM: plan.elevation_gain_m     as number | null,
        durationHours:  plan.duration_hours       != null ? parseFloat(plan.duration_hours as string) : null,
        season:         plan.season               as string | null,
        routeType:      plan.route_type           as string | null,
        hazards:        (plan.hazards             as string[]) ?? [],
        equipment:      (plan.equipment           as string[]) ?? [],
        mchsRequired:   plan.mchs_registration_required as boolean,
        mchsPhone:      plan.mchs_phone           as string | null,
        parkName:       plan.park_name            as string | null,
        parkApprovalUrl: plan.park_approval_url   as string | null,
        geometry:       plan.geometry             as unknown,
        lat:            plan.lat                  != null ? parseFloat(plan.lat as string) : null,
        lng:            plan.lng                  != null ? parseFloat(plan.lng as string) : null,
      },
      waypoints: wpRes.rows.map(w => ({
        position:         w.position           as number,
        notes:            w.waypoint_notes     as string | null,
        placeId:          w.place_id           as string,
        name:             w.name               as string,
        description:      w.description        as string | null,
        locationType:     w.location_type      as string | null,
        lat:              w.lat                != null ? parseFloat(w.lat as string) : null,
        lng:              w.lng                != null ? parseFloat(w.lng as string) : null,
        altitudeM:        w.altitude_m         != null ? Number(w.altitude_m) : null,
        difficultyLevel:  w.difficulty_level   as string | null,
        hazardTypes:      (w.hazard_types      as string[]) ?? [],
        nearestMedicalKm: w.nearest_medical_km != null ? Number(w.nearest_medical_km) : null,
        satRequired:      w.sat_communicator_required as boolean | null,
        isOpen:           w.is_open            as boolean | null,
        currentCrowds:    w.current_crowds     as string | null,
        alertMessage:     w.alert_message      as string | null,
        photos:           photosByPlace[w.ark_id as string] ?? [],
      })),
      sosContacts,
      cachedAt: Date.now(),
    },
  });
}
