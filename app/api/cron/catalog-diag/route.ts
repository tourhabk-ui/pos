/**
 * GET /api/cron/catalog-diag — почему публичный каталог отвечает 503.
 *
 * Ночью 15.08 `/api/routes` начал отдавать 503 с телом «Ошибка базы
 * данных. Проверьте DATABASE_URL в env.» — и на выборке из двух тысяч
 * записей, и на пяти. При этом health отвечает ok:true, то есть
 * подключение живо, а сообщение вводит в заблуждение.
 *
 * Диагностика идёт от простого к сложному и возвращает ТЕКСТ ошибки
 * Postgres на первом же упавшем шаге: пустой VIEW, счёт по нему, выборка
 * колонок каталога, join'ы карточек. По шагу видно, что именно сломано —
 * гадать по коду 503 бессмысленно.
 *
 * READ-ONLY, Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STEPS: Array<{ name: string; sql: string }> = [
  { name: 'select 1', sql: 'SELECT 1 AS ok' },
  { name: 'places жив', sql: 'SELECT COUNT(*)::int AS n FROM places' },
  { name: 'kamchatka_routes жив', sql: 'SELECT COUNT(*)::int AS n FROM kamchatka_routes' },
  { name: 'VIEW читается', sql: 'SELECT COUNT(*)::int AS n FROM agent_route_knowledge' },
  {
    name: 'колонки каталога из VIEW',
    sql: `SELECT ark.id, ark.route_dedupe_key, ark.kind, ark.category, ark.location_type,
                 ark.activity_type, ark.title, ark.description, ark.lat, ark.lng,
                 ark.source_url, ark.source_name, ark.payload, ark.created_at
          FROM agent_route_knowledge ark LIMIT 3`,
  },
  {
    name: 'join фото и статуса',
    sql: `SELECT ark.id,
                 (ari.route_id IS NOT NULL AND ari.model IN ('wikimedia','manual-upload')) AS has_real_image,
                 lrs.is_open
          FROM agent_route_knowledge ark
          LEFT JOIN ai_route_images ari ON ari.route_id = ark.id
          LEFT JOIN location_real_time_status lrs ON lrs.agent_route_id = ark.id
          LIMIT 3`,
  },
  {
    name: 'сортировка каталога по умолчанию',
    sql: `SELECT ark.id FROM agent_route_knowledge ark
          WHERE ark.kind = 'place' AND ark.lat IS NOT NULL AND ark.lng IS NOT NULL
          ORDER BY title ASC LIMIT 50`,
  },
];

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: Array<{ step: string; ok: boolean; rows?: number; error?: string }> = [];

  for (const step of STEPS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await pool.query(step.sql);
      results.push({ step: step.name, ok: true, rows: res.rowCount ?? 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ step: step.name, ok: false, error: message.slice(0, 400) });
      break; // дальше идти незачем: следующий шаг сложнее упавшего
    }
  }

  const failed = results.find(r => !r.ok);
  return NextResponse.json({
    success: true,
    verdict: failed ? `падает на шаге «${failed.step}»` : 'все шаги прошли — поломка не в этих запросах',
    steps: results,
  });
}
