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
  const [telegramMax, telegramMaxDaily, web, llm, llmUntrackedModels] = await Promise.all([
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

    // Веб, виджет и второй вход Telegram (/api/telegram/webhook) пишут сюда.
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
    section('llm_usage_log', async () => {
      const { rows } = await pool.query<{
        untracked: boolean; calls: number; tokens: number;
        known_cost_usd: number | null; calls_unknown_price: number;
      }>(
        `SELECT (agent_id IS NULL)                                          AS untracked,
                COUNT(*)::int                                               AS calls,
                COALESCE(SUM(total_tokens), 0)::float8                      AS tokens,
                SUM(estimated_cost_usd)::float8                             AS known_cost_usd,
                COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int     AS calls_unknown_price
           FROM llm_usage_log
          WHERE created_at > NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY 1`,
        [days],
      );
      // Строки нет — вызовов не было, и потрачено ровно ноль: это известный
      // ноль, не «цена неизвестна». null остаётся только за SUM по строкам,
      // у которых у всех цена NULL.
      const pick = (untracked: boolean) => rows.find((r) => r.untracked === untracked) ?? {
        calls: 0, tokens: 0, known_cost_usd: 0, calls_unknown_price: 0,
      };
      const strip = ({ calls, tokens, known_cost_usd, calls_unknown_price }: {
        calls: number; tokens: number; known_cost_usd: number | null; calls_unknown_price: number;
      }) => ({ calls, tokens, known_cost_usd, calls_unknown_price });
      return {
        /** Без agent_id: живой Кузьмич И всё прочее, что зовёт модель без трекинга. */
        untracked_upper_bound_for_kuzmich: strip(pick(true)),
        /** С agent_id: кроны, судья эволюции, ревью — не Кузьмич. */
        attributed_to_agents: strip(pick(false)),
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
  ]);

  const sections = { telegram_max: telegramMax, telegram_max_daily: telegramMaxDaily, web, llm, llm_untracked_models: llmUntrackedModels };
  const refused = Object.entries(sections).filter(([, s]) => s.refused).map(([k]) => k);

  return NextResponse.json(
    {
      success: refused.length === 0,
      window_days: days,
      short_message_max_chars: SHORT_MESSAGE_MAX_CHARS,
      refused_sections: refused,
      ...sections,
      caveats: [
        'Расход без agent_id — ВЕРХНЯЯ граница расхода Кузьмича, а не его расход: живые запросы Кузьмича пишутся без agent_id вместе со всем прочим, что зовёт модель без трекинга (lib/ai/providers.ts, logLLMUsage).',
        'chat_sessions.user_message_count — счётчик за всю жизнь сессии; сессия, обновлённая в окне, несёт и сообщения до окна. Это оценка сверху.',
        'chat_sessions не различает канал: туда пишут веб-чат, виджет и /api/telegram/webhook. Какой из двух входов Telegram живой — видно по тому, в какой таблице есть строки.',
        `«Короткое» — мера длины (не длиннее ${SHORT_MESSAGE_MAX_CHARS} знаков), а не намерения. Доли простых вопросов перепись не считает: единственная запись об инструментах (agent_knowledge, type=outcome) смещена фильтром по ключевым словам и по баллу.`,
      ],
    },
    // Отказ любой части — не «данных нет», а «не смогли прочитать».
    { status: refused.length === 0 ? 200 : 502 },
  );
}
