/**
 * GET /api/cron/alert-scope-census — кого накрывает каждое предупреждение.
 * Bearer CRON_SECRET, только чтение, ничего не меняет.
 *
 * ЗАЧЕМ. Замер владельца с прода (дайджест 27.09) показал два разных дефекта с
 * одним механизмом: пепел Шивелуча давал Ключевскому [КРАСНЫЙ] при собственном
 * жёлтом KVERT, а «Вилючинский перевал — проезд по пропускам» висел на
 * Курильском озере, в Быстринском парке и на Безымянном — за 250-500 км.
 * Предикат сопоставления спрашивал координату только у пожара и перекрытой
 * дороги, остальное раскладывал ЗОНОЙ.
 *
 * Правка сделана (`lib/services/safety/alert-place-scope.ts`), но СКОЛЬКО мест
 * она освобождает от чужих предупреждений, из репозитория не видно: это факт о
 * данных прода. Перепись отвечает на это числом — до правки и после, одним и
 * тем же запросом.
 *
 * ЧЕГО ПЕРЕПИСЬ НЕ ДЕЛАЕТ.
 *
 * Не судит, правильно ли предупреждение накрыло место. Она считает ОХВАТ: у
 * какого алерта сколько мест, есть ли у него координата, привязан ли он к
 * вулкану. Вердикт «это шум» выносит человек, сравнив охват с расстоянием.
 *
 * Не повторяет предикат своим текстом: он импортируется из того же модуля,
 * которым считает крон. Два экземпляра разошлись бы — и перепись начала бы
 * измерять не то, что происходит (§12).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { ALERT_MATCH_SQL, PLACE_SCOPED_TYPES } from '@/lib/services/safety/alert-place-scope';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

interface ScopeRow {
  id: string;
  alert_type: string | null;
  title: string;
  severity: number | null;
  has_coords: boolean;
  volcano_name: string | null;
  volcano_anchored: boolean;
  volcano_scope: string | null;
  zones: string[] | null;
  places_covered: string;
  farthest_km: string | null;
  farthest_place: string | null;
  source_prefix: string | null;
  external_day: string | null;
  created_at: string | null;
  expires_at: string | null;
  last_published_at: string | null;
  description_md5: string;
  twins_same_title: number;
  twins_same_description: number;
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<ScopeRow>(
      // Самое дальнее накрытое место — главный признак шума: предупреждение о
      // перевале, доставшее точку за 500 км, видно этой строкой без всякого
      // вердикта.
      `WITH covered AS (
         SELECT ea.id                                        AS alert_id,
                p.name                                       AS place_name,
                CASE
                  WHEN ea.lat IS NULL OR ea.lng IS NULL
                    OR ark.lat IS NULL OR ark.lng IS NULL THEN NULL
                  ELSE 2 * 6371 * asin(sqrt(
                         power(sin(radians((ark.lat - ea.lat) / 2)), 2)
                         + cos(radians(ea.lat)) * cos(radians(ark.lat))
                           * power(sin(radians((ark.lng - ea.lng) / 2)), 2)
                       ))
                END                                          AS km
           FROM external_alerts ea
           JOIN location_real_time_status lrs ON TRUE
           JOIN places p ON p.ark_id = lrs.agent_route_id AND p.is_visible = TRUE
           LEFT JOIN agent_route_knowledge ark ON ark.id = lrs.agent_route_id
          WHERE (ea.expires_at IS NULL OR ea.expires_at > ${UTC_WALL_NOW_SQL})
            AND (${ALERT_MATCH_SQL})
       ),
       agg AS (
         SELECT alert_id,
                COUNT(*)::text AS places_covered,
                MAX(km)        AS farthest_km,
                (ARRAY_AGG(place_name ORDER BY km DESC NULLS LAST))[1] AS farthest_place
           FROM covered
          GROUP BY alert_id
       )
       SELECT ea.id::text                                    AS id,
              ea.alert_type,
              ea.title,
              ea.severity,
              (ea.lat IS NOT NULL AND ea.lng IS NOT NULL)     AS has_coords,
              ea.volcano_name,
              (ea.volcano_ark_id IS NOT NULL)                 AS volcano_anchored,
              -- Охват вулканической тревоги (1301): ring — кольцо 25 км у
              -- извержения, named — запрет подходить, только вулкан и его
              -- поимённые связи. Без него «23 места» не отличить от «8».
              ea.volcano_scope,
              ea.affected_zones                               AS zones,
              COALESCE(agg.places_covered, '0')               AS places_covered,
              ROUND(agg.farthest_km::numeric, 1)::text        AS farthest_km,
              agg.farthest_place,
              -- Двойники (#3275): строки ленты с тем же типом и заголовком.
              -- Откуда пришла строка (префикс источника и день в external_id),
              -- когда записана и до какого срока, и совпадает ли описание у
              -- пары — чтобы причину дубля назвали данные, а не догадка.
              split_part(ea.external_id, '/', 1)              AS source_prefix,
              NULLIF(split_part(ea.external_id, '/', 2), '')  AS external_day,
              ea.created_at::text                             AS created_at,
              ea.expires_at::text                             AS expires_at,
              ea.last_published_at::text                      AS last_published_at,
              left(md5(COALESCE(ea.description, '')), 8)      AS description_md5,
              (SELECT COUNT(*)::int FROM external_alerts tw
                WHERE tw.id <> ea.id AND tw.title = ea.title
                  AND tw.alert_type IS NOT DISTINCT FROM ea.alert_type
                  AND (tw.expires_at IS NULL OR tw.expires_at > ${UTC_WALL_NOW_SQL})) AS twins_same_title,
              (SELECT COUNT(*)::int FROM external_alerts tw
                WHERE tw.id <> ea.id AND tw.title = ea.title
                  AND tw.alert_type IS NOT DISTINCT FROM ea.alert_type
                  AND COALESCE(tw.description, '') = COALESCE(ea.description, '')
                  AND (tw.expires_at IS NULL OR tw.expires_at > ${UTC_WALL_NOW_SQL})) AS twins_same_description
         FROM external_alerts ea
         LEFT JOIN agg ON agg.alert_id = ea.id
        WHERE (ea.expires_at IS NULL OR ea.expires_at > ${UTC_WALL_NOW_SQL})
        ORDER BY COALESCE(agg.places_covered, '0')::int DESC, ea.severity DESC NULLS LAST
        LIMIT 60`,
    );

    const alerts = rows.map((r) => ({
      id: r.id,
      type: r.alert_type,
      title: r.title,
      severity: r.severity != null ? Number(r.severity) : null,
      has_coords: r.has_coords,
      volcano_name: r.volcano_name,
      volcano_anchored: r.volcano_anchored,
      volcano_scope: r.volcano_scope,
      zones: r.zones ?? [],
      places_covered: Number(r.places_covered),
      farthest_km: r.farthest_km != null ? Number(r.farthest_km) : null,
      farthest_place: r.farthest_place,
      source_prefix: r.source_prefix,
      external_day: r.external_day,
      created_at: r.created_at,
      expires_at: r.expires_at,
      last_published_at: r.last_published_at,
      description_md5: r.description_md5,
      twins_same_title: Number(r.twins_same_title),
      twins_same_description: Number(r.twins_same_description),
    }));

    /**
     * Алерты, которые НЕ красят ни одного места, — это не ошибка переписи.
     * Рода с точным местом (дорога, пожар, извержение) без привязки намеренно
     * не красят никого и живут в общекраевой ленте: «не установлено» ≠ «везде»
     * (решение владельца 27.09). Число здесь — цена этого решения, и её надо
     * видеть, а не выводить.
     */
    const placeScoped = new Set<string>(PLACE_SCOPED_TYPES);
    const unanchoredPlaceScoped = alerts.filter(
      (a) => a.type != null && placeScoped.has(a.type) && a.places_covered === 0,
    );

    return NextResponse.json({
      ok: true,
      checked_at: new Date().toISOString(),
      alerts_active: alerts.length,
      alerts,
      widest: alerts[0] ?? null,
      place_scoped_types: [...PLACE_SCOPED_TYPES],
      unanchored_place_scoped: unanchoredPlaceScoped.map((a) => ({
        type: a.type, title: a.title, volcano_name: a.volcano_name,
      })),
      // Двойники по заголовку (#3275): сколько действующих строк повторяют
      // чужой тип и заголовок, и сколько из них — с тем же описанием.
      title_twins: alerts.filter((a) => a.twins_same_title > 0).length,
      title_twins_same_description: alerts.filter((a) => a.twins_same_description > 0).length,
      volcanic_unanchored: alerts.filter(
        (a) => a.type === 'volcanic_eruption' && !a.volcano_anchored,
      ).length,
      note: 'places_covered считается ТЕМ ЖЕ предикатом, которым красит крон (lib/services/safety/alert-place-scope.ts). farthest_km — расстояние до самого дальнего накрытого места; у события без координаты его нет, и это «не измерили», а не «ноль».',
    });
  } catch (err) {
    // Отказ переписи — «не смог посчитать», а не «шума нет» (§4.0).
    const e = err as { code?: string; message?: string };
    console.error('[alert-scope-census] перепись не выполнилась', {
      sqlstate: e?.code,
      message: e?.message,
    });
    return NextResponse.json(
      { ok: false, error: 'Перепись не выполнилась', sqlstate: e?.code ?? null },
      { status: 500 },
    );
  }
}
