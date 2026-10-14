/**
 * GET /api/cron/route-slug-census — видимые маршруты без адреса по имени и кто
 * держит их адрес. ТОЛЬКО ЧТЕНИЕ.
 *
 * Повод. Перепись sitemap 14.10 (прогон 7): 133 маршрута из 370 открываются по
 * UUID. Правило записи (миграция 1237) выдаёт адрес тем, у кого он свободен,
 * — а остальных 1136 оставила по UUID намеренно: тёзки, имя места (маршрут к
 * месту — `<имя>-marshrut`, решение владельца 29.09), адрес у скрытого или
 * слитого дубля. Двигать адреса по догадке нельзя: у старого адреса есть
 * ссылки в выдаче. Поэтому перепись называет держателя каждого адреса, как
 * `place-slug-census` перед 1112, и тем же `translit_ru_slug`.
 *
 * Запрос и классификация — lib/routes/slug-census (их же исполняет сторож на
 * настоящем PostgreSQL). Наружу — названия маршрутов и мест, адреса и флаги;
 * персональных данных в этих таблицах нет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import {
  ROUTE_RESERVED_SLUGS,
  ROUTE_SLUG_CENSUS_SQL,
  ROUTE_SLUG_SHADOWED_SQL,
  routeSlugHolder,
  type RouteSlugCensusRow,
} from '@/lib/routes/slug-census';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const reserved = [...ROUTE_RESERVED_SLUGS];
    const { rows } = await pool.query<RouteSlugCensusRow>(ROUTE_SLUG_CENSUS_SQL, [reserved]);
    const shadowed = await pool.query<{ id: string; title: string; slug: string }>(ROUTE_SLUG_SHADOWED_SQL, [reserved]);

    const items = rows.map((r) => ({
      id: r.id,
      title: r.title,
      base: r.base,
      holder: routeSlugHolder(r),
      empty_slug: r.empty_slug,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      activity_type: r.activity_type,
      geometry_source: r.geometry_source,
      place_holder: r.place_holder_id
        ? {
            id: r.place_holder_id,
            name: r.place_holder_name,
            visible: r.place_holder_visible,
            merged_into: r.place_holder_merged_into,
          }
        : null,
      route_holder: r.route_holder_id
        ? {
            id: r.route_holder_id,
            title: r.route_holder_title,
            visible: r.route_holder_visible,
            merged_into: r.route_holder_merged_into,
          }
        : null,
      claimants: r.claimants,
      marshrut_free: r.marshrut_free,
      would_assign: r.would_assign,
    }));

    const byHolder: Record<string, number> = {};
    for (const i of items) byHolder[i.holder] = (byHolder[i.holder] ?? 0) + 1;

    return NextResponse.json({
      ok: true,
      collected_at: new Date().toISOString(),
      missing_total: items.length,
      by_holder: byHolder,
      // Правило записи выдало бы адрес сейчас — значит маршрут стал видимым
      // мимо триггера 1237. Ноль — производитель на месте.
      would_assign_total: items.filter((i) => i.would_assign !== null).length,
      shadowed_by_section: shadowed.rows,
      items,
    });
  } catch (err) {
    // Третий исход: не смог посчитать — это не «все адреса на месте».
    const e = err as { code?: string; message?: string };
    console.error('[route-slug-census] перепись не выполнена:', { sqlstate: e?.code, message: e?.message });
    return NextResponse.json({ ok: false, reason: e?.message ?? 'база не ответила' }, { status: 500 });
  }
}
