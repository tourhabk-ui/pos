/**
 * GET /api/cron/kuzmich-load-census?days=30 — сколько обращений к Кузьмичу и
 * сколько они стоят. Bearer CRON_SECRET. Только читает.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Issue #1995 предлагает ставить перед Кузьмичом дешёвый роутер намерений:
 * простые вопросы — в SQL и шаблон, сложные — в полный цикл модели. Роутер
 * экономит деньги пропорционально объёму, и прежде чем его строить, надо знать
 * две вещи, которых не знал никто: сколько людей Кузьмичу вообще пишет и
 * сколько он стоит. Десять обращений в день роутер не окупят ничем.
 *
 * ── Чего здесь нет намеренно ───────────────────────────────────────────────
 *
 * Доли «простых» вопросов нет. Единственное место, где записано, звал ли
 * ответ инструменты, — `agent_knowledge (type='outcome')`, и выборка там
 * смещена дважды: туда попадают только вопросы с ключевыми словами о местах
 * (`isGradableQuestion`) и только плохие, незаземлённые или каждый десятый
 * хороший ответ (`kuzmich-outcomes.ts`). Посчитать по ней долю простых значило
 * бы выдать смещённую выборку за картину (§4.0). Короткие сообщения
 * считаются — но это мера длины, а не намерения, и называется так.
 *
 * Текстов, chat_id и имён в ответе нет: только числа. Переписка хранится
 * сырой, и перепись не должна становиться ещё одной дверью к ней.
 *
 * Приговора тоже нет: «строить роутер или нет» решает человек по числам.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret, diagnoseCronAuth } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { KUZMICH_ANSWER_ACTION } from '@/lib/kuzmich/answer-ceiling';
import { TOOLS_LOOP_AGENT_ID } from '@/lib/ai/provider-usage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/** Граница «короткого» сообщения: «привет», «спасибо», «да, давай». */
export const SHORT_MESSAGE_MAX_CHARS = 20;

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw === null ? def : parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Раздел переписи: либо данные, либо отказ словами — не пустота (§4.0). */
type Section<T> = { refused: false; data: T } | { refused: true; error: string };

