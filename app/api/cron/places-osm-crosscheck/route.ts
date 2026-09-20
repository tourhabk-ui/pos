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
 * kind=<location_type> (17.09) — сузить список до одного типа места. Повод:
 * владелец попросил проверить озёра; без фильтра пришлось бы листать все
 * места по странице, и озёра с малым расхождением утонули бы среди чужих
 * типов. Фильтр применяется ПОСЛЕ сортировки по расстоянию — порядок улик
 * внутри типа тот же, что и в общем списке. Счётчик items_kind_total
 * отдельный: «озёр с кандидатами N» и «всего мест с кандидатами M» — разные
 * числа, и подменять второе первым нельзя.
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
/**
 * Потолок страницы поднят со 100 до 400 (20.09), и причина не в удобстве
 * чтения.
 *
 * Каждый запрос к этому роуту заново тянет ОДИН И ТОТ ЖЕ bulk-запрос к
 * Overpass по bbox всего края — 8379 именованных объектов (замер 10.09).
 * При сотне мест на страницу прочитать перепись из 378 живых мест значило
 * четыре прогона, то есть четыре одинаковых тяжёлых запроса к бесплатной
 * общественной службе ради одного ответа. Постраничность защищала не
 * Overpass, а читателя — а читателю от неё стало хуже.
 *
 * Ответ в лог при этом влезает: workflow печатает по ОДНОЙ компактной
 * строке на место (~200 байт), то есть около 75 КБ на все 378 при потолке
 * лога в 256 КБ. Если однажды не влезет, это будет видно: `items_dropped`
 * говорит, сколько осталось за краем, и молчанием это не прикрыто.
 */
const ITEMS_PAGE_MAX = 400;

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

  // Тип места — как в places.location_type (lake, volcano, hot_spring, ...).
  // Пустая строка — без фильтра. Неизвестный тип не ошибка: список выйдет
  // пустым, и это видно по items_kind_total: 0.
  const kindRaw = (request.nextUrl.searchParams.get('kind') ?? '').trim();
  const kind = /^[a-z_]{1,40}$/.test(kindRaw) ? kindRaw : '';

  const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? String(ITEMS_PAGE_DEFAULT));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1
    ? Math.min(ITEMS_PAGE_MAX, Math.floor(limitRaw))
    : ITEMS_PAGE_DEFAULT;

  try {
    const result = await runOsmCrosscheck({ minSim });
    const items = kind ? result.items.filter((it) => it.locationType === kind) : result.items;

    return NextResponse.json({
      success: true,
      probe: 'places_osm_crosscheck_v3',
      part,
      kind: kind || null,
      items_kind_total: kind ? items.length : null,
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
      items: part === 'summary' ? undefined : items.slice(offset, offset + limit),
      items_dropped: part === 'summary'
        ? undefined
        : Math.max(0, items.length - (offset + limit)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка сверки с OSM';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
