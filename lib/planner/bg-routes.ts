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
 *
 * ── Плитки мест ищут по месту пути (22.10, пятый круг) ──────────────────
 *
 * Шесть плиток мест анкеты (вулканы, термальные, гейзеры, побережье, хребты,
 * реки) искали маршрут по `activity_type` и не находили ничего: вид места у
 * маршрута не записан, а `activity_type` есть только у 38 маршрутов из 301
 * с координатами (замер 22.10 по /api/routes: треккинг 28, зимний поход 5,
 * вертолёт 3, лыжи 1, снегоход 1; у 263 — нет). Теперь плитка места ищет
 * маршрут, чья точка ПУТИ — место этого вида (`place_type`, правило в
 * lib/routes/catalog-query: связь `waypoint`/`unknown`, не «рядом»).
 * Плитки занятий ищут, как прежде, по `activity_type`.
 *
 * Виды мест — фактические значения `places.location_type` на проде
 * (/api/routes?kind=place, 22.10; в скобках — сколько мест вида стоит на
 * живом маршруте точкой пути, `onRoute`): вулкан 116 (38), термальный
 * источник 58 (38), гейзер 2 (2), бухта 8 (4), мыс 10 (3), пляж 2 (1),
 * гора 15 (14), перевал 5 (1), река 7 (2). «Термальная зона» (`thermal`)
 * есть в словаре мест (lib/places/location-types), живых мест этого вида
 * сейчас нет — взята, потому что это тот же интерес. Остров к побережью не
 * отнесён: остров — не берег.
 *
 * ── Что ещё спрашивается (22.10, шестой круг) ───────────────────────────
 *
 *   • `kind=route`: сервер, ещё не знающий `place_type`, отбрасывает его как
 *     неизвестный (Zod) — без рода он отдал бы места вперемешку с
 *     маршрутами, и место встало бы на карту «маршрутом». С родом приходят
 *     только маршруты, а игнор фильтра виден числом: «показаны 30 из 301» —
 *     все маршруты с координатами, а не маршруты через вулкан;
 *   • `sort=navigable` — порядок для выбора в поле (род линии, потом
 *     полнота карточки, CatalogQuerySchema): на карту идут первые 30, и это
 *     должны быть те, по которым можно идти, а не первые по алфавиту;
 *   • `brief=1` — описание первой строкой: карточка точки показывает 140
 *     знаков, целые тексты карте не нужны;
 *   • `meta.total` читается: показано 30 из 52 — карта говорит это словами
 *     (`truncated`), а не выдаёт тридцать за все.
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

/**
 * `emptyTypes` — виды, по которым каталог ответил, и маршрутов с точкой нет
 * (у `empty` — все спрошенные). Это не отказ: отказ — `failedTypes`.
 */
export type BgRoutesResult =
  | { state: 'ok'; routes: PlannerRoute[]; failedTypes: string[]; emptyTypes: string[]; truncated: TruncatedType[] }
  | { state: 'empty'; emptyTypes: string[] }
  | { state: 'failed'; failedTypes: string[] };

/**
 * Интерес, по которому каталог знает больше маршрутов, чем пришло
 * (`meta.total` > показанных). Каталог не назвал total — интереса здесь
 * нет: «показаны все» тоже не утверждается, это просто не известно.
 */
export interface TruncatedType { type: string; shown: number; total: number }

/** Сколько маршрутов на один интерес — как было. */
export const BG_ROUTES_PER_TYPE = 30;

/**
 * Плитка места → виды мест пути (`places.location_type`). Плитки, которых
 * здесь нет, — занятия: ищутся по `activity_type` маршрута.
 */
export const PLACE_TILE_LOCATION_TYPES: Readonly<Record<string, readonly string[]>> = {
  volcano:    ['volcano'],
  hot_spring: ['hot_spring', 'thermal'],
  geyser:     ['geyser'],
  sea:        ['bay', 'cape', 'beach'],
  mountain:   ['mountain', 'pass'],
  river:      ['river'],
};

