/**
 * GET /api/cron/kuzmich-quality-census?days=30 — чем и как отвечал Кузьмич,
 * по дням. Bearer CRON_SECRET. Только читает.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Владелец 13.10: «понять, почему Кузьмич периодически деградирует». Ответ
 * прячется в том, КЕМ и КАКИМ путём сделан ответ: цикл с инструментами
 * (DeepSeek → Qwen → xAI → OpenRouter) или запасной путь БЕЗ инструментов —
 * гонка водопада, где побеждает самая быстрая модель. Это происхождение
 * пишется с #1730 (lib/agents/managed/kuzmich-outcomes: provider,
 * answer_path, prompt_fingerprint, grounding) — и не читалось НИКЕМ.
 * Объявленный исход без потребителя (CLAUDE.md, 10.09): данные, которые
 * прямо отвечают на вопрос, лежали, а смотреть их было нечем.
 *
 * ── Чего здесь нет намеренно ───────────────────────────────────────────────
 *
 * Текстов вопросов и ответов, chat_id и имён: только числа. Средний балл —
 * по СОХРАНЁННЫМ оценкам, а сохраняется не всё: оценка ниже 7, незаземлённый
 * ответ или каждый десятый хороший (kuzmich-outcomes, shouldSave). Поэтому
 * абсолютный средний занижен, а сравнивать можно доли МЕЖДУ днями и путями,
 * не баллы с внешним миром. Пишут Telegram, MAX и сайт, а с 22.10 (один выход
 * ответа, аудит 1.14) — стрим сайта и A2A; виджет партнёра оценке не
 * отдаётся. Это сказано в ответе словами, разрез — by_surface.
 *
 * ── Попытки оценки (#3179, слово владельца 19.11 «1 да») ───────────────────
 *
 * Свод выше видит только сохранённые оценки. Неделя 10–16.11 прошла без
 * единой записи, и по своду нельзя было сказать, звали ли оценщика вообще.
 * Место под оценку (kuzmich-outcomes, takeGradeSlot) пишет строку
 * ai_actions_log ('kuzmich_grade') ДО вызова судьи, а с 19.11 — и исход
 * попытки. `attempts_by_day` считает эти строки: сколько раз звали, сколько
 * сохранено, сколько хороших не попало в выборку, сколько раз судья ответил
 * не тем и сколько упало. У строк до 19.11 исход «не записан».
 *
 * Сторож: tests/unit/kuzmich-quality-census-route.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw === null ? def : parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Строка свода: день или итог по пути и провайдеру (или по поверхности). */
export interface QualityRow {
  day?: string;
  surface?: string;
  answer_path: string;
  provider: string;
  outcomes: number;
  refusals: number;
  graded: number;
  avg_score: number | null;
  low_scores: number;
  ungrounded: number;
  prompts: number;
}

/**
 * Балл живёт в заголовке записи («Оценка ответа: 7/10»), не в metadata:
 * так его пишет kuzmich-outcomes. Отказ модели балла не имеет и считается
 * отдельно (outcome_kind = 'refusal').
 */
const BASE = `
  WITH o AS (
    SELECT created_at,
           COALESCE(metadata->>'answer_path', 'не записан') AS answer_path,
           COALESCE(metadata->>'provider', 'не записан')    AS provider,
           COALESCE(metadata->>'surface', 'не записана')    AS surface,
           metadata->>'outcome_kind'                         AS outcome_kind,
           metadata->>'grounding'                            AS grounding,
           metadata->>'prompt_fingerprint'                   AS prompt_fingerprint,
           NULLIF(substring(title from 'Оценка ответа: ([0-9]+)/10'), '')::int AS score
      FROM agent_knowledge
     WHERE type = 'outcome' AND agent_id = 'kuzmich'
       AND created_at > NOW() - ($1::int * INTERVAL '1 day')
  )`;

/** Попытки оценки за день по Камчатке — строки журнала места под оценку. */
export interface AttemptRow {
  day: string;
  attempts: number;
  saved: number;
  good_not_saved: number;
  /** Судья ответил не тем: пусто, без JSON или без балла. */
  judge_no_answer: number;
  failed: number;
  /** Исход не записан: строки до 19.11 или отказ записи исхода. */
  not_recorded: number;
}

