/**
 * GET /api/cron/seismic-latency-census — как быстро толчок доходит до ленты.
 * Bearer CRON_SECRET, только чтение.
 *
 * ── Зачем (01.10) ─────────────────────────────────────────────────────────
 *
 * Толчок M5.0 30.09 18:36 UTC (EQKam, 169 км от Петропавловска) владелец
 * увидел на Ведаре около 23:30. «Приём опоздал на пять часов» и «экран не
 * перечитался» по ленте неотличимы: `external_alerts.created_at` — время
 * очага, а не записи. Время записи лежит в журнале решений безопасности
 * (миграция 925): событие `published` пишется в момент вставки строки.
 *
 * Перепись отвечает на три вопроса:
 *   1. по каждому толчку окна — источник, время очага, время записи,
 *      задержка против нормы 15 минут («цунами от 185 км ≈ 15 мин»);
 *   2. по каждому пути приёма (heartbeat GET / POST реле и раннера) —
 *      сколько прогонов, последний, самые длинные разрывы;
 *   3. пары записей разных источников, похожие на один толчок, записанный
 *      дважды (сверка приёма ±30 с их пропустила).
 *
 * У каждого вопроса три исхода (§4.0): ответ, пусто, «не смогли спросить»
 * с кодом SQLSTATE. Задержка без записи в журнале — null, а не ноль.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import {
  quakeLatency,
  summarizeBySource,
  suspectedDuplicates,
  SEISMIC_DELIVERY_NORM_MIN,
  type QuakeRow,
} from '@/lib/safety/seismic-latency';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const QuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).default(48),
});

type Probe<T> = { ok: true; value: T } | { ok: false; error: string };

async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    // SQLSTATE важнее текста: «нет таблицы» и отказ соединения чинятся по-разному.
    return { ok: false, error: `${e.code ? `[${e.code}] ` : ''}${e.message ?? String(err)}` };
  }
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET не настроен' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const parsed = QuerySchema.safeParse({ hours: request.nextUrl.searchParams.get('hours') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: 'hours — целое число часов от 1 до 168' }, { status: 400 });
  }
  const hours = parsed.data.hours;

  const quakes = await probe(async () => {
    const { rows } = await pool.query<{
      id: string; external_id: string | null; magnitude: number | null;
      lat: number | null; lng: number | null; event_at: Date; ingested_at: Date | null;
    }>(
      `SELECT ea.id::text AS id, ea.external_id,
              ea.magnitude::float8 AS magnitude, ea.lat::float8 AS lat, ea.lng::float8 AS lng,
              -- created_at без часового пояса, журнал — с поясом: приведение
              -- явное и в сессии базы, тем же правилом, каким строку писали.
              -- Иначе задержку считал бы часовой пояс процесса Node.
              ea.created_at::timestamptz AS event_at, led.first_published AS ingested_at
         FROM external_alerts ea
         LEFT JOIN LATERAL (
           SELECT MIN(e.occurred_at) AS first_published
             FROM safety_decision_events e
            WHERE e.entity_type = 'external_alert'
              AND e.entity_id = ea.id::text
              AND e.event_type = 'published'
         ) led ON TRUE
        WHERE ea.alert_type = 'earthquake'
          AND ea.created_at > NOW() - ($1::int * INTERVAL '1 hour')
        ORDER BY ea.created_at DESC
        LIMIT 200`,
      [hours],
    );
    const items = rows.map((r) => quakeLatency({
      id: r.id,
      externalId: r.external_id,
      magnitude: r.magnitude,
      lat: r.lat,
      lng: r.lng,
      eventAt: new Date(r.event_at).toISOString(),
      ingestedAt: r.ingested_at ? new Date(r.ingested_at).toISOString() : null,
    } satisfies QuakeRow));
    return {
      items,
      by_source: summarizeBySource(items),
      suspected_duplicates: suspectedDuplicates(items),
    };
  });

  const runs = await probe(async () => {
    const byTrigger = await pool.query<{
      trigger: string; runs: number; success: number; last_at: Date | null; max_gap_min: number | null;
    }>(
      `WITH r AS (
         SELECT COALESCE(metadata->>'trigger', 'unknown') AS trigger, status, ended_at,
                ended_at - LAG(ended_at) OVER (
                  PARTITION BY COALESCE(metadata->>'trigger', 'unknown') ORDER BY ended_at
                ) AS gap
           FROM agent_run_history
          WHERE agent_id = 'safety-ingest'
            AND ended_at > NOW() - ($1::int * INTERVAL '1 hour')
       )
       SELECT trigger, COUNT(*)::int AS runs,
              COUNT(*) FILTER (WHERE status = 'success')::int AS success,
              MAX(ended_at) AS last_at,
              ROUND(EXTRACT(EPOCH FROM MAX(gap)) / 60)::int AS max_gap_min
         FROM r
        GROUP BY trigger
        ORDER BY trigger`,
      [hours],
    );
    const gaps = await pool.query<{ trigger: string; from_at: Date; to_at: Date; gap_min: number }>(
      `WITH r AS (
         SELECT COALESCE(metadata->>'trigger', 'unknown') AS trigger, ended_at,
                LAG(ended_at) OVER (
                  PARTITION BY COALESCE(metadata->>'trigger', 'unknown') ORDER BY ended_at
                ) AS prev_at
           FROM agent_run_history
          WHERE agent_id = 'safety-ingest'
            AND ended_at > NOW() - ($1::int * INTERVAL '1 hour')
       )
       SELECT trigger, prev_at AS from_at, ended_at AS to_at,
              ROUND(EXTRACT(EPOCH FROM (ended_at - prev_at)) / 60)::int AS gap_min
         FROM r
        WHERE prev_at IS NOT NULL
          AND ended_at - prev_at > ($2::int * INTERVAL '1 minute')
        ORDER BY ended_at - prev_at DESC
        LIMIT 20`,
      [hours, SEISMIC_DELIVERY_NORM_MIN],
    );
    return {
      by_trigger: byTrigger.rows.map((r) => ({
        ...r,
        last_at: r.last_at ? new Date(r.last_at).toISOString() : null,
      })),
      gaps_over_norm: gaps.rows.map((g) => ({
        trigger: g.trigger,
        from_at: new Date(g.from_at).toISOString(),
        to_at: new Date(g.to_at).toISOString(),
        gap_min: g.gap_min,
      })),
    };
  });

  // Вердикт — только по измеренному. Нет ни одной задержки с временем записи —
  // «не знаем», а не «в норме».
  const measured = quakes.ok ? quakes.value.items.filter((q) => q.latencyMin !== null) : [];
  const verdict = !quakes.ok || measured.length === 0
    ? 'unknown'
    : measured.some((q) => q.late) ? 'late' : 'on_time';

  return NextResponse.json({
    window_hours: hours,
    norm_min: SEISMIC_DELIVERY_NORM_MIN,
    verdict,
    quakes: quakes.ok ? { ok: true, ...quakes.value } : quakes,
    ingest_runs: runs.ok ? { ok: true, ...runs.value } : runs,
  });
}
