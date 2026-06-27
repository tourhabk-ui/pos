/**
 * GET /api/health/uon-sync?days=7
 * Health-метрика синхронизации броней с U-ON.Travel CRM.
 * Читает uon_sync_log: success/failed, последняя успешная синхронизация, последняя ошибка.
 * Auth: requireAdmin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const parsed = QuerySchema.safeParse({
    days: req.nextUrl.searchParams.get('days') ?? 7,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Некорректный параметр days (1–90)' }, { status: 400 });
  }
  const { days } = parsed.data;

  // Есть ли вообще операторы с настроенной интеграцией U-ON
  const configuredRes = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::int AS cnt FROM partners WHERE uon_api_key IS NOT NULL AND uon_api_key <> ''`,
    [],
  );
  const configured = Number(configuredRes.rows[0]?.cnt ?? 0);

  const aggRes = await pool.query<{
    success: string;
    failed: string;
    avg_latency_ms: string | null;
    last_success_at: string | null;
    last_error_at: string | null;
    failed_last_hour: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE success)::int                       AS success,
       COUNT(*) FILTER (WHERE NOT success)::int                   AS failed,
       ROUND(AVG(latency_ms))::int                                AS avg_latency_ms,
       MAX(created_at) FILTER (WHERE success)::text               AS last_success_at,
       MAX(created_at) FILTER (WHERE NOT success)::text           AS last_error_at,
       COUNT(*) FILTER (WHERE NOT success AND created_at >= NOW() - INTERVAL '1 hour')::int AS failed_last_hour
     FROM uon_sync_log
     WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL`,
    [days],
  );
  const agg = aggRes.rows[0];

  // Последний текст ошибки (для диагностики)
  const lastErrRes = await pool.query<{ error: string | null }>(
    `SELECT error FROM uon_sync_log
     WHERE NOT success AND error IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [],
  );

  const success = Number(agg?.success ?? 0);
  const failed = Number(agg?.failed ?? 0);
  const failedLastHour = Number(agg?.failed_last_hour ?? 0);

  // status: если интеграция ни у кого не настроена — ok (выключена)
  // error — свежие ошибки за последний час; warn — есть ошибки за период
  let status: 'ok' | 'warn' | 'error';
  if (configured === 0) {
    status = 'ok';
  } else if (failedLastHour > 0) {
    status = 'error';
  } else if (failed > 0) {
    status = 'warn';
  } else {
    status = 'ok';
  }

  return NextResponse.json({
    period_days: days,
    sync_enabled: configured > 0,
    operators_with_uon: configured,
    success,
    failed,
    failed_last_hour: failedLastHour,
    avg_latency_ms: agg?.avg_latency_ms != null ? Number(agg.avg_latency_ms) : null,
    last_success_at: agg?.last_success_at ?? null,
    last_error_at: agg?.last_error_at ?? null,
    last_error: lastErrRes.rows[0]?.error ?? null,
    status,
    as_of: new Date().toISOString(),
  });
}