async function section<T>(name: string, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { refused: false, data: await run() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[kuzmich-load-census] ${name}: чтение не удалось:`, error);
    return { refused: true, error };
  }
}

type KuzmichUsageRow = {
  provider: string | null; is_total: boolean; calls: number;
  p50_input_tokens: number | null; p95_input_tokens: number | null; max_input_tokens: number | null;
  input_tokens: number; cache_read_tokens: number | null; cache_reported_calls: number;
  input_tokens_where_cache_reported: number | null; completion_tokens: number;
};

/** Доля кэша — только по вызовам, где провайдер кэш назвал; не назвал никто — null. */
function cacheShare(r: KuzmichUsageRow): number | null {
  if (r.cache_reported_calls === 0 || !r.input_tokens_where_cache_reported) return null;
  return Math.round(((r.cache_read_tokens ?? 0) / r.input_tokens_where_cache_reported) * 1000) / 1000;
}

/**
 * Расход цикла Кузьмича из строк ROLLUP. Ноль строк — честное «учёт ещё
 * пуст», а не нули: нули читались бы как «Кузьмич не тратил».
 */
function summarizeKuzmichUsage(rows: KuzmichUsageRow[]):
  | { empty: true; note: string }
  | { empty: false; total: Record<string, number | null>; by_provider: Array<Record<string, string | number | null>> } {
  const total = rows.find((r) => r.is_total);
  if (!total || total.calls === 0) {
    return {
      empty: true,
      note: 'учёт ещё пуст: ноги цикла инструментов пишут расход с 29.10, строк kuzmich в окне нет',
    };
  }
  const describe = (r: KuzmichUsageRow) => ({
    calls: r.calls,
    p50_input_tokens: r.p50_input_tokens,
    p95_input_tokens: r.p95_input_tokens,
    max_input_tokens: r.max_input_tokens,
    completion_tokens: r.completion_tokens,
    cache_read_share: cacheShare(r),
    calls_cache_unknown: r.calls - r.cache_reported_calls,
  });
  return {
    empty: false,
    total: describe(total),
    by_provider: rows
      .filter((r) => !r.is_total)
      .map((r) => ({
        provider: r.provider ?? '(провайдер не записан)',
        share_of_calls: Math.round((r.calls / total.calls) * 1000) / 1000,
        ...describe(r),
      })),
  };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized', ...diagnoseCronAuth(request) }, { status: 401 });
  }

  const days = clampInt(request.nextUrl.searchParams.get('days'), 30, 1, 365);

  // Интервал — параметром с приведением, не конкатенацией (sql-interval-not-concatenated).
  const [telegramMax, telegramMaxDaily, web, llm, llmUntrackedModels, kuzmichUsage, answerTime] = await Promise.all([
    // Telegram и MAX через общий мозг lib/kuzmich/core.ts (saveMsg).
    section('tg_conversations', async () => {
      const { rows } = await pool.query<{
        platform: string | null; mode: string | null;
        user_messages: number; assistant_messages: number; chats: number;
        short_user_messages: number; first: string | null; last: string | null;
      }>(
        `SELECT platform, mode,
                COUNT(*) FILTER (WHERE role = 'user')::int                              AS user_messages,
                COUNT(*) FILTER (WHERE role = 'assistant')::int                         AS assistant_messages,
                COUNT(DISTINCT chat_id) FILTER (WHERE role = 'user')::int               AS chats,
                COUNT(*) FILTER (WHERE role = 'user'
                                   AND char_length(content) <= $2::int)::int            AS short_user_messages,
                MIN(created_at)::text AS first,
                MAX(created_at)::text AS last
           FROM tg_conversations
          WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY platform, mode
          ORDER BY user_messages DESC`,
        [days, SHORT_MESSAGE_MAX_CHARS],
      );
      // NULL — своим именем: «канал не записан» не равно «telegram».
      return rows.map((r) => ({
        ...r,
        platform: r.platform ?? '(platform не записан)',
        mode: r.mode ?? '(mode не записан)',
      }));
    }),

    // По дням — без админ-чата: там пишет владелец, а не турист.
    section('tg_conversations по дням', async () => {
      const { rows } = await pool.query<{ day: string; user_messages: number; chats: number }>(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                COUNT(*)::int                AS user_messages,
                COUNT(DISTINCT chat_id)::int AS chats
           FROM tg_conversations
          WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
            AND role = 'user'
            AND mode IS DISTINCT FROM 'admin'
          GROUP BY 1
          ORDER BY 1`,
        [days],
      );
      return rows;
    }),

    // Веб и виджет пишут сюда. Оба входа Telegram с TG-BRAIN (15.10) пишут
    // историю в tg_conversations через общий мозг, а не сюда.
    // Канала в таблице нет — различить их по ней нельзя, и это сказано ниже.
    section('chat_sessions', async () => {
      const { rows } = await pool.query<{
        role: string | null; sessions: number;
        user_messages_lifetime: number; sessions_without_user_message: number;
      }>(
        `SELECT role,
                COUNT(*)::int                                         AS sessions,
                COALESCE(SUM(user_message_count), 0)::int             AS user_messages_lifetime,
                COUNT(*) FILTER (WHERE user_message_count = 0)::int   AS sessions_without_user_message
           FROM chat_sessions
          WHERE updated_at > NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY role
          ORDER BY sessions DESC`,
        [days],
      );
      return rows.map((r) => ({ ...r, role: r.role ?? '(role не записан)' }));
    }),

    // Расход. SUM пропускает NULL молча — неизвестная цена считается отдельно
    // (комментарий колонки, миграция 961).
    //
    // Три корзины, а не две. До 29.10 строки без agent_id назывались «верхней
    // границей расхода Кузьмича» — и это было неверно: цикл инструментов, его
    // главный путь, в книги не писал вовсе, так что граница не ограничивала
    // ничего. Теперь ноги цикла пишут agent_id = 'kuzmich'.
    section('llm_usage_log', async () => {
      const { rows } = await pool.query<{
        bucket: 'kuzmich' | 'other_agent' | 'no_agent'; calls: number; tokens: number;
        known_cost_usd: number | null; calls_unknown_price: number;
      }>(
        `SELECT CASE WHEN agent_id = $2 THEN 'kuzmich'
                     WHEN agent_id IS NULL THEN 'no_agent'
                     ELSE 'other_agent' END                                  AS bucket,
                COUNT(*)::int                                               AS calls,
                COALESCE(SUM(total_tokens), 0)::float8                      AS tokens,
                SUM(estimated_cost_usd)::float8                             AS known_cost_usd,
                COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int     AS calls_unknown_price
           FROM llm_usage_log
          WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY 1`,
        [days, TOOLS_LOOP_AGENT_ID],
      );
      // Строки нет — вызовов не было, и потрачено ровно ноль: это известный
      // ноль, не «цена неизвестна». null остаётся только за SUM по строкам,
      // у которых у всех цена NULL.
      const pick = (bucket: string) => {
        const r = rows.find((x) => x.bucket === bucket);
        return r
          ? { calls: r.calls, tokens: r.tokens, known_cost_usd: r.known_cost_usd, calls_unknown_price: r.calls_unknown_price }
          : { calls: 0, tokens: 0, known_cost_usd: 0, calls_unknown_price: 0 };
      };
      return {
        /** Цикл инструментов Кузьмича (agent_id 'kuzmich'): сайт, Telegram, MAX, A2A, Кузьмич партнёра. */
        kuzmich_tools_loop: pick('kuzmich'),
        /** С иным agent_id: кроны, судья эволюции, ревью, эвал. */
        attributed_to_other_agents: pick('other_agent'),
        /** Без agent_id: запасной водопад Кузьмича, виджет и всё прочее без учёта агента — вперемешку. */
        without_agent: pick('no_agent'),
      };
    }),

    section('llm_usage_log по моделям (без agent_id)', async () => {
      const { rows } = await pool.query<{
        model: string; calls: number; known_cost_usd: number | null; calls_unknown_price: number;
      }>(
        `SELECT route                                                       AS model,
                COUNT(*)::int                                               AS calls,
                SUM(estimated_cost_usd)::float8                             AS known_cost_usd,
                COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int     AS calls_unknown_price
           FROM llm_usage_log
          WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
            AND agent_id IS NULL
          GROUP BY route
          ORDER BY calls DESC
          LIMIT 10`,
        [days],
      );
      return rows;
    }),

    // Расход цикла инструментов по вызовам (шаг 0 разбора 29.10): сколько весит
    // ход, сколько из него прочитано из кэша и кто отвечал. Строка книг —
    // один вызов модели. Вход целиком = prompt_tokens + cache_read_tokens:
    // прочитанное из кэша лежит в своей колонке (миграция 1285). Провайдер —
    // вендор ключа (`deepseek:`, `qwen:`, `x-ai:`); ключ без двоеточия — слаг
    // OpenRouter (`vendor/model`), так их пишут ноги цикла (lib/ai/providers).
    section('расход цикла Кузьмича', async () => {
      const { rows } = await pool.query<{
        provider: string | null; is_total: boolean; calls: number;
        p50_input_tokens: number | null; p95_input_tokens: number | null; max_input_tokens: number | null;
        input_tokens: number; cache_read_tokens: number | null; cache_reported_calls: number;
        input_tokens_where_cache_reported: number | null; completion_tokens: number;
      }>(
        `SELECT CASE WHEN position(':' in route) > 0 THEN split_part(route, ':', 1)
                     ELSE 'openrouter' END                                   AS provider,
                (GROUPING(CASE WHEN position(':' in route) > 0 THEN split_part(route, ':', 1)
                               ELSE 'openrouter' END) = 1)                   AS is_total,
                COUNT(*)::int                                               AS calls,
                percentile_cont(0.5)  WITHIN GROUP (ORDER BY prompt_tokens + COALESCE(cache_read_tokens, 0)) AS p50_input_tokens,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY prompt_tokens + COALESCE(cache_read_tokens, 0)) AS p95_input_tokens,
                MAX(prompt_tokens + COALESCE(cache_read_tokens, 0))::float8 AS max_input_tokens,
                COALESCE(SUM(prompt_tokens + COALESCE(cache_read_tokens, 0)), 0)::float8 AS input_tokens,
                SUM(cache_read_tokens)::float8                              AS cache_read_tokens,
                COUNT(cache_read_tokens)::int                               AS cache_reported_calls,
                SUM(prompt_tokens + cache_read_tokens)::float8              AS input_tokens_where_cache_reported,
                COALESCE(SUM(completion_tokens), 0)::float8                 AS completion_tokens
           FROM llm_usage_log
          WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
            AND agent_id = $2
          GROUP BY ROLLUP (1)
          ORDER BY is_total DESC, calls DESC`,
        [days, TOOLS_LOOP_AGENT_ID],
      );
      return summarizeKuzmichUsage(rows);
    }),

    // Сколько человек ждёт ответа (аудит 15.10, A19): замер пишет
    // lib/kuzmich/answer-timing на четырёх поверхностях. По p95 отсюда
    // потолок цикла (KUZMICH_ANSWER_CEILING_MS) снижается после недели данных.
    section('время ответа', async () => {
      const { rows } = await pool.query<{
        surface: string | null; path: string | null; answers: number;
        p50_ms: number | null; p95_ms: number | null; max_ms: number | null;
        avg_turns: number | null; ceiling_hits: number;
        answers_with_tokens: number; answers_tokens_partial: number;
        p50_input_tokens: number | null; p95_input_tokens: number | null; p95_max_call_input_tokens: number | null;
      }>(
        `SELECT metadata->>'surface'                                                  AS surface,
                metadata->>'path'                                                     AS path,
                COUNT(*)::int                                                         AS answers,
                percentile_cont(0.5)  WITHIN GROUP (ORDER BY (metadata->>'elapsed_ms')::float8) AS p50_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (metadata->>'elapsed_ms')::float8) AS p95_ms,
                MAX((metadata->>'elapsed_ms')::float8)                                AS max_ms,
                AVG((metadata->>'turns')::float8)                                     AS avg_turns,
                COUNT(*) FILTER (WHERE (metadata->>'ceiling_hit')::boolean)::int     AS ceiling_hits,
                -- Вход ответа (сумма ходов) и самый тяжёлый ход — шаг 0 разбора
                -- 29.10. Только ответы, где usage отдал КАЖДЫЙ ход: неполная
                -- сумма занизила бы перцентиль; такие посчитаны отдельно.
                COUNT(*) FILTER (WHERE (metadata->>'usage_calls')::int > 0
                                   AND (metadata->>'usage_unreported_calls')::int = 0)::int AS answers_with_tokens,
                COUNT(*) FILTER (WHERE (metadata->>'usage_unreported_calls')::int > 0)::int AS answers_tokens_partial,
                percentile_cont(0.5)  WITHIN GROUP (ORDER BY (metadata->>'input_tokens')::float8)
                  FILTER (WHERE (metadata->>'usage_calls')::int > 0
                            AND (metadata->>'usage_unreported_calls')::int = 0)        AS p50_input_tokens,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (metadata->>'input_tokens')::float8)
                  FILTER (WHERE (metadata->>'usage_calls')::int > 0
                            AND (metadata->>'usage_unreported_calls')::int = 0)        AS p95_input_tokens,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (metadata->>'max_call_input_tokens')::float8)
                  FILTER (WHERE (metadata->>'usage_calls')::int > 0)                   AS p95_max_call_input_tokens
           FROM ai_actions_log
          WHERE action_type = $2
            AND created_at > NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY 1, 2
          ORDER BY answers DESC`,
        [days, KUZMICH_ANSWER_ACTION],
      );
      // NULL — своим именем: «путь не записан» не равно «цикл».
      return rows.map((r) => ({
        ...r,
        surface: r.surface ?? '(поверхность не записана)',
        path: r.path ?? '(путь не записан)',
      }));
    }),
  ]);

  const sections = {
    telegram_max: telegramMax, telegram_max_daily: telegramMaxDaily, web, llm,
    llm_untracked_models: llmUntrackedModels, kuzmich_usage: kuzmichUsage, answer_time: answerTime,
  };
  const refused = Object.entries(sections).filter(([, s]) => s.refused).map(([k]) => k);

  return NextResponse.json(
    {
      success: refused.length === 0,
      window_days: days,
      short_message_max_chars: SHORT_MESSAGE_MAX_CHARS,
      refused_sections: refused,
      ...sections,
      caveats: [
        'Расход Кузьмича в книгах — его цикл инструментов (agent_id kuzmich), пишется с 29.10; строк до этого дня нет, и «учёт ещё пуст» значит «не накопилось», а не «Кузьмич не тратил». Запасной водопад Кузьмича и виджет пишутся без agent_id вперемешку со всем прочим — ни верхней, ни нижней границей расхода Кузьмича эта корзина не служит.',
        'Цена строки с прочитанным кэшем у вендоров, кроме Anthropic, — «неизвестна»: скидку за кэш у них книги не знают и не выдумывают (lib/ai/cache-pricing).',
        'chat_sessions.user_message_count — счётчик за всю жизнь сессии; сессия, обновлённая в окне, несёт и сообщения до окна. Это оценка сверху.',
        'chat_sessions не различает канал: туда пишут веб-чат и виджет. Оба входа Telegram с 15.10 (TG-BRAIN) пишут в tg_conversations; строки tg_ в chat_sessions — история до перевода (миграция 1287 скопировала её туда).',
        'Время ответа (answer_time) пишется с 15.10 (аудит A19): строк меньше, чем обращений, за дни до замера. Нет строк — замер ещё не накопился, а не «ответы мгновенные». Агент брони веб-чата ходов не считает: turns у него null и в среднее не входит.',
        `«Короткое» — мера длины (не длиннее ${SHORT_MESSAGE_MAX_CHARS} знаков), а не намерения. Доли простых вопросов перепись не считает: единственная запись об инструментах (agent_knowledge, type=outcome) смещена фильтром по ключевым словам и по баллу.`,
      ],
    },
    // Отказ любой части — не «данных нет», а «не смогли прочитать».
    { status: refused.length === 0 ? 200 : 502 },
  );
}
