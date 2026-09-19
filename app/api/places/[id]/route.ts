/**
 * GET /api/places/[id]
 * Full place card data: place + safety + realtime + nearby (single main query).
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { pool } from '@/lib/db-pool';
import { stripSourceAttribution } from '@/lib/text/source-attribution';
import { describeDescriptionSource } from '@/lib/text/description-source';
import { shownPhotoSql } from '@/lib/images/origin';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || id.length < 10) {
    return NextResponse.json({ success: false, error: 'Некорректный ID' }, { status: 400 });
  }

  try {
    // Main query: place + safety + realtime in one round-trip
    const result = await query(
      `SELECT
         p.id AS place_pk,
         p.ark_id,
         p.name,
         p.description,
         p.essence,
         p.category,
         p.location_type,
         p.lat,
         p.lng,
         p.zone,
         p.district,
         p.photo_url,
         p.images,
         p.best_season,
         p.seasonal_notes,
         p.access_info,
         p.source_url,
         p.source_name,
         p.updated_at,
         p.kuzmich_review,
         p.eco_zone,
         p.eco_permit_required,
         p.eco_rules,
         p.eco_permit_url,
         p.indigenous_info,
         sp.difficulty_level,
         sp.altitude_m,
         sp.altitude_diff_m,
         sp.distance_km,
         sp.terrain_type,
         sp.road_type,
         sp.road_accessibility,
         sp.nearest_medical_km,
         sp.emergency_access,
         sp.phone_ranger_mches,
         sp.sat_communicator_required,
         sp.rules_required,
         sp.weather_threshold,
         sp.hazard_types,
         sp.capacity_per_day,
         sp.optimal_group_size,
         sp.open_from_date,
         sp.open_to_date,
         sp.required_gear,
         sp.connectivity,
         sp.registration_required,
         sp.medical_info,
         rs.is_open,
         rs.current_crowds,
         rs.current_weather,
         rs.active_alerts,
         rs.alert_severity,
         rs.alert_message,
         rs.tourists_today,
         rs.tourists_hour,
         rs.updated_at AS realtime_updated_at,
         vs.aviation_color_code AS volcano_acc,
         vs.ash_height_m         AS volcano_ash_height_m,
         vs.summary              AS volcano_summary,
         vs.source_url           AS volcano_source_url,
         vs.observed_at          AS volcano_observed_at,
         -- Только реальные фото (wikimedia / ручная загрузка): AI-генерации не
         -- показываются, вместо них честный градиент (решение владельца 2026-07-17)
         (SELECT count(*)::int FROM ai_route_images ai
          WHERE ai.route_id = p.ark_id AND ${shownPhotoSql('ai.model')}) AS photo_count,
         -- Галерея места: вторая и последующие фотографии (миграция 968).
         -- Лежат отдельной таблицей, потому что у ai_route_images уникальный
         -- индекс по route_id, снять который нельзя — ON CONFLICT (route_id)
         -- стоит в десяти уже применённых миграциях.
         --
         -- Метка версии та же, что у героя, и по той же причине: раздача
         -- отдаёт immutable на год, а адрес состоит из ark_id и позиции. Без
         -- неё замена второго снимка была бы не видна.
         (SELECT COALESCE(json_agg(
                   '/api/images/place-gallery/' || g.ark_id || '/' || g.position
                   || '?v=' || EXTRACT(EPOCH FROM g.created_at)::bigint
                   ORDER BY g.position
                 ), '[]'::json)
            FROM place_gallery_photos g
           WHERE g.ark_id = p.ark_id) AS gallery_urls,
         ai.model      AS photo_model,
         ai.author     AS photo_author,
         ai.license    AS photo_license,
         ai.license_url AS photo_license_url,
         ai.source_url  AS photo_source_url,
         -- Метка версии снимка. Раздача /api/images/route/[routeId] отдаёт
         -- картинку с max-age=31536000, immutable, а адрес состоял из
         -- одного ark_id — то есть при ЗАМЕНЕ главного фото браузер целый год
         -- показывал бы прежнее и даже не переспросил (в этом смысл
         -- immutable). Замена героя перестала быть видна ровно в тот день,
         -- когда её сделали возможной (14.09).
         --
         -- Токен в адресе — не отключение кэша, а исполнение его контракта:
         -- содержимое сменилось — сменился адрес.
         EXTRACT(EPOCH FROM ai.created_at)::bigint AS photo_version,
         -- Атрибуция ТЕКСТА описания (#1830, шаг 4). Не путать с
         -- p.source_url/p.source_name: те про происхождение ЗАПИСИ места, а
         -- это про происхождение конкретного абзаца, который человек читает.
         --
         -- Условие равенства текстов — не перестраховка. Черновик остаётся
         -- 'approved' навсегда, а описание потом может переписать кто угодно:
         -- Editor, миграция, человек в админке. Подпись «по данным
         -- Смитсоновского института» под ЧУЖИМ текстом — ложное утверждение
         -- об источнике, и хуже отсутствия подписи. Совпало — подписываем,
         -- разошлось — подписи нет, и это происходит само.
         gvp.source_ref AS description_source_ref
       FROM places p
       LEFT JOIN place_description_drafts gvp
              ON gvp.place_id = p.id
             AND gvp.source = 'gvp'
             AND gvp.status = 'approved'
             AND gvp.translated_text = p.description
       LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
       LEFT JOIN location_real_time_status rs ON rs.agent_route_id = p.ark_id
       LEFT JOIN volcano_status vs ON vs.place_ark_id = p.ark_id
       LEFT JOIN ai_route_images ai ON ai.route_id = p.ark_id
       WHERE (p.ark_id::text = $1 OR p.id = $1)
         AND p.is_visible = true
         -- Слитое место — не самостоятельное место. Человека уводит 301 на
         -- странице (app/places/[id]/page.tsx), а API отвечает «не найдено»:
         -- отдавать карточку дубля значило бы держать двойника живым.
         AND p.merged_into_id IS NULL`,
      [id]
    );

    if (!result.rows[0]) {
      return NextResponse.json({ success: false, error: 'Место не найдено' }, { status: 404 });
    }

    // Increment view count (fire-and-forget)
    pool.query('UPDATE places SET view_count = view_count + 1 WHERE ark_id::text = $1 OR id::text = $1', [id]).catch(() => {});

    const r = result.rows[0];

    // Nearby: haversine, 50km radius, max 6
    const nearbyResult = await query(
      `SELECT
         p.ark_id AS id,
         p.name,
         p.location_type,
         p.lat,
         p.lng,
         p.photo_url,
         -- Та же метка версии у миниатюр «рядом»: адрес без неё замерзал бы
         -- на год так же, как у главного фото.
         (SELECT '/api/images/route/' || p.ark_id || '?v=' || EXTRACT(EPOCH FROM ai2.created_at)::bigint
            FROM ai_route_images ai2
           WHERE ai2.route_id = p.ark_id
             AND ${shownPhotoSql('ai2.model')}
           LIMIT 1) AS thumb_url,
         round(
           6371 * acos(
             LEAST(1.0, cos(radians($1::float)) * cos(radians(p.lat::float)) *
             cos(radians(p.lng::float) - radians($2::float)) +
             sin(radians($1::float)) * sin(radians(p.lat::float)))
           )
         )::int AS distance_km
       FROM places p
       WHERE p.ark_id != $3
         AND p.is_visible = true
         -- «Рядом» со ссылкой на слитое место — заведомо мёртвая ссылка.
         AND p.merged_into_id IS NULL
         AND p.lat BETWEEN ($1::float - 0.5) AND ($1::float + 0.5)
         AND p.lng BETWEEN ($2::float - 0.8) AND ($2::float + 0.8)
       ORDER BY (p.lat::float - $1::float)^2 + (p.lng::float - $2::float)^2
       LIMIT 6`,
      [r.lat, r.lng, r.ark_id]
    );

    // Reviews for this place
    const reviewsResult = await query(
      // rv.author_name первым: форма отзыва места пишет имя в эту колонку
      // (миграция 165) БЕЗ user_id — прежний COALESCE только по users.name
      // показывал «Турист» у каждого отзыва, живое имя не выводилось никогда.
      `SELECT rv.id, rv.rating, rv.comment, rv.created_at,
         COALESCE(NULLIF(rv.author_name, ''), u.name, 'Турист') AS author_name
       FROM reviews rv
       LEFT JOIN users u ON u.id = rv.user_id
       WHERE rv.place_id = $1
       ORDER BY rv.created_at DESC
       LIMIT 10`,
      [r.ark_id]
    );

    // Маршруты через это место. К одному месту их может быть несколько —
    // вершина стоит на нескольких тропах (Авачинский: восхождение дневное,
    // ночное, через перевал), поэтому список, а не одна ссылка.
    //
    // Фильтр живости обязателен: скрытые паутины (867, 868) и слитые дубли
    // (869) уходят с витрины маршрутов, но сюда попадали по-прежнему —
    // турист видел на карточке места ссылку на «маршрут» в 397 км,
    // которого в каталоге уже нет.
    //
    // Порядок — по содержательности, а не по rw.position: position это
    // номер ТОЧКИ ВНУТРИ маршрута, и сортировать им список разных
    // маршрутов бессмысленно (одно и то же место бывает первым в одном
    // и седьмым в другом).
    const routesResult = await query(
      `SELECT kr.id, kr.title, kr.activity_type, kr.difficulty, kr.distance_km, kr.duration_hours
       FROM route_waypoints rw
       JOIN kamchatka_routes kr ON kr.id = rw.route_id
       WHERE rw.place_id = $1
         AND kr.is_visible = TRUE
         AND kr.merged_into_id IS NULL
       ORDER BY (kr.geometry IS NOT NULL) DESC, (kr.distance_km IS NOT NULL) DESC, kr.title
       LIMIT 10`,
      [r.place_pk]
    );

    // Tours to this place (via route_waypoints → kamchatka_routes → operator_tours)
    const toursResult = await query(
      `SELECT DISTINCT ON (ot.id)
         ot.id, ot.title, ot.base_price, ot.multi_day_count AS duration_days,
         p.name AS operator_name, p.slug AS operator_slug
       FROM route_waypoints rw
       JOIN kamchatka_routes kr ON kr.id = rw.route_id
       JOIN operator_tours ot ON ot.route_id = kr.id
       JOIN partners p ON p.id = ot.operator_id
       WHERE rw.place_id = $1
         AND kr.merged_into_id IS NULL
         AND ot.is_active = true AND ot.is_published = true
       ORDER BY ot.id, ot.base_price ASC
       LIMIT 5`,
      [r.place_pk]
    );

    const hazardTypes = Array.isArray(r.hazard_types) ? (r.hazard_types as string[]) : [];
    const requiredGear = Array.isArray(r.required_gear) ? (r.required_gear as string[]) : [];

    return NextResponse.json({
      success: true,
      data: {
        id: r.ark_id as string,
        name: r.name as string,
        description: (() => {
          const cleaned = stripSourceAttribution(r.description as string | null);
          return cleaned || null;
        })(),
        // Подпись под описанием: есть, только пока живой текст совпадает с
        // одобренным переводом (условие JOIN выше). Разошлись — null.
        descriptionSource: describeDescriptionSource(r.description_source_ref as string | null),
        essence: r.essence as string | null,
        category: r.category as string | null,
        locationType: r.location_type as string | null,
        lat: parseFloat(r.lat as string),
        lng: parseFloat(r.lng as string),
        zone: r.zone as string | null,
        district: r.district as string | null,
        /**
         * СВОЙ СНИМОК ВПЕРЕДИ ЧУЖОЙ ССЫЛКИ (19.09).
         *
         * Порядок был обратный: сначала `places.photo_url`, потом
         * `places.images[0]`, и только потом наш собственный снимок. Оба
         * первых поля собраны ИМПОРТОМ с посторонних сайтов, то есть это
         * ссылки, которые живут ровно столько, сколько захочет их владелец.
         *
         * Пока чужая ссылка отвечает, она заслоняет наше фото; как только
         * перестаёт — герой пустеет, хотя снимок у нас есть. Ровно это
         * владелец и увидел на Вилючинском: двумя часами раньше в
         * `ai_route_images` легли два его собственных кадра (миграция 979), а
         * карточка показала пустоту, потому что выбирала не их.
         *
         * Соседний блок `images` этим же файлом объявляет обратное правило
         * словами: «Свои важнее чужих намеренно... здесь фотографии, у которых
         * мы знаем автора и права». Герой ему противоречил — одно правило,
         * записанное дважды, разошлось (тот же урок, что с шириной карточки
         * и стандартом линии).
         *
         * Чужие ссылки не выброшены: они остаются запасом на случай, когда
         * своего снимка нет.
         */
        photoUrl: (() => {
          if (Number(r.photo_count) > 0) {
            const v = r.photo_version ? `?v=${String(r.photo_version)}` : '';
            return `/api/images/route/${r.ark_id}${v}`;
          }
          if (r.photo_url) return r.photo_url as string;
          // Use first real URL from places.images if available
          const imgs = r.images as unknown[] | null;
          if (Array.isArray(imgs) && imgs.length > 0) {
            const first = imgs[0];
            if (typeof first === 'string' && (first.startsWith('http') || first.startsWith('/'))) return first;
          }
          return null;
        })(),
        // Галерея героя. PlaceHero включает свайп при images.length > 1;
        // до 14.09 кормить его было нечем, кроме legacy-списка ССЫЛОК в
        // places.images — наши собственные снимки лежали байтами и по одному
        // на место. Теперь: есть свои снимки галереи — показываем их, герой
        // первым кадром. Нет — прежний legacy-список, как было.
        //
        // Свои важнее чужих намеренно: places.images собирался импортом с
        // посторонних сайтов, а здесь фотографии, у которых мы знаем автора
        // и права.
        images: (() => {
          const gallery = (r.gallery_urls as unknown[] | null) ?? [];
          if (Array.isArray(gallery) && gallery.length > 0) {
            const v = r.photo_version ? `?v=${String(r.photo_version)}` : '';
            const hero = Number(r.photo_count) > 0
              ? [`/api/images/route/${r.ark_id}${v}`]
              : [];
            return [...hero, ...gallery];
          }
          return (r.images as unknown[] | null) ?? [];
        })(),
        // Сколько снимков у места ВСЕГО — герой плюс галерея. Раньше число
        // означало «есть ли настоящее фото» и дальше единицы не росло;
        // счётчик «3/7» в PlaceHero по нему судить не мог.
        photoCount: Number(r.photo_count) + ((r.gallery_urls as unknown[] | null)?.length ?? 0),
        // Атрибуция фото — обязательна для CC-BY/CC-BY-SA (model=wikimedia).
        // Подпись идёт за ДАННЫМИ, а не за именем модели. Прежде условие
        // требовало `photo_model === 'wikimedia'`, и снимок ручной загрузки
        // не подписывался НИКОГДА — даже когда автор и лицензия у него
        // записаны. Для фото, взятого у правообладателя (владелец 14.09:
        // «возьму фотки у вулканологов»), это прямое нарушение условий:
        // лицензия почти всегда требует видимого указания автора.
        photoAttribution: (r.photo_author || r.photo_license) ? {
          author: (r.photo_author as string | null) ?? null,
          license: (r.photo_license as string | null) ?? null,
          licenseUrl: (r.photo_license_url as string | null) ?? null,
          sourceUrl: (r.photo_source_url as string | null) ?? null,
        } : null,
        bestSeason: r.best_season as string | null,
        seasonalNotes: r.seasonal_notes as Record<string, string> | null,
        accessInfo: r.access_info as string | null,
        sourceUrl: r.source_url as string | null,
        sourceName: r.source_name as string | null,
        updatedAt: r.updated_at as string | null,
        kuzmichReview: (r.kuzmich_review as string | null) ?? null,

        eco: r.eco_zone ? {
          zone: r.eco_zone as string,
          permitRequired: Boolean(r.eco_permit_required),
          rules: (r.eco_rules as string | null) ?? null,
          permitUrl: (r.eco_permit_url as string | null) ?? null,
        } : null,

        indigenous: (() => {
          const raw = r.indigenous_info as Record<string, unknown> | null;
          if (!raw) return null;
          const peoples = Array.isArray(raw.peoples) ? (raw.peoples as string[]) : [];
          if (peoples.length === 0 && !raw.local_name && !raw.sacred) return null;
          return {
            peoples,
            localName: (raw.local_name as string | null) ?? null,
            sacred: Boolean(raw.sacred),
            traditionalUse: (raw.traditional_use as string | null) ?? null,
            respectNotes: (raw.respect_notes as string | null) ?? null,
          };
        })(),

        safety: {
          difficultyLevel: r.difficulty_level != null ? Number(r.difficulty_level) : null,
          altitudeM: r.altitude_m != null ? Number(r.altitude_m) : null,
          altitudeDiffM: r.altitude_diff_m != null ? Number(r.altitude_diff_m) : null,
          distanceKm: r.distance_km != null ? Number(r.distance_km) : null,
          terrainType: r.terrain_type as string | null,
          roadType: r.road_type as string | null,
          roadAccessibility: r.road_accessibility != null ? Number(r.road_accessibility) : null,
          nearestMedicalKm: r.nearest_medical_km != null ? Number(r.nearest_medical_km) : null,
          emergencyAccess: r.emergency_access as string | null,
          phoneRangerMches: r.phone_ranger_mches as string | null,
          satCommunicatorRequired: r.sat_communicator_required as boolean | null,
          rulesRequired: r.rules_required as string | null,
          weatherThreshold: r.weather_threshold as Record<string, unknown> | null,
          hazardTypes,
          capacityPerDay: r.capacity_per_day != null ? Number(r.capacity_per_day) : null,
          optimalGroupSize: r.optimal_group_size != null ? Number(r.optimal_group_size) : null,
          openFromDate: r.open_from_date as string | null,
          openToDate: r.open_to_date as string | null,
          requiredGear,
          connectivity: r.connectivity as Record<string, unknown> | null,
          registrationRequired: r.registration_required as boolean ?? false,
          medicalInfo: r.medical_info as string | null,
        },

        volcanoStatus: (r.location_type === 'volcano' && r.volcano_acc && r.volcano_acc !== 'unassigned') ? {
          colorCode: r.volcano_acc as string,
          ashHeightM: r.volcano_ash_height_m != null ? Number(r.volcano_ash_height_m) : null,
          summary: (r.volcano_summary as string | null) ?? null,
          sourceUrl: (r.volcano_source_url as string | null) ?? null,
          observedAt: r.volcano_observed_at as string | null,
        } : null,

        realtime: r.is_open !== null || r.alert_severity !== null ? {
          isOpen: r.is_open as boolean | null,
          currentCrowds: r.current_crowds != null ? Number(r.current_crowds) : null,
          currentWeather: r.current_weather as Record<string, unknown> | null,
          activeAlerts: r.active_alerts as string[] | null,
          alertSeverity: r.alert_severity != null ? Number(r.alert_severity) : null,
          alertMessage: r.alert_message as string | null,
          touristsToday: r.tourists_today != null ? Number(r.tourists_today) : null,
          touristsHour: r.tourists_hour != null ? Number(r.tourists_hour) : null,
          updatedAt: r.realtime_updated_at as string | null,
        } : null,

        routes: routesResult.rows.map(rt => ({
          id: rt.id as string,
          title: rt.title as string,
          activityType: rt.activity_type as string | null,
          difficulty: rt.difficulty as string | null,
          distanceKm: rt.distance_km != null ? Number(rt.distance_km) : null,
          durationHours: rt.duration_hours != null ? Number(rt.duration_hours) : null,
        })),

        tours: toursResult.rows.map(t => ({
          id: t.id as string,
          title: t.title as string,
          basePrice: Number(t.base_price),
          durationDays: t.duration_days != null ? Number(t.duration_days) : null,
          operatorName: t.operator_name as string,
          operatorSlug: t.operator_slug as string | null,
        })),

        reviews: reviewsResult.rows.map(rv => ({
          id: rv.id as string,
          rating: Number(rv.rating),
          comment: rv.comment as string | null,
          authorName: rv.author_name as string,
          createdAt: rv.created_at as string,
        })),

        nearby: nearbyResult.rows.map(n => ({
          id: n.id as string,
          name: n.name as string,
          locationType: n.location_type as string | null,
          lat: parseFloat(n.lat as string),
          lng: parseFloat(n.lng as string),
          distanceKm: Number(n.distance_km),
          thumbUrl: (n.thumb_url ?? n.photo_url) as string | null,
        })),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Ошибка базы данных';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
