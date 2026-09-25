/**
 * lib/routes/catalog-query.ts — общий data-слой каталога мест/маршрутов.
 *
 * Единственный источник query-логики для двух потребителей:
 *   - GET /api/routes (клиентские фильтры/пагинация/карта);
 *   - RSC app/routes/page.tsx (SSR первого рендера — SEO, шаг 3 аудита 11.07).
 * Логика вынесена из app/api/routes/route.ts БЕЗ изменений поведения, чтобы
 * листинг и API не разъехались (общая функция вместо копипасты).
 *
 * queryCatalogCached — обёртка unstable_cache (revalidate 600с) для SSR:
 * боту и юзеру мгновенный HTML, БД не долбится на каждый хит. Поисковые
 * запросы (q) кэш обходят — неограниченное множество ключей загрязняло бы кэш.
 */

import { unstable_cache } from 'next/cache';
import { z } from 'zod';
import { query } from '@/lib/database';
import { lineGradeForList, type PassportGrade } from '@/lib/routes/passport';
import { lineRankSql } from '@/lib/map/line-standard';
import { shownPhotoSql } from '@/lib/images/origin';
// Род картинки карточки — один источник на каталог, карточку и перепись
// (lib/routes/card-image.ts). Своё выражение здесь уже расходилось с тем,
// что перепись рассказывала владельцу про градиент.
import { cardImage } from '@/lib/routes/card-image';


/** Определение опасностей на основе данных точки/маршрута. */
function resolveHazards(row: Record<string, unknown>): string[] {
  const hazards: string[] = [];
  const payload = (typeof row.payload === 'object' && row.payload !== null ? row.payload : {}) as Record<string, unknown>;
  const desc = typeof row.description === 'string' ? row.description.toLowerCase() : '';

  if (row.volcano_status && row.volcano_status !== 'green' && row.volcano_status !== 'normal') {
    hazards.push('volcano_activity');
  }
  if (payload.has_bears || desc.includes('медвед')) {
    hazards.push('bears_active');
  }
  if (payload.difficulty === 'hard' || payload.difficulty === 'extreme') {
    hazards.push('high_difficulty');
  }
  if (payload.requires_permit || desc.includes('разрешен') || desc.includes('пропуск')) {
    hazards.push('permit_required');
  }
  if (payload.weather_unstable || desc.includes('погода изменчива')) {
    hazards.push('weather_risk');
  }

  return hazards;
}

export const CatalogQuerySchema = z.object({
  q:             z.string().max(200).optional(),
  kind:          z.enum(['place', 'route', 'tour']).optional(),
  category:      z.string().max(60).optional(),
  location_type: z.string().max(60).optional(),
  activity_type: z.string().max(60).optional(),
  page:          z.coerce.number().int().min(1).default(1),
  limit:         z.coerce.number().int().min(1).max(2000).default(24),
  hasCoords:     z.enum(['true', 'false']).optional(),
  // `navigable` — очерёдность для ВЫБОРА МАРШРУТА В ПОЛЕ: сначала род линии
  // (снятый трек → набросок → линия не проверена → линии нет), и лишь внутри
  // рода — полнота карточки. Заведена 19.09 по жалобе владельца, см.
  // LINE_RANK в lib/map/line-standard.ts.
  sort:          z.enum(['title', 'recent', 'price_asc', 'price_desc', 'recommended', 'navigable']).default('title'),
  difficulty:    z.enum(['easy', 'medium', 'hard']).optional(),
  price_min:     z.coerce.number().min(0).optional(),
  price_max:     z.coerce.number().min(0).optional(),
  // Фильтр «Рядом»: точки в радиусе от якоря (позиция туриста или ПК)
  near_lat:      z.coerce.number().min(-90).max(90).optional(),
  near_lng:      z.coerce.number().min(-180).max(180).optional(),
  radius_km:     z.coerce.number().min(1).max(1000).optional(),
  // Только маршруты с реальными точками (route_waypoints) — планировщик
  // в поле не должен рекомендовать статьи-обзоры без единой точки
  has_waypoints: z.enum(['true']).optional(),
});

export type CatalogFilters = z.infer<typeof CatalogQuerySchema>;

