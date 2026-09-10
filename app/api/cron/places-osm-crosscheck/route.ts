/**
 * GET /api/cron/places-osm-crosscheck — сверка places с OpenStreetMap.
 *
 * Повод (10.09): четыре плохие координаты нашлись только по жалобам туриста
 * с телефона (Голубые озёра — 17 км от места; Овальное и Смотровая у
 * Авачинского — ~19-25 км; Лежбище сивучей — 506 км до одноимённого мыса в
 * OSM). ~380 живых мест никогда не проверялись массово против внешнего
 * источника.
 *
 * Только чтение: ни один аргумент не приводит к записи в БД. Список
 * кандидатов сортируется по убыванию расстояния до самого дальнего
 * совпадения имени — БЕЗ порогового отсечения (§4.0, `lib/routes/place-link.ts`:
 * жёсткое правило «имя+расстояние» без разбора глазами уже портило записи).
 * Правку делает человек: `POST /api/cron/place-coords` (нужен независимый
 * источник) или отдельная миграция-скрытие (без источника — как 947/948).
 *
 * part=summary|items|both (default both), offset — пагинация списка items,
 * min_sim — порог pg_trgm.similarity() (default 0.30, мягче дедупа мест,
 * потому что здесь важна полнота, а не точность).
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { runOsmCrosscheck } from '@/lib/geo/osm-crosscheck-runner';
import { STRONG_SIM } from '@/lib/geo/osm-crosscheck';
import { KAMCHATKA_BOUNDS } from '@/lib/services/routes/geocode';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

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

  const minSimRaw = Number(request.nextUrl.searchParams.get('min_sim') ?? '0.3');
  const minSim = Number.isFinite(minSimRaw) && minSimRaw >= 0 && minSimRaw <= 1 ? minSimRaw : 0.3;

  const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? String(ITEMS_PAGE_DEFAULT));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1
    ? Math.min(ITEMS_PAGE_MAX, Math.floor(limitRaw))
    : ITEMS_PAGE_DEFAULT;

  try {
    const result = await runOsmCrosscheck({ minSim });

    return NextResponse.json({
      success: true,
      probe: 'places_osm_crosscheck_v2',
      part,
      bbox: KAMCHATKA_BOUNDS,
      name_sim_floor: minSim,
      strong_sim: STRONG_SIM,
      checked_places_total: result.checkedPlacesTotal,
      osm_features_total: result.osmFeaturesTotal,
      items_with_candidates_total: result.items.length,
      items_strong_total: result.itemsStrongTotal,
      items_weak_only_total: result.itemsWeakOnlyTotal,
      items_without_candidates_total: result.itemsWithoutCandidatesTotal,
      items_offset: offset,
      items_limit: limit,
      items: part === 'summary' ? undefined : result.items.slice(offset, offset + limit),
      items_dropped: part === 'summary'
        ? undefined
        : Math.max(0, result.items.length - (offset + limit)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка сверки с OSM';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
