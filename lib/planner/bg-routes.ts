/**
 * Фоновые маршруты карты планировщика — загрузка с тремя исходами (§4.0).
 *
 * ── Что было (22.10) ────────────────────────────────────────────────────
 *
 * Запрос к /api/routes шёл без проверки `r.ok`, а `.catch(() => [])`
 * превращал отказ в пустой список. Упал каталог — карта молча пустая, и
 * это неотличимо от «маршрутов нет». А «нет» — частый и настоящий исход:
 * замер 22.10 по живому каталогу — у девяти плиток интересов из двенадцати
 * маршрутов с точкой на карте ноль.
 *
 * Вдобавок ответ читался вслепую (`data as RoutePoint[]`): каталог отдаёт
 * `activityType`/`locationType`, а экран ждал `activity_type`/
 * `location_type` и `zone`, которой в ответе не было вовсе. Поэтому зона
 * точки всегда угадывалась по расстоянию, чипы вида на карточке маршрута не
 * появлялись, а день из маршрута вертолётного тура становился пешим
 * треккингом. Ответ теперь разбирается явно.
 */
import { asPlannerZone } from '@/lib/planner/zone-style';
import type { ZoneId } from '@/lib/planner/constants';

/** Маршрут на карте планировщика — то, что экран читает из каталога. */
export interface PlannerRoute {
  id: string;
  title: string;
  description: string | null;
  lat: number;
  lng: number;
  activity_type: string | null;
  location_type: string | null;
  /** Зона из базы как записана (в том числе район вне четырёх зон); null — не записана. */
  zone: string | null;
  /** Та же зона, если это одна из четырёх зон планировщика. */
  plannerZone: ZoneId | null;
}

export type BgRoutesResult =
  | { state: 'ok'; routes: PlannerRoute[]; failedTypes: string[] }
  | { state: 'empty' }
  | { state: 'failed'; failedTypes: string[] };

/** Сколько маршрутов на один интерес — как было. */
export const BG_ROUTES_PER_TYPE = 30;

/** Интересы по умолчанию, пока человек ничего не выбрал. */
export const BG_DEFAULT_TYPES = ['trekking', 'volcano', 'fishing'] as const;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Запись каталога (`CatalogItem`, camelCase) → маршрут карты. Без id,
 * названия или координат — null: такую точку нарисовать нельзя.
 */
export function toPlannerRoute(item: unknown): PlannerRoute | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const id = str(o.id);
  const title = str(o.title);
  const lat = num(o.lat);
  const lng = num(o.lng);
  if (!id || !title || lat === null || lng === null) return null;
  const zone = str(o.zone);
  return {
    id,
    title,
    description: str(o.description),
    lat,
    lng,
    activity_type: str(o.activityType),
    location_type: str(o.locationType),
    zone,
    plannerZone: asPlannerZone(zone),
  };
}

type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

type TypeOutcome = { ok: true; routes: PlannerRoute[] } | { ok: false };

async function loadType(type: string, fetchImpl: FetchLike): Promise<TypeOutcome> {
  const fail = (reason: string, status?: number): TypeOutcome => {
    // Имя проверки, интерес и код — без данных человека.
    console.error('[planner-map] фоновые маршруты не загрузились', { check: 'planner_bg_routes', type, reason, status });
    return { ok: false };
  };
  try {
    const r = await fetchImpl(
      `/api/routes?activity_type=${encodeURIComponent(type)}&hasCoords=true&limit=${BG_ROUTES_PER_TYPE}`,
    );
    if (!r.ok) return fail('http', r.status);
    const body: unknown = await r.json();
    const data = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    if (!data || data.success !== true || !Array.isArray(data.data)) return fail('shape', r.status);
    const routes = data.data.map(toPlannerRoute).filter((x): x is PlannerRoute => x !== null);
    // Записи пришли, а разобрать нельзя ни одну — сменилась форма ответа.
    // Это отказ, а не «маршрутов нет».
    if (data.data.length > 0 && routes.length === 0) return fail('shape', r.status);
    return { ok: true, routes };
  } catch (err) {
    return fail(err instanceof Error ? err.name : 'network');
  }
}

/**
 * Маршруты по интересам. Исходы:
 *   ok     — есть что рисовать (`failedTypes` — интересы, по которым не вышло);
 *   empty  — все запросы ответили, и маршрутов с точкой нет;
 *   failed — рисовать нечего, и хотя бы один запрос не ответил: сказать
 *            «маршрутов нет» мы в этом случае не можем.
 */
export async function loadBackgroundRoutes(
  types: readonly string[],
  fetchImpl: FetchLike = (url) => fetch(url),
): Promise<BgRoutesResult> {
  const unique = [...new Set(types)];
  const outcomes = await Promise.all(unique.map(t => loadType(t, fetchImpl)));
  const failedTypes = unique.filter((_, i) => !outcomes[i].ok);
  const seen = new Set<string>();
  const routes: PlannerRoute[] = [];
  for (const o of outcomes) {
    if (!o.ok) continue;
    for (const route of o.routes) {
      if (!seen.has(route.id)) { seen.add(route.id); routes.push(route); }
    }
  }
  if (routes.length > 0) return { state: 'ok', routes, failedTypes };
  if (failedTypes.length > 0 || unique.length === 0) return { state: 'failed', failedTypes };
  return { state: 'empty' };
}