export interface CatalogItem {
  imageUrl?: string;
  id: string;
  slug: string;
  kind: 'place' | 'route' | 'tour';
  category: string;
  locationType: string | null;
  activityType: string | null;
  title: string;
  description: string;
  lat: number | null;
  lng: number | null;
  sourceUrl: string | null;
  sourceName: string | null;
  priceFrom: number | null;
  season: string | null;
  difficulty: string | null;
  durationDays: number | null;
  bestMonths: number[] | null;
  /**
   * Линия/полигон из payload — только ФОРМА (type + coordinates). Стиль
   * (color/weight) из данных не пробрасывается: вид линии назначает стандарт
   * §12 (lib/map/line-standard) на экране — данные не выбирают, каким
   * выглядеть импортированному пути.
   */
  geometry: { type: string; coordinates: [number, number][] } | null;
  volcanoStatus: string | null;
  /** Есть РЕАЛЬНОЕ фото (wikimedia) в хранилище изображений. AI-генерации
      больше не показываются — вместо них честный градиент по типу места. */
  hasRealImage: boolean;
  hazards: string[];
  /** Живой статус точки из location_real_time_status; null — данных нет */
  isOpen: boolean | null;
  /**
   * Род навигационных данных маршрута для бейджа в списке выбора
   * (Трек / Набросок / Линия не проверена / Точки). Считается по реальной
   * geometry из kamchatka_routes, не по payload. null — не маршрут.
   */
  lineGrade: PassportGrade | null;
}

export interface CatalogResult {
  items: CatalogItem[];
  meta: { total: number; page: number; limit: number; pages: number };
}

/**
 * Геометрия из payload — только форма, без стиля.
 *
 * В payload скрейпов встречались color/weight прямо в объекте геометрии, и
 * карта рисовала их как есть — импортированная линия сама назначала себе вид
 * снятого трека, в обход §12. Форму пропускаем, стиль назначает экран через
 * lib/map/line-standard.
 */
function stripGeometryStyle(v: unknown): CatalogItem['geometry'] {
  if (!v || typeof v !== 'object') return null;
  const g = v as { type?: unknown; coordinates?: unknown };
  if (typeof g.type !== 'string' || !Array.isArray(g.coordinates)) return null;
  return { type: g.type, coordinates: g.coordinates as [number, number][] };
}

