/**
 * GET /api/cron/duplicate-indexes-census — точные дубли индексов на самой базе
 * прода и план их снятия (#3388 п.4, шаг 1). Bearer CRON_SECRET, только
 * чтение, только имена схемы.
 *
 * Миграция со снятием пойдёт `DROP INDEX CONCURRENTLY` по списку: проверить
 * «двойник на месте» внутри неё нельзя. Поэтому список берётся отсюда — с
 * прода, а не с модели схемы из репозитория. Правило выбора и запрос —
 * lib/db/duplicate-indexes.ts.
 *
 * Отказ запроса — 500 с SQLSTATE: «не смогли спросить» не равно «дублей нет»
 * (§4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { DUPLICATE_INDEXES_SQL, planDuplicateDrops, type DuplicateGroup } from '@/lib/db/duplicate-indexes';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(req) }, { status: 401 });
  }
  let groups: DuplicateGroup[];
  try {
    groups = (await pool.query<DuplicateGroup>(DUPLICATE_INDEXES_SQL)).rows;
  } catch (err) {
    const sqlstate = (err as { code?: unknown } | null)?.code;
    console.error('[duplicate-indexes-census] запрос не выполнился',
      `sqlstate=${typeof sqlstate === 'string' ? sqlstate : 'нет кода'}`,
      err instanceof Error ? err.message : err);
    return NextResponse.json({
      ok: false,
      probe: 'duplicate_indexes_census_v1',
      error: 'Перепись индексов не выполнилась',
      sqlstate: typeof sqlstate === 'string' ? sqlstate : null,
    }, { status: 500 });
  }
  const plan = planDuplicateDrops(groups);
  return NextResponse.json({
    ok: true,
    probe: 'duplicate_indexes_census_v1',
    checked_at: new Date().toISOString(),
    groups_total: groups.length,
    drop_total: plan.drops.reduce((n, d) => n + d.drop.length, 0),
    drops: plan.drops,
    blocked: plan.blocked,
    groups,
  });
}
