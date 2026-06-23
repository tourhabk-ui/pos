import { pool } from '@/lib/db-pool';

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

export async function searchRoutes(query: string): Promise<string> {
  if (!query || query.length < 3) return '';
  const q = query
    .replace(/[^\wа-яёА-ЯЁ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  if (!q) return '';

  try {
    const { rows } = await pool.query<RouteRow>(
      `SELECT title, description, activity_type
       FROM kamchatka_routes
       WHERE (title ILIKE $1 OR description ILIKE $1)
         AND is_visible = TRUE
       ORDER BY search_count DESC NULLS LAST
       LIMIT 3`,
      [`%${q}%`],
    );
    if (rows.length === 0) return '';
    const lines = rows.map(r =>
      `Маршрут: ${r.title}${r.activity_type ? ` (${r.activity_type})` : ''}\n${(r.description ?? '').slice(0, 500)}`
    );
    return `=== Маршруты по запросу ===\n${lines.join('\n\n')}`.slice(0, 2000);
  } catch {
    return '';
  }
}