export async function queryCatalog(filters: CatalogFilters): Promise<CatalogResult> {
  const { q, kind, category, location_type, activity_type, page, limit, hasCoords, sort, difficulty, price_min, price_max, near_lat, near_lng, radius_km, has_waypoints } = filters;
  const offset = (page - 1) * limit;

  const conditions: string[] = ['ark.is_visible = TRUE'];
  const params: unknown[] = [];
  let idx = 1;

  if (q) {
    conditions.push(`(ark.title ILIKE $${idx} OR ark.description ILIKE $${idx + 1})`);
    params.push(`%${q}%`, `%${q}%`);
    idx += 2;
  }
  if (kind) {
    conditions.push(`ark.kind = $${idx}`);
    params.push(kind);
    idx++;
  }
  if (category) {
    conditions.push(`ark.category = $${idx}`);
    params.push(category);
    idx++;
  }
  if (location_type) {
    conditions.push(`ark.location_type = $${idx}`);
    params.push(location_type);
    idx++;
  }
  if (activity_type) {
    conditions.push(`ark.activity_type = $${idx}`);
    params.push(activity_type);
    idx++;
  }
  if (hasCoords === 'true') {
    conditions.push(`ark.lat IS NOT NULL AND ark.lng IS NOT NULL`);
  }
  if (difficulty) {
    conditions.push(`ark.payload->>'difficulty' = $${idx}`);
    params.push(difficulty);
    idx++;
  }
  if (price_min != null) {
    conditions.push(`(ark.payload->>'price_from')::numeric >= $${idx}`);
    params.push(price_min);
    idx++;
  }
  if (price_max != null) {
    conditions.push(`(ark.payload->>'price_from')::numeric <= $${idx}`);
    params.push(price_max);
    idx++;
  }
  if (has_waypoints === 'true') {
    // Точек должно быть НЕ МЕНЬШЕ ДВУХ и они должны быть компактными.
    //
    // Две — потому что путь начинается и заканчивается: одна точка задаёт
    // место, а не маршрут. Проверка 16.08 нашла в выдаче «Восхождение на
    // Авачинский вулкан» с единственной точкой, подписанное «14 км · Средний»:
    // экран честно печатал «Вулкан Авачинский → Вулкан Авачинский», то есть
    // предлагал идти из точки в неё же. Прежнее EXISTS пропускало такую
    // запись — «есть хоть одна точка» и «есть маршрут» это разные факты.
    //
    // Компактность (bbox ≤ ~55 км) отсекает мега-сборники: «35 мест по всему
    // краю» имеют waypoints, но их синтетическая геометрия — паутина прямых
    // через весь Петропавловск (полевой скрин 20.07), это не проходимый трек.
    //
    // Считаем ТОЛЬКО точки с координатами: точка без lat/lng на карте не
    // существует, и пара, где одна половина безкоординатная, — та же одна.
    //
    // route_waypoints.route_id живёт на kamchatka_routes.id, а id VIEW для
    // маршрутов — COALESCE(ark_id, id): точки ищутся через строку маршрута
    // по обоим id, иначе маршрут с заполненным ark_id невидим для навигации.
    conditions.push(
      `(SELECT COUNT(*) >= 2
              AND (MAX(p.lat) - MIN(p.lat)) <= 0.5
              AND (MAX(p.lng) - MIN(p.lng)) <= 0.8
          FROM kamchatka_routes kw2
          JOIN route_waypoints rwx2 ON rwx2.route_id = kw2.id
          JOIN places p ON p.id = rwx2.place_id
          WHERE (kw2.id = ark.id OR kw2.ark_id = ark.id)
            AND p.lat IS NOT NULL AND p.lng IS NOT NULL)`,
    );
  }
  if (near_lat != null && near_lng != null && radius_km != null) {
    // Гаверсинус в SQL; least(1.0, ...) страхует acos от погрешности округления
    conditions.push(
      `ark.lat IS NOT NULL AND ark.lng IS NOT NULL AND 6371 * acos(least(1.0,
         cos(radians($${idx})) * cos(radians(ark.lat)) * cos(radians(ark.lng) - radians($${idx + 1}))
         + sin(radians($${idx})) * sin(radians(ark.lat)))) <= $${idx + 2}`,
    );
    params.push(near_lat, near_lng, radius_km);
    idx += 3;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  /**
   * ВСЕ колонки в ORDER BY квалифицированы через ark — включая те, что
   * годами работали без префикса.
   *
   * 16.08, SQLSTATE 42702: `column reference "description" is ambiguous`.
   * Каталог отдавал 503, планировщик открывался пустым. Рядом стояло голое
   * `title ASC` и не падало — разница в правиле разрешения имён: голое имя
   * в ORDER BY Postgres ищет сначала среди ВЫХОДНЫХ колонок SELECT, а имя
   * ВНУТРИ выражения (`length(COALESCE(description, ''))`) резолвит по
   * таблицам FROM. Там `description` есть и у `ark`, и у присоединённой
   * `kamchatka_routes krl` — отсюда неоднозначность.
   *
   * Тонкость в том, что падает не «ветка маршрутов», а сортировка
   * `recommended`: только она содержит выражения с голыми именами. Место с
   * сортировкой по умолчанию (`title ASC`) работало, и это маскировало
   * поломку — диагностика, спрашивавшая только `kind=place`, отвечала
   * «здоров».
   *
   * Это третий случай подряд (`is_visible` — проба 84, теперь `description`),
   * и каждый раз ломалось при добавлении JOIN, а не при правке сортировки.
   * Поэтому префикс ставится везде, а не только там, где сейчас больно:
   * следующий JOIN не должен ронять каталог.
   */
  // Полнота карточки: тот же счёт, что в `recommended`. Вынесен, потому что
  // `navigable` использует его как ВТОРОЙ ключ — после рода линии.
  const cardRichness = `(
      CASE WHEN ark.payload->>'price_from'    IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN ark.payload->>'difficulty'    IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN ark.payload->>'duration_days' IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN ark.payload->>'best_months'   IS NOT NULL THEN 1 ELSE 0 END
    ) DESC`;

  const orderBy =
    sort === 'recent'      ? 'ark.created_at DESC' :
    sort === 'price_asc'   ? 'COALESCE((ark.payload->>\'price_from\')::numeric, 999999999) ASC, ark.title ASC' :
    sort === 'price_desc'  ? 'COALESCE((ark.payload->>\'price_from\')::numeric, 0) DESC, ark.title ASC' :
    sort === 'recommended' ? `
    -- МЕСТО БЕЗ СНИМКА — В САМЫЙ КОНЕЦ (решение владельца 20.09).
    --
    -- Вместе со снятием подстановки кадром оператора: раньше у 226 мест из
    -- 378 карточка показывала чужой кадр, и «без фото» на витрине не
    -- существовало как состояния. Теперь оно видно, и владелец решил, что
    -- такие места идут последними.
    --
    -- До сегодня это ВЫХОДИЛО САМО, но случайно: ключ has_real_image стоял
    -- вторым, после суммы полноты карточки, а сумма у мест всегда 0, потому
    -- что VIEW отдаёт им пустой payload (миграция 942). То есть порядок
    -- держался на свойстве ЧУЖИХ данных, а не на правиле. Здесь он назван
    -- правилом и от payload больше не зависит.
    --
    -- Условие повторяет предикат показа через тот же shownPhotoSql, а не
    -- ссылается на колонку has_real_image: имя выходной колонки SELECT
    -- Postgres понимает только голым, внутри выражения оно не видно (тот же
    -- разбор, что в комментарии о квалификации колонок выше).
    --
    -- Маршрутов и туров ключ не касается: у них ark.kind другой, выражение
    -- всегда 0, и прежний порядок сохраняется.
    CASE WHEN ark.kind = 'place'
              AND NOT (ari.route_id IS NOT NULL AND ${shownPhotoSql('ari.model')})
         THEN 1 ELSE 0 END ASC,
    (
      CASE WHEN ark.payload->>'price_from'    IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN ark.payload->>'difficulty'    IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN ark.payload->>'duration_days' IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN ark.payload->>'best_months'   IS NOT NULL THEN 1 ELSE 0 END
    ) DESC,
    -- Качество карточки: у туров/маршрутов порядок задаёт сумма выше (у них есть
    -- цена/сложность), а у мест она всегда 0 — поэтому места ранжируются дальше
    -- по «презентабельности»: есть фото -> значимый тип -> богатое описание.
    -- Так первый экран /places перестаёт быть алфавитным («300-летняя берёза»).
    -- has_real_image — вычисленная колонка SELECT, своей таблицы у неё нет.
    has_real_image DESC,
    CASE ark.location_type
      WHEN 'volcano'    THEN 6 WHEN 'geyser'  THEN 6
      WHEN 'hot_spring' THEN 5 WHEN 'lake'    THEN 5
      WHEN 'waterfall'  THEN 4 WHEN 'bay'     THEN 4
      WHEN 'mountain'   THEN 3 WHEN 'river'   THEN 3
      WHEN 'viewpoint'  THEN 2
      ELSE 1
    END DESC,
    length(COALESCE(ark.description, '')) DESC,
    ark.title ASC` :
    // Выбор маршрута В ПОЛЕ. Первый ключ — род линии, и только он отвечает на
    // вопрос, который человек на тропе задаёт на самом деле: можно ли по ней
    // идти. Полнота карточки осталась вторым ключом — внутри одного рода
    // маршрут с ценой, сложностью и сроками полезнее безымянного.
    //
    // Порядок родов собирается ИЗ реестров §12 (lineRankSql), а не
    // переписывается здесь: второй список источников разошёлся бы с первым.
    sort === 'navigable' ? `${lineRankSql('krl.geometry')} ASC,
    ${cardRichness},
    has_real_image DESC,
    length(COALESCE(ark.description, '')) DESC,
    ark.title ASC` :
    'ark.title ASC';

  const [dataResult, countResult] = await Promise.all([
    query(
      `SELECT
         ark.id,
         ark.route_dedupe_key,
         ark.kind,
         ark.category,
         ark.location_type,
         ark.activity_type,
         ark.title,
         ark.description,
         ark.lat,
         ark.lng,
         ark.source_url,
         ark.source_name,
         ark.payload,
         ark.payload->'price_from'      AS price_from,
         ark.payload->'season'          AS season,
         ark.payload->'difficulty'      AS difficulty,
         ark.payload->'duration_days'   AS duration_days,
         ark.payload->'best_months'     AS best_months,
         ark.payload->'geometry'        AS geometry,
         ark.payload->>'volcano_status' AS volcano_status,
         ark.created_at,
         -- Только реальные фото (wikimedia / ручная загрузка): AI-генерации в выдачу
         -- не идут — вместо них честный градиент (решение владельца 2026-07-17)
         (ari.route_id IS NOT NULL AND ${shownPhotoSql('ari.model')}) AS has_real_image,
         -- Живой статус места (открыто/закрыто) — свойство точки, не тура
         lrs.is_open,
         -- Род навигационных данных маршрута: РЕАЛЬНАЯ geometry из
         -- kamchatka_routes (payload->'geometry' — метаданные, не линия).
         -- Строка маршрута ищется по обоим id: id VIEW = COALESCE(ark_id, id).
         (krl.geometry IS NOT NULL)  AS has_line,
         krl.geometry->>'source'     AS geometry_source,
         (krl.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM route_waypoints rww WHERE rww.route_id = krl.id
         )) AS has_route_waypoints,
         wp.photo_id AS waypoint_photo_id
       FROM agent_route_knowledge ark
       LEFT JOIN ai_route_images ari ON ari.route_id = ark.id
       LEFT JOIN location_real_time_status lrs ON lrs.agent_route_id = ark.id
       LEFT JOIN kamchatka_routes krl
         ON ark.kind = 'route' AND (krl.id = ark.id OR krl.ark_id = ark.id)
       -- Снимок главной ТОЧКИ ПУТИ маршрута (card-image.ts, решение 26.09):
       -- только link_kind = 'waypoint' — место «рядом» не про этот путь;
       -- главная — чьё имя ближе к названию маршрута, при равенстве дальняя
       -- по ходу (у радиального маршрута это цель, а не парковка).
       LEFT JOIN LATERAL (
         SELECT p.ark_id::text AS photo_id
           FROM route_waypoints rw
           JOIN places p ON p.id = rw.place_id
          WHERE krl.id IS NOT NULL
            AND rw.route_id = krl.id
            AND rw.link_kind = 'waypoint'
            AND p.ark_id IS NOT NULL
            AND p.is_visible IS NOT FALSE
            AND p.merged_into_id IS NULL
            AND EXISTS (SELECT 1 FROM ai_route_images wpi
                         WHERE wpi.route_id = p.ark_id AND ${shownPhotoSql('wpi.model')})
          ORDER BY similarity(ark.title, p.name) DESC, rw.position DESC
          LIMIT 1
       ) wp ON TRUE
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM agent_route_knowledge ark ${where}`,
      params
    ),
  ]);

  const total = Number(countResult.rows[0]?.total ?? 0);

  const items: CatalogItem[] = dataResult.rows.map(r => {
    const payload = (r.payload as Record<string, unknown>) ?? {};
    const hasRealImage = Boolean(r.has_real_image);
    const imageUrl = cardImage({
      hasShownPhoto: hasRealImage,
      id: r.id as string,
      payload,
      category: r.category as string,
      // Род обязателен: у МЕСТА подстановки кадром оператора больше нет
      // (решение владельца 20.09, разбор в card-image.ts). Без него функция
      // считает запись местом и не подставляет — но маршрут тогда терял бы
      // свою картинку молча.
      kind: (r.kind as 'place' | 'route' | 'tour' | null) ?? 'place',
      waypointPhotoId: (r.waypoint_photo_id as string | null) ?? null,
    }).url;

    return {
      ...(imageUrl ? { imageUrl } : {}),
      id:           r.id as string,
      slug:         r.route_dedupe_key as string,
      kind:         ((r.kind as 'place' | 'route' | 'tour' | null) ?? 'place'),
      category:     r.category as string,
      locationType: (r.location_type as string | null) ?? null,
      activityType: (r.activity_type as string | null) ?? null,
      title:        r.title as string,
      description:  (r.description as string | null) ?? '',
      lat:          r.lat != null ? parseFloat(r.lat as string) : null,
      lng:          r.lng != null ? parseFloat(r.lng as string) : null,
      sourceUrl:    (r.source_url as string | null) ?? null,
      sourceName:   (r.source_name as string | null) ?? null,
      priceFrom:    r.price_from != null ? Number(r.price_from) : null,
      season:       (r.season as string | null) ?? null,
      difficulty:   (r.difficulty as string | null) ?? null,
      durationDays: r.duration_days != null ? Number(r.duration_days) : null,
      bestMonths:   (r.best_months as number[] | null) ?? null,
      // Стиль (color/weight) из payload намеренно НЕ пробрасывается: вид линии
      // назначает стандарт §12 (lib/map/line-standard) на экране, а не данные.
      // Пробрасывать стиль из скрейпнутого payload — значит дать импорту
      // нарисовать себя снятым треком.
      geometry:      stripGeometryStyle(r.geometry),
      volcanoStatus: (r.volcano_status as string | null) ?? null,
      hasRealImage,
      hazards:      resolveHazards(r),
      isOpen:       (r.is_open as boolean | null) ?? null,
      lineGrade:    ((r.kind as string | null) ?? 'place') === 'route'
        ? lineGradeForList(
            Boolean(r.has_line),
            (r.geometry_source as string | null) ?? null,
            Boolean(r.has_route_waypoints),
          )
        : null,
    };
  });

  return {
    items,
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  };
}

/**
 * Кэшированный путь для SSR-листинга. Поисковые запросы (q) идут мимо кэша:
 * произвольные строки создавали бы неограниченное множество ключей.
 */
export async function queryCatalogForPage(filters: CatalogFilters): Promise<CatalogResult> {
  if (filters.q) return queryCatalog(filters);
  return unstable_cache(
    () => queryCatalog(filters),
    ['catalog-query', JSON.stringify(filters)],
    { revalidate: 600 },
  )();
}
