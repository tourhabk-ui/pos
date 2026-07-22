/**
 * Резолвер подборок: превращает подборку в её РЕАЛЬНЫХ членов.
 *
 * Две модели членства:
 *  1. Правило-фильтр (rule_kind + location_type/activity_type/difficulty/query) —
 *     резолвится вживую через queryCatalog (тот же источник, что видит турист на
 *     /routes: agent_route_knowledge, is_visible). Честно, не устаревает, не пусто
 *     пока есть данные.
 *  2. Ручные массивы place_ids/route_ids — запасной вариант, если правила нет.
 *
 * Формы Place/RouteDetail совпадают с теми, что рендерит существующий клиент
 * подборки, — меняем ТОЛЬКО источник данных, не ломая рендер.
 */

import { pool } from '@/lib/db-pool';
import { queryCatalog, type CatalogFilters, type CatalogItem } from '@/lib/routes/catalog-query';

export interface CollectionRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  cover_image: string | null;
  tags: string[];
  view_count: number;
  place_ids: string[] | null;
  route_ids: string[] | null;
  rule_kind: 'place' | 'route' | null;
  rule_location_type: string | null;
  rule_activity_type: string | null;
  rule_difficulty: string | null;
  rule_query: string | null;
  rule_limit: number | null;
  accent: string | null;
}

export interface CollectionPlace {
  id: string;
  name: string;
  location_type: string;
  lat: number | null;
  lng: number | null;
  description: string;
  image_url: string | null;
}

export interface CollectionRouteItem {
  id: string;
  title: string;
  difficulty: string | null;
  distance_km: number | null;
  duration_hours: number | null;
  activity_type: string | null;
  description: string | null;
}

const CATALOG_DIFFICULTY = new Set(['easy', 'medium', 'hard']);

/**
 * Правило подборки → фильтры каталога. null, если подборка без правила (ручная).
 * Чистая функция — под тестом (инвариант: kind обязателен, difficulty только из
 * допустимого набора каталога).
 */
export function collectionRuleToFilters(row: Pick<CollectionRow,
  'rule_kind' | 'rule_location_type' | 'rule_activity_type' | 'rule_difficulty' | 'rule_query' | 'rule_limit'>,
): CatalogFilters | null {
  if (row.rule_kind !== 'place' && row.rule_kind !== 'route') return null;

  const limit = Math.min(Math.max(row.rule_limit ?? 60, 1), 200);
  const filters: CatalogFilters = { kind: row.rule_kind, page: 1, limit, sort: 'title' };

  if (row.rule_location_type) filters.location_type = row.rule_location_type;
  if (row.rule_activity_type) filters.activity_type = row.rule_activity_type;
  if (row.rule_query) filters.q = row.rule_query;
  if (row.rule_difficulty && CATALOG_DIFFICULTY.has(row.rule_difficulty)) {
    filters.difficulty = row.rule_difficulty as 'easy' | 'medium' | 'hard';
  }
  return filters;
}

function itemToPlace(it: CatalogItem): CollectionPlace {
  return {
    id: it.id,
    name: it.title,
    location_type: it.locationType ?? 'other',
    lat: it.lat,
    lng: it.lng,
    description: it.description,
    image_url: it.hasRealImage ? (it.imageUrl ?? null) : null,
  };
}

function itemToRoute(it: CatalogItem): CollectionRouteItem {
  return {
    id: it.id,
    title: it.title,
    difficulty: it.difficulty,
    distance_km: null,
    duration_hours: it.durationDays != null ? it.durationDays * 24 : null,
    activity_type: it.activityType,
    description: it.description,
  };
}

async function manualPlaces(ids: string[]): Promise<CollectionPlace[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<CollectionPlace>(
    `SELECT p.id, p.name, p.location_type, p.lat, p.lng, p.description,
            (SELECT CASE WHEN ai.model IN ('wikimedia', 'manual-upload') THEN '/api/images/route/' || p.ark_id END
             FROM ai_route_images ai WHERE ai.route_id = p.ark_id LIMIT 1) AS image_url
       FROM places p WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

async function manualRoutes(ids: string[]): Promise<CollectionRouteItem[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<CollectionRouteItem>(
    `SELECT id, title, difficulty, distance_km, duration_hours, activity_type, description
       FROM v_kamchatka_routes_api WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

/**
 * Реальные члены подборки: {places, routes}. Правило → queryCatalog, иначе —
 * ручные массивы. Не падает при сбое каталога: возвращает пустые списки.
 */
export async function resolveCollectionContent(
  row: CollectionRow,
): Promise<{ places: CollectionPlace[]; routes: CollectionRouteItem[] }> {
  const filters = collectionRuleToFilters(row);

  if (filters) {
    try {
      const { items } = await queryCatalog(filters);
      if (filters.kind === 'place') return { places: items.map(itemToPlace), routes: [] };
      return { places: [], routes: items.map(itemToRoute) };
    } catch {
      return { places: [], routes: [] };
    }
  }

  const [places, routes] = await Promise.all([
    manualPlaces(row.place_ids ?? []),
    manualRoutes(row.route_ids ?? []),
  ]);
  return { places, routes };
}

/** Честный размер подборки для карточки в списке (правило → COUNT каталога). */
export async function resolveCollectionCount(row: CollectionRow): Promise<number> {
  const filters = collectionRuleToFilters(row);
  if (filters) {
    try {
      const { meta } = await queryCatalog({ ...filters, limit: 1 });
      return meta.total;
    } catch {
      return 0;
    }
  }
  return (row.place_ids?.length ?? 0) + (row.route_ids?.length ?? 0);
}
