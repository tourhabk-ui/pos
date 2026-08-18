/**
 * GET /api/routes/[id]
 * Один маршрут по UUID + предложения операторов из marketplace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { pool } from '@/lib/db-pool';
import { extractTrackpoints, decimateTrackWithScale } from '@/lib/routes/track';
import { accumulateRelief } from '@/lib/routes/relief';
import { collapseOperationalAlerts } from '@/lib/routes/operational-alerts';
import { buildRoutePassport } from '@/lib/routes/passport';
import { routeNavigability } from '@/lib/routes/navigability';
import { trackEvidence } from '@/lib/routes/track-evidence';

export const dynamic = 'force-dynamic';

/**
 * Сбой запроса — в лог, с тем, чем его чинят.
 *
 * До 16.08 три запроса карточки маршрута заканчивались
 * `.catch(() => ({ rows: [] }))`. Это превращало ЛЮБУЮ ошибку — упавший
 * JOIN, разъехавшуюся колонку, недоступную таблицу — в правдоподобную
 * пустоту: снаружи «у маршрута нет точек» и «запрос к точкам упал»
 * выглядели одинаково. Смоук 16.08 увидел «0 точек с координатами» у
 * настоящего маршрута и не мог сказать, дефект это данных или поломка.
 *
 * SQLSTATE называет род поломки однозначно (текст — нет), форма запроса
 * говорит, какая ветка сломалась, релиз привязывает к версии.
 */
