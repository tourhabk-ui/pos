/**
 * GET /api/routes/by-region
 * Маршруты из agent_route_knowledge для bbox — используется при скачивании офлайн-региона.
 *
 * Query params (два варианта):
 *   1. bbox={"south":52.8,"west":158.4,"north":53.6,"east":159.4}
 *   2. south=52.8&west=158.4&north=53.6&east=159.4
 *
 * Optional:
 *   limit=500  (max 2000, default 500)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

const BboxSchema = z.object({
  south: z.coerce.number().min(-90).max(90),
  west:  z.coerce.number().min(-180).max(180),
  north: z.coerce.number().min(-90).max(90),
  east:  z.coerce.number().min(-180).max(180),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

export async function GET(request: NextRequest) {
  const sp = new URL(request.url).searchParams;

  // Поддерживаем оба формата: ?bbox=JSON и ?south=...&west=...&north=...&east=...
  let rawParams: Record<string, string>;
  const bboxRaw = sp.get('bbox');
  if (bboxRaw) {
    try {
      const parsed = JSON.parse(bboxRaw);
      rawParams = {
        south: String(parsed.south),
        west:  String(parsed.west),
        north: String(parsed.north),
        east:  String(parsed.east),
        limit: sp.get('limit') ?? '500',
      };
    } catch {
      return NextResponse.json(
        { success: false, error: 'Неверный формат bbox JSON' },
        { status: 400 }
      );
    }
  } else {
    rawParams = {
      south: sp.get('south') ?? '',
      west:  sp.get('west')  ?? '',
      north: sp.get('north') ?? '',
      east:  sp.get('east')  ?? '',
      limit: sp.get('limit') ?? '500',
    };
  }

  const parsed = BboxSchema.safeParse(rawParams);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: 'Неверные параметры. Нужны south, west, north, east (числа в градусах).',
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  const { south, west, north, east, limit } = parsed.data;

  // Валидация bbox
  if (south >= north) {
    return NextResponse.json(
      { success: false, error: 'south должен быть меньше north' },
      { status: 400 }
    );
  }
  if (west >= east) {
    return NextResponse.json(
      { success: false, error: 'west должен быть меньше east' },
      { status: 400 }
    );
  }

  try {
    const result = await query(
      // Все колонки ark.* квалифицированы: после LEFT JOIN неквалифицированные
      // id/updated_at есть в обеих таблицах → «column reference is ambiguous»
      // и 500 на скачивании пакета (тот же класс, что чинил аудит Stay 27.07).
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
         ark.payload->>'difficulty'      AS difficulty,
         ark.payload->>'duration_days'   AS duration_days_raw,
         ark.payload->'best_months'      AS best_months,
         ark.payload->'geometry'         AS geometry,
         -- Ограничения в офлайн-пакет (#836): перекрытая дорога, пропускной
         -- режим, пожар. Без них скачавший регион турист в поле не знал,
         -- что подъезд закрыт. LEFT JOIN — место без реалтайм-строки просто
         -- едет с пустым списком, а не выпадает из пакета.
         lrs.active_alerts               AS active_alerts,
         lrs.alert_severity              AS alert_severity,
         lrs.updated_at                  AS alerts_at
       FROM agent_route_knowledge ark
       LEFT JOIN location_real_time_status lrs ON lrs.agent_route_id = ark.id
       WHERE
         ark.is_visible = TRUE
         AND ark.lat IS NOT NULL
         AND ark.lng IS NOT NULL
         AND ark.lat BETWEEN $1 AND $2
         AND ark.lng BETWEEN $3 AND $4
       ORDER BY ark.title ASC
       LIMIT $5`,
      [south, north, west, east, limit]
    );

    const routes = result.rows.map((r) => ({
      id:           r.id as string,
      title:        r.title as string,
      description:  (r.description as string | null) ?? '',
      lat:          parseFloat(r.lat as string),
      lng:          parseFloat(r.lng as string),
      kind:         (r.kind as string) ?? 'place',
      category:     (r.category as string | null) ?? null,
      locationType: (r.location_type as string | null) ?? null,
      activityType: (r.activity_type as string | null) ?? null,
      sourceUrl:    (r.source_url as string | null) ?? null,
      sourceName:   (r.source_name as string | null) ?? null,
      priceFrom:    null,
      difficulty:   (r.difficulty as string | null) ?? null,
      durationDays: r.duration_days_raw != null ? Number(r.duration_days_raw) : null,
      bestMonths:   (r.best_months as number[] | null) ?? null,
      geometry:     (r.geometry as { type: string; coordinates: [number, number][] } | null) ?? null,
      activeAlerts:  (r.active_alerts as string[] | null) ?? [],
      alertSeverity: r.alert_severity != null ? Number(r.alert_severity) : 0,
      alertsAt:      r.alerts_at ? new Date(r.alerts_at as string).getTime() : null,
    }));

    return NextResponse.json({
      success: true,
      routes,
      meta: {
        count: routes.length,
        bbox: { south, west, north, east },
        limit,
      },
    });
  } catch (err) {
    console.error('[by-region] DB error:', err);
    return NextResponse.json(
      { success: false, error: 'Ошибка базы данных', routes: [] },
      { status: 500 }
    );
  }
}
