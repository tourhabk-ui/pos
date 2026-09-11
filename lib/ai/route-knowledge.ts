import { pool } from '@/lib/db-pool';
import { expandQuery } from '@/lib/ai/query-expansion';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

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

/**
 * Строка маршрута для промпта.
 *
 * До 11.09 колонок было три — заголовок, описание, вид активности, — и именно
 * поэтому Кузьмич отвечал про регистрацию в МЧС, набор высоты и снаряжение ПО
 * ПАМЯТИ МОДЕЛИ: этих данных в контексте не было (#1818). Регистрация
 * обязательна на 154 маршрутах, и цена ошибки в таком факте меряется не
 * удобством, а §8: критичные факты — только из БД.
 *
 * `numeric` приходит из pg строкой, не числом: приведение к number здесь дало
 * бы тихую потерю точности, а печатаем мы всё равно как есть.
 */
interface RouteRow {
  title: string;
  description: string | null;
  activity_type: string | null;
  difficulty: string | null;
  distance_km: string | null;
  elevation_gain_m: number | null;
  duration_hours: string | null;
  season: string | null;
  hazards: string[] | null;
  equipment: string[] | null;
  mchs_registration_required: boolean | null;
  mchs_phone: string | null;
  park_name: string | null;
}

function normalizeQuery(query: string): string {
  return query
    .replace(/[^\wа-яёА-ЯЁ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

async function searchRoutesOnce(q: string): Promise<RouteRow[]> {
  // Читаем ТАБЛИЦУ, а не v_kamchatka_routes_api, и это осознанно: у
  // представления нет `search_count`, по которому здесь идёт ранжирование
  // (миграция 787 его не вынесла). Переход на представление сменил бы порядок
  // выдачи — то есть молча поменял бы, какие три маршрута видит турист. Запрет
  // §4 касается `SELECT *`; здесь колонки перечислены поимённо, а фильтр
  // видимости стоит свой.
  const { rows } = await pool.query<RouteRow>(
    `SELECT title, description, activity_type,
            difficulty, distance_km, elevation_gain_m, duration_hours, season,
            hazards, equipment,
            mchs_registration_required, mchs_phone, park_name
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

/**
 * Сколько символов описания и сколько всего уходит в промпт.
 *
 * Потолок блока поднят с 2000 вместе с полями §10: три маршрута по описанию в
 * 500 знаков плюс строки фактов не помещались, и обрезка съедала ровно то,
 * ради чего поля добавлены. Считано по худшему случаю: 3 × (заголовок ~60 +
 * факты ~260 + описание 500) ≈ 2500, полуторный запас сверху.
 */
const DESCRIPTION_CHARS = 500;
const ROUTES_BLOCK_CHARS = 3800;

/**
 * Строки фактов маршрута для промпта.
 *
 * Правило одно и жёсткое: НЕТ ДАННЫХ — НЕТ СТРОКИ. Поле `NULL` значит «у нас
 * не записано», и печатать по нему «не требуется» — это выдать незнание за
 * знание (§4.0). Разница видна как раз на регистрации в МЧС: «не требуется»
 * человек прочитает как разрешение не регистрироваться.
 */
export function routeFacts(r: {
  difficulty: string | null;
  distance_km: string | null;
  elevation_gain_m: number | null;
  duration_hours: string | null;
  season: string | null;
  hazards: string[] | null;
  equipment: string[] | null;
  mchs_registration_required: boolean | null;
  mchs_phone: string | null;
  park_name: string | null;
}): string[] {
  const out: string[] = [];

  if (r.mchs_registration_required === true) {
    out.push(`Регистрация в МЧС: ОБЯЗАТЕЛЬНА${r.mchs_phone ? `, телефон ${r.mchs_phone}` : ''}`);
  } else if (r.mchs_registration_required === false) {
    out.push('Регистрация в МЧС: не требуется');
  }
  // null — строки нет вовсе: не знаем.

  const stats = [
    r.distance_km      != null ? `дистанция ${r.distance_km} км`        : null,
    r.elevation_gain_m != null ? `набор высоты ${r.elevation_gain_m} м` : null,
    r.duration_hours   != null ? `длительность ${r.duration_hours} ч`   : null,
    r.difficulty       ? `сложность ${r.difficulty}`                    : null,
    r.season           ? `сезон ${r.season}`                            : null,
  ].filter(Boolean);
  if (stats.length) out.push(stats.join(' · '));

  const hazards = (r.hazards ?? []).filter(Boolean);
  if (hazards.length) out.push(`Опасности: ${hazards.join('; ')}`);

  const equipment = (r.equipment ?? []).filter(Boolean);
  if (equipment.length) out.push(`Снаряжение: ${equipment.join('; ')}`);

  if (r.park_name) out.push(`Природный парк: ${r.park_name}`);

  return out;
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
    const lines = merged.map(r => {
      // Факты ПЕРЕД описанием: блок обрезается по длине с конца, и терять он
      // должен пересказ, а не обязательность регистрации в МЧС.
      const head = `Маршрут: ${r.title}${r.activity_type ? ` (${r.activity_type})` : ''}`;
      const facts = routeFacts(r);
      const desc = (r.description ?? '').slice(0, DESCRIPTION_CHARS);
      return [head, ...facts, desc].filter(Boolean).join('\n');
    });
    return `=== Маршруты по запросу ===\n${lines.join('\n\n')}`.slice(0, ROUTES_BLOCK_CHARS);
  } catch (err) {
    // Отказ поиска не глушится (§4.0). Пустая строка отсюда означает для
    // промпта «маршрутов нет», и молчащий catch делал «не смогли спросить»
    // неотличимым от «в базе пусто» — а Кузьмич в этом случае отвечает из
    // памяти модели.
    logSwallowedFailure('kuzmich', 'поиск маршрутов', err);
    return '';
  }
}
