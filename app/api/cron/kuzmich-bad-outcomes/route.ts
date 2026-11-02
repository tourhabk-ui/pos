/**
 * GET /api/cron/kuzmich-bad-outcomes?days=7 — плохие оценки Кузьмича по
 * типам. Bearer CRON_SECRET. Только читает.
 *
 * Аудит агентов 02.11, пробел #5: низкие баллы грейдера копились в
 * agent_knowledge без обзора. Здесь — кластеры с числами и 1–2 примерами
 * формулировки судьи (redactPII, обрезка). Вопрос туриста, ответ бота и
 * ключ разговора наружу не отдаются. Потребитель — еженедельный дайджест
 * .github/workflows/kuzmich-bad-outcomes-digest.yml.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { clusterOutcomes, type OutcomeRowLite } from '@/lib/kuzmich/bad-outcome-clusters';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/** Плохое: балл ниже 7, незаземлённый ответ или отказ модели. */
const SQL = `
  SELECT compiled_truth,
         metadata->>'surface'      AS surface,
         metadata->>'provider'     AS provider,
         metadata->>'answer_path'  AS answer_path,
         metadata->>'outcome_kind' AS outcome_kind,
         NULLIF(substring(title from 'Оценка ответа: ([0-9]+)/10'), '')::int AS score
    FROM agent_knowledge
   WHERE type = 'outcome' AND agent_id = 'kuzmich'
     AND created_at > NOW() - ($1::int * INTERVAL '1 day')
     AND (compiled_truth ~ 'Оценка [0-6]/10'
          OR compiled_truth LIKE '%НЕЗАЗЕМЛЁННЫЕ ФАКТЫ%'
          OR metadata->>'outcome_kind' = 'refusal')
   ORDER BY created_at DESC
   LIMIT 2000`;

const TOTAL_SQL = `SELECT COUNT(*)::int AS n FROM agent_knowledge
   WHERE type = 'outcome' AND agent_id = 'kuzmich'
     AND created_at > NOW() - ($1::int * INTERVAL '1 day')`;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }
  const raw = parseInt(request.nextUrl.searchParams.get('days') ?? '7', 10);
  const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, raw)) : 7;
  try {
    const [bad, total] = await Promise.all([
      pool.query<OutcomeRowLite>(SQL, [days]),
      pool.query<{ n: number }>(TOTAL_SQL, [days]),
    ]);
    const rows = bad.rows;
    const count = (f: (r: OutcomeRowLite) => string) => rows.reduce<Record<string, number>>((m, r) => { const k = f(r); m[k] = (m[k] ?? 0) + 1; return m; }, {});
    return NextResponse.json({
      ok: true,
      days,
      outcomes_total: total.rows[0]?.n ?? 0,
      bad_total: rows.length,
      empty_reason: rows.length === 0 ? 'за окно ни одной плохой оценки: либо всё хорошо, либо оценщик не писал (смотри outcomes_total)' : null,
      by_score: count((r) => (r.score === null ? 'без балла' : String(r.score))),
      by_surface: count((r) => r.surface ?? 'не записана'),
      by_provider: count((r) => r.provider ?? 'не записан'),
      by_path: count((r) => r.answer_path ?? 'не записан'),
      clusters: clusterOutcomes(rows),
      caveats: [
        'Сохраняется не всё: оценка ниже 7, незаземлённый ответ или каждый десятый хороший; потолок оценок 300 в сутки.',
        'Одна запись может попасть в несколько типов: у судьи бывает несколько проблем.',
        'Примеры — формулировки судьи без ПД; вопросы и ответы не отдаются.',
      ],
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[kuzmich-bad-outcomes] чтение не удалось:', typeof code === 'string' ? `SQLSTATE=${code}` : '', err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, error: 'свод не прочитался', sqlstate: typeof code === 'string' ? code : null }, { status: 502 });
  }
}
