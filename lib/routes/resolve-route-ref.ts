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

/**
 * Куда ведёт адрес слитого маршрута: по цепочке merged_into_id — до видимой
 * несклеенной записи, не дальше пяти шагов (21.11, #3566 п.1).
 *
 * У мест это делает resolveMergedTarget (lib/places/aliases.ts), у маршрутов
 * не делал никто: слитый маршрут уходил из VIEW, и его адрес из выдачи
 * поисковиков отвечал 404 — склейка дублей убивала адрес, а не переносила.
 * Ответ — slug выжившего, без slug — его id VIEW (COALESCE(ark_id, id)).
 */
export const MERGED_ROUTE_SQL = `
  WITH RECURSIVE chain AS (
    SELECT r.id, r.merged_into_id, r.slug, r.ark_id, r.is_visible, 0 AS hop
      FROM kamchatka_routes r
     WHERE (r.slug = $1 OR r.id::text = $1 OR r.ark_id::text = $1)
       AND r.merged_into_id IS NOT NULL
    UNION ALL
    SELECT n.id, n.merged_into_id, n.slug, n.ark_id, n.is_visible, c.hop + 1
      FROM chain c
      JOIN kamchatka_routes n ON n.id::text = c.merged_into_id::text
     WHERE c.hop < 5
  )
  SELECT COALESCE(slug, COALESCE(ark_id, id)::text) AS canonical
    FROM chain
   WHERE hop > 0 AND merged_into_id IS NULL AND is_visible = TRUE
   ORDER BY hop
   LIMIT 1`;

/** Отказ базы бросается: «не смогли спросить» — не «не слито» (§4.0), решает вызывающий. */
export async function resolveMergedRoute(idOrSlug: string): Promise<string | null> {
  const r = await query(MERGED_ROUTE_SQL, [idOrSlug]);
  const canonical = r.rows[0]?.canonical;
  return typeof canonical === 'string' && canonical ? canonical : null;
}