function logQueryFailure(part: string, err: unknown, routeId: string): void {
  const e = err as Error & { code?: string; detail?: string; hint?: string; position?: string };
  console.error('[/api/routes/[id]] запрос упал', {
    part,
    routeId,
    sqlstate: e?.code,
    message: e?.message,
    detail: e?.detail,
    hint: e?.hint,
    position: e?.position,
    release: process.env.RELEASE_SHA ?? null,
  });
}

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
         kr.id AS kr_id,
         kr.route_version,
         kr.passport_verified_at,
         kr.updated_at AS kr_updated_at,
         pk.slug AS park_slug,
         COALESCE(kr.geometry, krs.geometry) AS geometry
       FROM agent_route_knowledge ark
       LEFT JOIN ai_route_images ari ON ari.route_id = ark.id
       -- id VIEW для маршрутов — COALESCE(ark_id, id): строка kamchatka_routes
       -- ищется по обоим, иначе маршрут с заполненным ark_id терял трек,
       -- МЧС-поля и waypoints (id-пространства расходились молча).
       LEFT JOIN kamchatka_routes kr ON kr.id = ark.id OR kr.ark_id = ark.id
       LEFT JOIN LATERAL (
         -- Трек места может жить отдельной строкой kamchatka_routes
         -- (точка «Гора Замок» ↔ её маршрут): связь через metadata.place_ark_id
         -- или общий source_url — та же логика, что в GPX-экспорте
         SELECT geometry FROM kamchatka_routes k2
         WHERE k2.geometry IS NOT NULL
           AND k2.id <> ark.id
           AND k2.id IS DISTINCT FROM kr.id
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

    const r = result.rows[0];
    const payload = (r.payload as Record<string, unknown>) ?? {};

    // Канонический id строки kamchatka_routes: id VIEW может быть ark_id,
    // а route_waypoints / operator_tours / view_count живут на kr.id.
    const routeDbId = (r.kr_id as string | null) ?? id;

    // Increment view count (fire-and-forget)
    pool.query('UPDATE kamchatka_routes SET view_count = view_count + 1 WHERE id = $1', [routeDbId]).catch(() => {});

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
        [routeDbId]
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
    /** Живой статус точек мог не прочитаться — тишина тогда не значит «спокойно». */
    let operationalUnavailable = false;

    /**
     * Точки маршрута — его хребет, и их отказ НЕ переживается.
     *
     * Прежде здесь стоял `.catch(() => ({ rows: [] }))`, и упавший запрос
     * отдавался как маршрут с нулём точек: карточка открывалась, линии не
     * было, кнопка вела дальше. Отдать 200 с пустым хребтом — это соврать
     * о маршруте, а на этой платформе по такому ответу человек идёт в поле.
     * Пусть лучше карточка честно не откроется.
     */
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
         AND p.merged_into_id IS NULL
       ORDER BY rw.position`,
      [routeDbId]
    ).catch((err: unknown) => {
      /**
       * Отказ помечается СВОИМ именем и бросается дальше.
       *
       * Без этого он попадал бы в общий `route_detail` внешнего catch, и
       * массовая недоступность страниц маршрутов была бы неотличима от
       * любой другой ошибки карточки. Строгость правильная (лучше не
       * открыть, чем открыть без хребта), но она обязана быть НАБЛЮДАЕМОЙ:
       * иначе тихо превратится в мор страниц, который никто не связал с
       * этим решением.
       *
       * Имя `waypoints_failure` стабильно — по нему строится счётчик.
       */
      logQueryFailure('waypoints_failure', err, id);
      throw err;
    });

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
         AND p.merged_into_id IS NULL
         AND (
           (rs.alert_message IS NOT NULL AND (rs.alert_expires_at IS NULL OR rs.alert_expires_at > NOW()))
           OR rs.is_open = FALSE
           OR COALESCE(array_length(rs.active_alerts, 1), 0) > 0
         )
       ORDER BY rw.position`,
      [routeDbId]
    ).catch((err: unknown) => {
      /**
       * Оперативные ограничения падать вместе со страницей не должны —
       * маршрут без живого статуса всё ещё полезен. Но и подменять отказ
       * тишиной нельзя: пустой список читается как «ограничений нет», то
       * есть как разрешение идти. Это запрещено платформой отдельно
       * (§0.3: «нет данных» ≠ «спокойно»).
       *
       * Поэтому отказ помечается флагом, и карточка обязана сказать
       * «статус недоступен» вместо молчаливого спокойствия.
       */
      logQueryFailure('operational_alerts', err, id);
      operationalUnavailable = true;
      return { rows: [] };
    });

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
    ).catch((err: unknown) => {
      // Отзывы — единственный из трёх запросов, чей отказ можно пережить:
      // пустой список отзывов не лжёт о маршруте и не влияет на решение идти.
      // Но и он больше не молчит: без записи в лог поломка живёт незамеченной.
      logQueryFailure('reviews', err, id);
      return { rows: [] };
    });

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
        /**
         * Полевой паспорт — граница доверия к данным маршрута, собранная
         * одним правилом (lib/routes/passport): род линии, версия редакции,
         * число точек, требования доступа. Показывается ДО фиксации маршрута:
         * различение трека и наброска — главная защита, и она не должна
         * открываться человеку только в поле.
         */
        passport: (() => {
          const { points } = decimateTrackWithScale(extractTrackpoints(
            r.geometry as { type?: string; coordinates?: number[][] } | null,
            payload,
          ));
          return buildRoutePassport({
            track: points.length >= 2 ? points.map(p => [p.lat, p.lng] as [number, number]) : null,
            geometrySource: ((r.geometry as { source?: string } | null)?.source ?? null),
            waypointsCount: waypointsResult.rows.length,
            routeVersion: r.route_version != null ? Number(r.route_version) : null,
            verifiedAt: (r.passport_verified_at as string | null) ?? null,
            updatedAt: (r.kr_updated_at as string | null) ?? null,
            mchsRequired: (r.mchs_registration_required as boolean | null) ?? false,
            mchsPhone: (r.mchs_phone as string | null) ?? null,
            parkName: (r.park_name as string | null) ?? null,
            parkApprovalUrl: (r.park_approval_url as string | null) ?? null,
            officialPassportUrl: (r.official_passport_url as string | null) ?? null,
          });
        })(),
        /**
         * Черта: можно ли обещать ведение по этой записи.
         *
         * Считается ЗДЕСЬ, а не на экране, потому что здесь есть и линия, и
         * точки. Экран выбора линию не грузит — он видел бы только род данных
         * и не заметил бы расхождения точек с линией; ровно такой маршрут
         * («Вулкан Козельский», точка в 14 км от трека) и выглядел пригодным
         * до самого поля.
         *
         * Правило одно на всю платформу — lib/routes/navigability.
         */
        navigability: (() => {
          const { points } = decimateTrackWithScale(extractTrackpoints(
            r.geometry as { type?: string; coordinates?: number[][] } | null,
            payload,
          ));
          const track = points.length >= 2
            ? points.map(p => [p.lat, p.lng] as [number, number])
            : null;
          const wpRows = waypointsResult.rows.filter(w => w.lat != null && w.lng != null);
          const wps = wpRows.map(w => ({ lat: Number(w.lat), lng: Number(w.lng) }));
          // Рода нужны черте, чтобы не считать противоречием центроид парка.
          const wpTypes = wpRows.map(w => (w as { location_type?: string | null }).location_type ?? null);
          return routeNavigability({
            // Улика считается по СЫРОЙ геометрии: высота лежит третьим числом,
            // а разбор в пары его отбрасывает. Прореженная линия для улики не
            // годится и по другой причине — прореживание выравнивает шаг,
            // то есть стирает главный признак живой записи.
            evidence: trackEvidence(r.geometry).verdict,
            grade: buildRoutePassport({
              track,
              geometrySource: ((r.geometry as { source?: string } | null)?.source ?? null),
              waypointsCount: waypointsResult.rows.length,
              routeVersion: null, verifiedAt: null, updatedAt: null,
              mchsRequired: false, mchsPhone: null, parkName: null,
              parkApprovalUrl: null, officialPassportUrl: null,
            }).grade,
            track,
            waypoints: wps,
            waypointTypes: wpTypes,
          });
        })(),
        /**
         * Происхождение линии — как ЗАПИСАНО в геометрии, без догадок.
         *
         * Перепись 11.08 (проба 55): источник записан у 295 линий из 301
         * (idilesom 257, waypoints_synthetic 19, osm 13, visitkamchatka 6),
         * а вид линии на экранах выбирала эвристика плотности точек — и на
         * «Вулкане Жупановском» выдала синтетику за снятый трек. Сплошная
         * зелёная означает «здесь идут»; по ней идут.
         *
         * null — источника в данных нет (шесть записей). Это ЧЕСТНЫЙ null:
         * экран говорит про него словами, а не рисует одно из известных
         * состояний. Не путать с отсутствием поля — отсутствие значило бы,
         * что API не спрашивали.
         */
        geometrySource: ((r.geometry as { source?: string } | null)?.source ?? null),
        // GPS-трек для карты: [lat, lng][], прорежен до ~600 точек.
        // null = трека нет нигде (geometry, payload.geometry, payload.track)
        track: (() => {
          const { points } = decimateTrackWithScale(extractTrackpoints(
            r.geometry as { type?: string; coordinates?: number[][] } | null,
            payload,
          ));
          return points.length >= 2 ? points.map(p => [p.lat, p.lng] as [number, number]) : null;
        })(),
        /**
         * Шкала трека: сколько метров ПОЛНОГО трека приходится на каждую
         * оставленную после прореживания точку.
         *
         * Прореживание берёт каждую N-ю точку, поэтому ломаная короче
         * исходной — тем сильнее, чем извилистее путь. Профиль высот при этом
         * считается по полному треку. Без этой шкалы клиент мерил положение
         * одной меркой, а резал профиль другой, и срез уезжал к началу на
         * сотни метров. Две мерки для одного расстояния — тот же дефект, что
         * мы чиним на этом экране, только в контракте API.
         */
        track_dm: (() => {
          const { points, dm } = decimateTrackWithScale(extractTrackpoints(
            r.geometry as { type?: string; coordinates?: number[][] } | null,
            payload,
          ));
          return points.length >= 2 ? dm : null;
        })(),
        /**
         * Профиль высот считается на сервере по ПОЛНОМУ треку (прореживание
         * для карты сюда не годится: оно выбрасывает как раз перегибы) и
         * приходит готовым — клиент только режет его от текущей позиции.
         * `reliable: false` означает «высот в данных нет»; экран обязан
         * сказать это словами, а не рисовать линию из ничего.
         */
        relief: (() => {
          const pts = extractTrackpoints(
            r.geometry as { type?: string; coordinates?: number[][] } | null,
            payload,
          );
          if (pts.length < 2) return null;
          const relief = accumulateRelief(pts);
          // Откуда взялись высоты. Трек с высотами из GPS и трек, которому
          // высоты дозаполнены моделью рельефа, — разные по достоверности
          // данные, и экран обязан их различать: у модели нет ям, троп и
          // свежих осыпей, она знает только форму земли.
          const elevationSource =
            (r.geometry as { elevation_source?: unknown } | null)?.elevation_source;
          return {
            elevationSource: typeof elevationSource === 'string' ? elevationSource : null,
            distanceM: relief.distanceM,
            ascentM: relief.ascentM,
            descentM: relief.descentM,
            minM: relief.minM,
            maxM: relief.maxM,
            reliable: relief.reliable,
            points: relief.points,
          };
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
        // Живой статус не прочитался: пустой список ограничений выше не
        // означает «ограничений нет». Карточка обязана сказать это словами,
        // а не показать спокойствие, которого никто не подтверждал.
        operationalStatusUnavailable: operationalUnavailable,
      },
    });
  } catch (error) {
    // Раньше причина уходила только в ответ и только в dev — то есть в
    // проде не сохранялась нигде. Теперь она в логе всегда, с SQLSTATE и
    // формой запроса; наружу по-прежнему нейтральный текст.
    logQueryFailure('route_detail', error, id);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки маршрута', details: process.env.NODE_ENV === 'development' ? msg : undefined },
      { status: 500 }
    );
  }
}
