/**
 * GET /api/cron/places-candidates — кандидаты в дубли по ВСЕМУ каталогу одним
 * запросом. Bearer CRON_SECRET. Только читает.
 *
 * Зачем. Разбор по одному виду за пробу — это пятнадцать проб по несколько
 * минут каждая. Слово владельца 14.08: места привести в порядок критично
 * важно. Этот роут отдаёт сразу все пары-кандидаты каталога, с началом
 * описаний ОБЕИХ сторон — то есть всё, что нужно для решения «дубль или
 * разные объекты», в одном ответе.
 *
 * Кандидат — пара живых мест ОДНОГО типа, где выполнено любое из:
 *   - близко: ≤ maxDistM (default 1500 м) при настоящих координатах обеих;
 *   - похоже названы: similarity ≥ minSim (default 0.55) — ловит дубли с
 *     испорченной геопозицией, которых близость не увидит («Вулкан Камень»
 *     в 457 км от «Камня»).
 *
 * Уроки, оплаченные этой же работой:
 *   - тип обязан совпадать («Налычевская долина» и «Налычевские источники»
 *     стоят в одной точке, но это разные объекты);
 *   - плейсхолдер-координаты (0,0 и 53.0444/158.6483) не участвуют в
 *     близости — иначе десятки скрытых мест «в нуле метров друг от друга»;
 *   - описания решают: по словам видно и тождество, и враньё координат.
 *
 * Решений роут не принимает. Слияние — поимённым places-dedup, мягко.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const QuerySchema = z.object({
  maxDistM: z.coerce.number().int().min(10).max(20000).default(1500),
  minSim: z.coerce.number().min(0.3).max(1).default(0.55),
  limit: z.coerce.number().int().min(1).max(400).default(250),
});

const REAL = (a: string) => `
  ${a}.lat IS NOT NULL AND ${a}.lng IS NOT NULL
  AND NOT (${a}.lat = 0 AND ${a}.lng = 0)
  AND NOT (ROUND(${a}.lat::numeric,4) = 53.0444 AND ROUND(${a}.lng::numeric,4) = 158.6483)`;

interface CandidateRow {
  type: string | null;
  id1: string; name1: string; vis1: boolean; desc1: string | null;
  id2: string; name2: string; vis2: boolean; desc2: string | null;
  dist_m: number | null;
  sim: number;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = QuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Неверные параметры' },
      { status: 400 },
    );
  }
  const { maxDistM, minSim, limit } = parsed.data;

  try {
    const { rows } = await pool.query<CandidateRow>(
      `SELECT p1.location_type AS type,
              p1.id::text AS id1, p1.name AS name1, p1.is_visible AS vis1,
              LEFT(p1.description, 140) AS desc1,
              p2.id::text AS id2, p2.name AS name2, p2.is_visible AS vis2,
              LEFT(p2.description, 140) AS desc2,
              CASE WHEN ${REAL('p1')} AND ${REAL('p2')}
                   THEN 6371000 * acos(LEAST(1, GREATEST(-1,
                     cos(radians(p1.lat)) * cos(radians(p2.lat)) * cos(radians(p2.lng) - radians(p1.lng)) +
                     sin(radians(p1.lat)) * sin(radians(p2.lat))
                   )))
                   ELSE NULL END AS dist_m,
              similarity(p1.name, p2.name) AS sim
         FROM places p1
         JOIN places p2
           ON p2.id > p1.id
          AND p1.location_type IS NOT DISTINCT FROM p2.location_type
         WHERE p1.merged_into_id IS NULL AND p2.merged_into_id IS NULL
           AND (
             (${REAL('p1')} AND ${REAL('p2')}
              AND p2.lat BETWEEN p1.lat - 0.05 AND p1.lat + 0.05
              AND p2.lng BETWEEN p1.lng - 0.09 AND p1.lng + 0.09
              AND 6371000 * acos(LEAST(1, GREATEST(-1,
                    cos(radians(p1.lat)) * cos(radians(p2.lat)) * cos(radians(p2.lng) - radians(p1.lng)) +
                    sin(radians(p1.lat)) * sin(radians(p2.lat))
                  ))) <= $1)
             OR similarity(p1.name, p2.name) >= $2
           )
         ORDER BY similarity(p1.name, p2.name) DESC, dist_m ASC NULLS LAST
         LIMIT $3`,
      [maxDistM, minSim, limit],
    );

    return NextResponse.json({
      success: true,
      total: rows.length,
      candidates: rows.map((r) => ({
        type: r.type,
        a: { id: r.id1, name: r.name1, vis: r.vis1, desc: r.desc1 },
        b: { id: r.id2, name: r.name2, vis: r.vis2, desc: r.desc2 },
        distM: r.dist_m === null ? null : Math.round(r.dist_m),
        sim: Math.round(r.sim * 100) / 100,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка поиска кандидатов';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