/** Исходы попыток — из того же журнала, что держит потолок оценок. */
export const ATTEMPTS_BY_DAY_SQL = `
  SELECT to_char((created_at AT TIME ZONE 'Asia/Kamchatka')::date, 'YYYY-MM-DD') AS day,
         COUNT(*)::int                                                               AS attempts,
         COUNT(*) FILTER (WHERE metadata->>'result' = 'saved')::int                 AS saved,
         COUNT(*) FILTER (WHERE metadata->>'result' = 'good_not_saved')::int        AS good_not_saved,
         COUNT(*) FILTER (WHERE metadata->>'result' IN ('judge_empty', 'judge_no_json', 'judge_no_score'))::int AS judge_no_answer,
         COUNT(*) FILTER (WHERE metadata->>'result' = 'failed')::int                AS failed,
         COUNT(*) FILTER (WHERE metadata->>'result' IS NULL)::int                   AS not_recorded
    FROM ai_actions_log
   WHERE action_type = 'kuzmich_grade'
     AND created_at > NOW() - ($1::int * INTERVAL '1 day')
   GROUP BY 1
   ORDER BY 1 DESC`;

const AGG = `
         COUNT(*)::int                                                  AS outcomes,
         COUNT(*) FILTER (WHERE outcome_kind = 'refusal')::int          AS refusals,
         COUNT(score)::int                                              AS graded,
         ROUND(AVG(score)::numeric, 1)::float                           AS avg_score,
         COUNT(*) FILTER (WHERE score < 6)::int                         AS low_scores,
         COUNT(*) FILTER (WHERE grounding = 'ungrounded')::int          AS ungrounded,
         COUNT(DISTINCT prompt_fingerprint)::int                        AS prompts`;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const days = clampInt(request.nextUrl.searchParams.get('days'), 30, 1, 365);

  try {
    // Интервал — параметром с приведением, не конкатенацией (sql-interval-not-concatenated).
    const [byDay, totals, bySurface, attempts] = await Promise.all([
      pool.query<QualityRow>(
        `${BASE}
         SELECT to_char((created_at AT TIME ZONE 'Asia/Kamchatka')::date, 'YYYY-MM-DD') AS day,
                answer_path, provider, ${AGG}
           FROM o
          GROUP BY 1, 2, 3
          ORDER BY 1 DESC, outcomes DESC`,
        [days],
      ),
      pool.query<QualityRow>(
        `${BASE}
         SELECT answer_path, provider, ${AGG}
           FROM o
          GROUP BY 1, 2
          ORDER BY outcomes DESC`,
        [days],
      ),
      // Разрез по поверхности (аудит 15.10, 1.14): сайт, стрим, A2A и
      // мессенджеры пишут оценки в одно место, и «на сайте хуже» без разреза
      // не увидеть. Записи до 16.10 поверхность не несут — «не записана».
      pool.query<QualityRow>(
        `${BASE}
         SELECT surface, 'все' AS answer_path, 'все' AS provider, ${AGG}
           FROM o
          GROUP BY 1
          ORDER BY outcomes DESC`,
        [days],
      ),
      pool.query<AttemptRow>(ATTEMPTS_BY_DAY_SQL, [days]),
    ]);
    const total = totals.rows.reduce((s, r) => s + r.outcomes, 0);
    const waterfall = totals.rows.filter((r) => r.answer_path === 'waterfall').reduce((s, r) => s + r.outcomes, 0);
    const attemptsTotal = attempts.rows.reduce((s, r) => s + r.attempts, 0);
    return NextResponse.json({
      ok: true,
      days,
      outcomes_total: total,
      // Ноль записей за окно — не «Кузьмич хорош» (§4.0): словами, а не нулями
      // в таблице. Попытки говорят, звали ли оценщика вообще.
      empty_reason: total > 0 ? null
        : attemptsTotal === 0
          ? 'за окно ни одной записи оценки и ни одной попытки: оцениваемых ответов не было'
          : `за окно ни одной записи оценки при ${attemptsTotal} попытках: исходы попыток — в attempts_by_day`,
      attempts_total: attemptsTotal,
      attempts_by_day: attempts.rows,
      waterfall_share: total > 0 ? Math.round((waterfall / total) * 1000) / 1000 : null,
      totals: totals.rows,
      by_surface: bySurface.rows,
      by_day: byDay.rows,
      caveats: [
        'Пишут Telegram, MAX и сайт, а с 22.10 — стрим сайта и A2A; виджет партнёра оценке не отдаётся. Поверхность — в by_surface; записи до 16.10 её не несут.',
        'Сохраняется не всё: оценка ниже 7, незаземлённый ответ или каждый десятый хороший — абсолютный средний балл занижен, сравнимы доли между днями и путями.',
        'answer_path: tools — цикл с инструментами; waterfall — запасной путь без инструментов (гонка водопада).',
        'attempts_by_day — каждый вызов судьи (потолок 300 в сутки по Камчатке): сохранено, хороший не попал в выборку, судья ответил не тем, упало. Исход пишется с 19.11; у прежних строк он «не записан» (not_recorded).',
      ],
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[kuzmich-quality-census] чтение не удалось:', typeof code === 'string' ? `SQLSTATE=${code}` : '', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, error: 'перепись не прочиталась', sqlstate: typeof code === 'string' ? code : null },
      { status: 502 },
    );
  }
}
