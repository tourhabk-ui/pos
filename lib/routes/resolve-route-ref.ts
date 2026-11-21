import { query } from '@/lib/database';
import { isUuid } from '@/lib/text/slugify';

/**
 * Резолвит slug ИЛИ uuid → uuid. slug живёт на мастер-таблицах (places/
 * kamchatka_routes), а VIEW agent_route_knowledge его не содержит — поэтому
 * сначала находим id по slug, дальше карточка работает как раньше по id.
 */
export async function resolveToId(idOrSlug: string): Promise<{ id: string; kind: 'route' | 'place' } | null> {
  try {
    // VIEW agent_route_knowledge ключуется по ark_id для мест и COALESCE(ark_id,id)
    // для маршрутов (миграция 677) — резолвим slug именно в этот id.
    //
    // Маршрут — первым: /routes/ — адрес маршрутов, и если slug совпал у
    // маршрута и места, это разные сущности, а показывать надо маршрут. Род
    // (kind) нужен странице: место под /routes/ — двойник карточки места.
    if (isUuid(idOrSlug)) {
      // UUID маршрута бывает и собственным id строки (kamchatka_routes.id), а не
      // id VIEW (COALESCE(ark_id, id)): такие адреса лежат в выдаче Google
      // (#3566 п.2) и отдавали 404 вместо 301 на адрес по имени. Ответ — всегда
      // id VIEW: по нему читается карточка и ищется slug для редиректа.
      const r = await query(
        `SELECT * FROM (
           SELECT COALESCE(ark_id, id)::text AS id, 'route' AS kind, 0 AS ord FROM kamchatka_routes
            WHERE COALESCE(ark_id, id)::text = $1 OR id::text = $1
           UNION ALL SELECT ark_id::text AS id, 'place' AS kind, 1 AS ord FROM places WHERE ark_id::text = $1
         ) x ORDER BY ord LIMIT 1`,
        [idOrSlug]
      );
      const row = r.rows[0];
      return row
        ? { id: row.id as string, kind: row.kind as 'route' | 'place' }
        : { id: idOrSlug, kind: 'route' };
    }
    const r = await query(
      `SELECT * FROM (
         SELECT COALESCE(ark_id, id)::text AS id, 'route' AS kind, 0 AS ord FROM kamchatka_routes WHERE slug = $1
         UNION ALL SELECT ark_id::text AS id, 'place' AS kind, 1 AS ord FROM places WHERE slug = $1
       ) x ORDER BY ord LIMIT 1`,
      [idOrSlug]
    );
    const row = r.rows[0];
    return row ? { id: row.id as string, kind: row.kind as 'route' | 'place' } : null;
  } catch (error) {
    const e = error as Error & { code?: string };
    console.error('[routes/[id]] резолв адреса упал', { idOrSlug, sqlstate: e?.code, message: e?.message });
    return null;
  }
}
