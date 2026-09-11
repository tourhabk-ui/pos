/**
 * GET /api/cron/places-gvp-crosscheck — сверка вулканов `places` с Global
 * Volcanism Program (Смитсоновский институт).
 *
 * Независимый от OSM источник, специально для вулканов — самой
 * безопасность-критичной категории мест: научная база, не краудсорс, 1214
 * голоценовых вулканов мира (замер 11.09).
 *
 * Имена НЕ сравниваются (в отличие от places-osm-crosscheck): `places.name`
 * по-русски, `VolcanoName` ГВП — английская транслитерация, и
 * `pg_trgm.similarity()` между алфавитами практически всегда ноль.
 * Кандидаты — ближайшие по расстоянию вулканы ГВП, без фильтра по имени
 * (разбор — в `lib/geo/gvp-crosscheck.ts`).
 *
 * Только чтение: ни один аргумент не приводит к записи в БД. Правку делает
 * человек — `POST /api/cron/place-coords` (нужен независимый источник) или
 * отдельная миграция-скрытие (без источника).
 *
 * part=summary|items|both (default both), offset/limit — пагинация items.
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runGvpCrosscheck } from '@/lib/geo/gvp-crosscheck-runner';
import { KAMCHATKA_BOUNDS } from '@/lib/services/routes/geocode';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ITEMS_PAGE_DEFAULT = 30;
const ITEMS_PAGE_MAX = 100;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const partParam = request.nextUrl.searchParams.get('part') ?? 'both';
  const part = ['both', 'summary', 'items'].includes(partParam) ? partParam : 'both';

  const offsetRaw = Number(request.nextUrl.searchParams.get('offset') ?? '0');
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? String(ITEMS_PAGE_DEFAULT));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1
    ? Math.min(ITEMS_PAGE_MAX, Math.floor(limitRaw))
    : ITEMS_PAGE_DEFAULT;

  try {
    const result = await runGvpCrosscheck(KAMCHATKA_BOUNDS);

    return NextResponse.json({
      success: true,
      probe: 'places_gvp_crosscheck_v1',
      part,
      bbox: KAMCHATKA_BOUNDS,
      checked_places_total: result.checkedPlacesTotal,
      gvp_volcanoes_total: result.gvpVolcanoesTotal,
      items_total: result.items.length,
      items_without_candidates_total: result.itemsWithoutCandidatesTotal,
      items_offset: offset,
      items_limit: limit,
      items: part === 'summary' ? undefined : result.items.slice(offset, offset + limit),
      items_dropped: part === 'summary'
        ? undefined
        : Math.max(0, result.items.length - (offset + limit)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка сверки с GVP';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
