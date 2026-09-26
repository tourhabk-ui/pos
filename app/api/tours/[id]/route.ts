import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { publicRating } from '@/lib/reviews/public-rating';

export const dynamic = 'force-dynamic';

// Локальные изображения-заглушки по категориям
const CATEGORY_IMAGES: Record<string, string> = {
  vulkani:              '/images/activities/volcanoes.jpg',
  geyzery:              '/images/activities/volcanoes.jpg',
  rybalka:              '/images/activities/fishing.jpg',
  termalnye_istochniki: '/images/activities/hotsprings.jpg',
  dzhip:                '/images/activities/jeep.jpg',
  snegohod:             '/images/activities/snowmobile.jpg',
  morskie_progulki:     '/images/activities/sea.jpg',
  vertoletnye_tury:     '/images/activities/helicopter.jpg',
  trekking:             '/images/gallery/camp-sunset.jpg',
  mountains:            '/images/gallery/stela.jpg',
  rivers:               '/images/bento/khalaktyr.jpg',
  lakes:                '/images/gallery/bay-sunset.jpg',
  medvedi:              '/images/gallery/road-winter.jpg',
  eco:                  '/images/gallery/aurora.jpg',
};

// GET /api/tours/[id] — публичный, без авторизации
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await query(
      `SELECT
        t.*,
        kr.id          AS route_kr_id,
        kr.title       AS route_title,
        kr.category    AS route_category,
        kr.lat         AS route_lat,
        kr.lng         AS route_lng,
        kr.source_url  AS route_source_url,
        p.id           AS partner_id_val,
        p.name         AS partner_name,
        p.rating       AS partner_rating,
        p.review_count AS partner_review_count
       FROM operator_tours t
       LEFT JOIN kamchatka_routes kr ON t.route_id = kr.id
       LEFT JOIN partners p ON t.operator_id = p.id
       -- Шлюз витрины один на все публичные чтения тура
       -- (lib/tours/public-visibility.ts). Без is_published карточка
       -- открывалась по прямой ссылке на снятый с витрины черновик.
       WHERE t.id = $1 AND ${publicTourSql('t')}`,
      [id]
    );

    // ── Фолбэк: маршрут из agent_route_knowledge ──────────────────────────────
    if (result.rows.length === 0) {
      const arkResult = await query<{
        id: string; title: string; description: string | null;
        category: string; lat: string | null; lng: string | null;
        source_url: string | null; source_name: string | null;
        payload: Record<string, unknown> | null;
        created_at: Date; updated_at: Date;
      }>(`SELECT id, title, description, category, lat, lng, source_url, source_name, payload, created_at, updated_at
         FROM agent_route_knowledge WHERE id = $1 AND is_visible = TRUE`, [id]);

      if (arkResult.rows.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Тур не найден' },
          { status: 404 }
        );
      }

      const ark = arkResult.rows[0];
      const payload = (typeof ark.payload === 'object' && ark.payload !== null)
        ? ark.payload as Record<string, unknown>
        : {};

      const price = typeof payload.price === 'number' ? payload.price
        : typeof payload.price_from === 'number' ? payload.price_from : 0;
      const duration = typeof payload.duration === 'number' ? payload.duration
        : typeof payload.duration_hours === 'number' ? payload.duration_hours : 0;
      const rawImages = Array.isArray(payload.images) ? payload.images as string[] : [];
      const images = rawImages.length > 0
        ? rawImages
        : (CATEGORY_IMAGES[ark.category] ? [CATEGORY_IMAGES[ark.category]] : []);

      const tour = {
        id: ark.id,
        name: ark.title,
        description: ark.description || '',
        shortDescription: (ark.description || '').slice(0, 200),
        category: ark.category,
        difficulty: (typeof payload.difficulty === 'string' ? payload.difficulty : 'medium') as 'easy' | 'medium' | 'hard',
        duration,
        price,
        currency: 'RUB',
        season: Array.isArray(payload.season) ? payload.season : [],
        coordinates: ark.lat && ark.lng
          ? [{ lat: parseFloat(ark.lat), lng: parseFloat(ark.lng) }]
          : [],
        requirements: [],
        included: Array.isArray(payload.included) ? payload.included as string[] : [],
        notIncluded: [],
        maxGroupSize: typeof payload.max_group === 'number' ? payload.max_group : 20,
        minGroupSize: 1,
        // «Не оценивали» — null, а не ноль (§4.0): ноль читается как оценка.
        rating: publicRating(payload.rating, payload.review_count),
        reviewCount: typeof payload.review_count === 'number' ? payload.review_count : 0,
        isActive: true,
        images,
        slug: '',
        locationName: '',
        createdAt: new Date(String(ark.created_at)),
        updatedAt: new Date(String(ark.updated_at)),
        routeId: null,
        route: null,
        operator: null,
        sourceUrl: ark.source_url,
        sourceName: ark.source_name,
      };

      return NextResponse.json({ success: true, data: tour });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const row = result.rows[0];

    const parseJsonField = (val: unknown): unknown[] => {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') {
        try { return JSON.parse(val); } catch { return []; }
      }
      return [];
    };

    // У operator_tours нет колонок images/price/category — есть photos
    // (text[]), tour_image и base_price. Прежнее чтение отдавало каждому туру
    // price = 0 и пустую галерею (избранное туриста показывало заглушку без цены).
    const photoList = parseJsonField(row.photos).filter((u): u is string => typeof u === 'string' && u.length > 0);
    const rawImages = photoList.length > 0
      ? photoList
      : typeof row.tour_image === 'string' && row.tour_image ? [row.tour_image] : parseJsonField(row.images) as string[];
    const images = rawImages.length > 0
      ? rawImages
      : (CATEGORY_IMAGES[row.category as string] ? [CATEGORY_IMAGES[row.category as string]] : []);

    const tour = {
      id:               row.id as string,
      name:             (row.title || row.name || '') as string,
      description:      (row.fullDescription || row.description || '') as string,
      shortDescription: (row.description || row.short_description || '') as string,
      category:         (row.category || 'adventure') as string,
      difficulty:       (row.difficulty || 'medium') as 'easy' | 'medium' | 'hard',
      duration:         parseInt(String(row.minDuration || row.duration || 0)),
      price:            parseFloat(String(row.base_price ?? row.pricePerDay ?? row.price ?? 0)),
      currency:         (row.currency || 'RUB') as string,
      season:           parseJsonField(row.season),
      coordinates:      parseJsonField(row.coordinates),
      requirements:     parseJsonField(row.requirements),
      included:         parseJsonField(row.included) as string[],
      notIncluded:      parseJsonField(row.notIncluded || row.not_included) as string[],
      maxGroupSize:     parseInt(String(row.maxGroupSize || row.max_group_size || 20)),
      minGroupSize:     parseInt(String(row.minGroupSize || row.min_group_size || 1)),
      // Оценки нет — null. `row.rating || 0` превращал «никто не оценивал» в
      // «нуль звёзд» (§4.0); каноническое чтение карточки держит
      // `rating: string | null` (lib/tours/tour-detail-query.ts). Правило одно
      // на все выдачи — lib/reviews/public-rating.
      rating:           publicRating(row.rating, row.review_count ?? row.reviewCount),
      reviewCount:      parseInt(String(row.review_count || row.reviewCount || 0)),
      isActive:         (row.is_active ?? true) as boolean,
      images,
      slug:             (row.slug || '') as string,
      locationName:     (row.locationName || row.location_name || '') as string,
      createdAt:        new Date(String(row.createdAt ?? row.created_at ?? Date.now())),
      updatedAt:        new Date(String(row.updatedAt ?? row.updated_at ?? Date.now())),

      // Маршрут из kamchatka_routes
      routeId: (row.route_id as string | null) ?? null,
      route: row.route_kr_id ? {
        id:        row.route_kr_id as string,
        title:     row.route_title as string,
        category:  row.route_category as string,
        lat:       row.route_lat != null ? parseFloat(row.route_lat as string) : null,
        lng:       row.route_lng != null ? parseFloat(row.route_lng as string) : null,
        sourceUrl: (row.route_source_url as string | null) ?? null,
      } : null,

      // Оператор из partners
      operator: row.partner_id_val ? {
        id:     row.partner_id_val as string,
        name:   (row.partner_name || '') as string,
        // То же и у оператора: «его никто не оценивал» — не «нуль».
        rating: publicRating(row.partner_rating, row.partner_review_count),
      } : null,
    };

    return NextResponse.json({ success: true, data: tour });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки тура', details: process.env.NODE_ENV === 'development' ? msg : undefined },
      { status: 500 }
    );
  }
}

