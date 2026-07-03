import { pool } from '@/lib/db-pool';
import { expandQuery } from '@/lib/ai/query-expansion';

// ── In-memory TTL cache for route search results ─────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry { data: unknown; at: number }
const routeSearchCache = new Map<string, CacheEntry>();

export function normalizeRouteQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function getRouteSearchCache(q: string): unknown | null {
  const key = normalizeRouteQuery(q);
  const entry = routeSearchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    routeSearchCache.delete(key);
    return null;
  }
  return entry.data;
}

export function setRouteSearchCache(q: string, data: unknown): void {
  routeSearchCache.set(normalizeRouteQuery(q), { data, at: Date.now() });
}

// ─────────────────────────────────────────────────────────────────────────────

interface RouteRow {
  title: string;
  description: string | null;
  activity_type: string | null;
}

function normalizeQuery(query: string): string {
  return query
    .replace(/[^\wа-яёА-ЯЁ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

async function searchRoutesOnce(q: string): Promise<RouteRow[]> {
  const { rows } = await pool.query<RouteRow>(
    `SELECT title, description, activity_type
     FROM kamchatka_routes
     WHERE (title ILIKE $1 OR description ILIKE $1)
       AND is_visible = TRUE
     ORDER BY search_count DESC NULLS LAST
     LIMIT 3`,
    [`%${q}%`],
  );
  return rows;
}

// Issue #250: замер эффекта multi-query расширения — сколько вариантов
// сгенерировано и сколько маршрутов добавили ИМЕННО расширенные варианты
// (не базовый запрос) — данные для решения оставлять/откатывать
// RAG_MULTIQUERY. Fire-and-forget, не блокирует и не роняет поиск.
function logQueryExpansion(origQuery: string, expandedCount: number, uniqueAdded: number): void {
  pool.query(
    `INSERT INTO query_expansion_log (orig_query, expanded_count, unique_added) VALUES ($1, $2, $3)`,
    [origQuery, expandedCount, uniqueAdded],
  ).catch(() => { /* логирование не критично для самого поиска */ });
}

export async function searchRoutes(query: string): Promise<string> {
  if (!query || query.length < 3) return '';
  const base = normalizeQuery(query);
  if (!base) return '';

  try {
    // Multi-query (§16.5): по умолчанию variants=[base] → поведение прежнее.
    // С RAG_MULTIQUERY=1 добавляются перефразы; результаты объединяем с дедупом
    // по title (порядок первого появления — приоритет более ранних вариантов).
    const variants = (await expandQuery(base)).map(normalizeQuery).filter(Boolean);
    const seen = new Set<string>();
    const merged: RouteRow[] = [];
    let uniqueAddedByExpansion = 0;
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i]!;
      for (const r of await searchRoutesOnce(v)) {
        const key = r.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
        if (i > 0) uniqueAddedByExpansion++; // попал в выдачу только благодаря перефразу, не оригиналу
        if (merged.length >= 3) break;
      }
      if (merged.length >= 3) break;
    }

    if (variants.length > 1) {
      logQueryExpansion(base, variants.length - 1, uniqueAddedByExpansion);
    }

    if (merged.length === 0) return '';
    const lines = merged.map(r =>
      `Маршрут: ${r.title}${r.activity_type ? ` (${r.activity_type})` : ''}\n${(r.description ?? '').slice(0, 500)}`
    );
    return `=== Маршруты по запросу ===\n${lines.join('\n\n')}`.slice(0, 2000);
  } catch {
    return '';
  }
}