/**
 * Интересы по умолчанию, пока человек ничего не выбрал: только те, что дают
 * точки. Замер 22.10 на проде: треккинг — 28 маршрутов с координатами
 * (`/api/routes?activity_type=trekking`); через вулкан точкой пути — не
 * меньше 50 маршрутов с координатами (38 вулканов на живых маршрутах, их
 * маршруты не «рядом» — по карточкам мест /api/places/[id], а карточка
 * показывает до десяти маршрутов, поэтому «не меньше»; точное число скажет
 * сам каталог после выката: `/api/routes?place_type=volcano&hasCoords=true`).
 * Тем же замером у остальных плиток мест: термальные — не меньше 51,
 * хребты — 22, побережье — 11, гейзеры — 5, реки — 2.
 *
 * «Рыбалка» стояла здесь до 22.10 и не давала ни одной точки
 * (`activity_type=fishing` — ноль маршрутов) — она снята, а не заменена
 * догадкой.
 */
export const BG_DEFAULT_TYPES = ['trekking', 'volcano'] as const;

/**
 * Адрес каталога для плитки: место — по месту пути, занятие — по виду
 * маршрута. Только маршруты, с координатами, в порядке для поля, описание
 * первой строкой (см. шапку, шестой круг).
 */
export function bgRoutesUrl(tile: string): string {
  const placeTypes = PLACE_TILE_LOCATION_TYPES[tile];
  const sp = new URLSearchParams(placeTypes ? { place_type: placeTypes.join(',') } : { activity_type: tile });
  sp.set('kind', 'route');
  sp.set('hasCoords', 'true');
  sp.set('sort', 'navigable');
  sp.set('brief', '1');
  sp.set('limit', String(BG_ROUTES_PER_TYPE));
  return `/api/routes?${sp.toString()}`;
}

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

type TypeOutcome = { ok: true; routes: PlannerRoute[]; total: number | null } | { ok: false };

async function loadType(type: string, fetchImpl: FetchLike): Promise<TypeOutcome> {
  const fail = (reason: string, status?: number): TypeOutcome => {
    // Имя проверки, интерес и код — без данных человека.
    console.error('[planner-map] фоновые маршруты не загрузились', { check: 'planner_bg_routes', type, reason, status });
    return { ok: false };
  };
  try {
    const r = await fetchImpl(bgRoutesUrl(type));
    if (!r.ok) return fail('http', r.status);
    const body: unknown = await r.json();
    const data = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    if (!data || data.success !== true || !Array.isArray(data.data)) return fail('shape', r.status);
    const routes = data.data.map(toPlannerRoute).filter((x): x is PlannerRoute => x !== null);
    // Записи пришли, а разобрать нельзя ни одну — сменилась форма ответа.
    // Это отказ, а не «маршрутов нет».
    if (data.data.length > 0 && routes.length === 0) return fail('shape', r.status);
    const meta = data.meta && typeof data.meta === 'object' ? (data.meta as Record<string, unknown>) : null;
    const total = meta ? num(meta.total) : null;
    return { ok: true, routes, total };
  } catch (err) {
    return fail(err instanceof Error ? err.name : 'network');
  }
}

/**
 * Маршруты по интересам. Исходы:
 *   ok     — есть что рисовать (`failedTypes` — интересы, по которым не вышло,
 *            `emptyTypes` — по которым маршрутов нет, `truncated` — по
 *            которым каталог знает больше, чем пришло);
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
  const emptyTypes = unique.filter((_, i) => {
    const o = outcomes[i];
    return o.ok && o.routes.length === 0;
  });
  const seen = new Set<string>();
  const routes: PlannerRoute[] = [];
  for (const o of outcomes) {
    if (!o.ok) continue;
    for (const route of o.routes) {
      if (!seen.has(route.id)) { seen.add(route.id); routes.push(route); }
    }
  }
  const truncated: TruncatedType[] = [];
  unique.forEach((type, i) => {
    const o = outcomes[i];
    if (o.ok && o.total !== null && o.total > o.routes.length) {
      truncated.push({ type, shown: o.routes.length, total: o.total });
    }
  });
  if (routes.length > 0) return { state: 'ok', routes, failedTypes, emptyTypes, truncated };
  if (failedTypes.length > 0 || unique.length === 0) return { state: 'failed', failedTypes };
  return { state: 'empty', emptyTypes };
}
