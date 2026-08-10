/**
 * GET /api/cron/prod-errors — серверные ошибки прода списком, по требованию.
 *
 * Ошибки собираются давно: `instrumentation.onRequestError` пишет каждую в
 * `ai_actions_log` (`action_type='server_error'`, с троттлингом по маршруту).
 * Но читал их только объектив эволюции — раз в сутки, превращая в находки.
 * Посмотреть, что происходит ПРЯМО СЕЙЧАС, было нельзя: ни владельцу, ни
 * Claude в репозитории. Из-за этого разговор об ошибках упирался в ощущения —
 * «вроде много», — а не в список маршрутов со счётчиками.
 *
 * Здесь только чтение. Роут ничего не пишет и ничего не чинит: находка — повод
 * посмотреть, а не переписать данные. Живёт под /api/cron/ по одной причине —
 * проба прода несёт CRON_SECRET только на этот префикс (сужено 09.08 после
 * утечки секрета на сторонний хост), и другого способа увидеть прод из
 * песочницы нет.
 *
 * Окно задаётся `?hours=` (по умолчанию 25 — как у суточного объектива, с
 * запасом на дрейф расписания). `?route=` сужает до одного маршрута.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';

export const dynamic = 'force-dynamic';

interface ErrorRow {
  route: string | null;
  method: string | null;
  kind: string | null;
  n: number;
  first_at: string;
  last_at: string;
  last_message: string | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  // Окно ограничено сверху неделей: запрос за месяц по журналу действий —
  // это полный скан таблицы, которая пишется на каждое действие платформы.
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours') ?? 25) || 25));
  const route = url.searchParams.get('route');

  try {
    const { rows } = await pool.query<ErrorRow>(
      `SELECT metadata->>'route'  AS route,
              STRING_AGG(DISTINCT metadata->>'method', '/') AS method,
              STRING_AGG(DISTINCT metadata->>'kind', '/')   AS kind,
              COUNT(*)::int AS n,
              MIN(created_at)::text AS first_at,
              MAX(created_at)::text AS last_at,
              (ARRAY_AGG(metadata->>'message' ORDER BY created_at DESC))[1] AS last_message
         FROM ai_actions_log
        WHERE action_type = 'server_error'
          AND created_at > NOW() - make_interval(hours => $1)
          AND ($2::text IS NULL OR metadata->>'route' = $2)
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 50`,
      [hours, route],
    );

    const total = rows.reduce((s, r) => s + r.n, 0);
    return NextResponse.json({
      ok: true,
      hours,
      routes: rows.length,
      total,
      // Пусто — это ответ, а не отсутствие ответа: за окно ошибок не было.
      errors: rows,
    });
  } catch (err) {
    // Наружу — причина: роут закрыт секретом, скрывать от себя же нечего, а
    // «пусто» вместо сбоя запроса — ровно та подмена, из-за которой оценка
    // риска по зонам молчала месяцами.
    const message = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
