/**
 * lib/kuzmich/answer-timing.ts — сколько человек ждёт ответа Кузьмича
 * (аудит 15.10, A19, пункт 1.13 дорожной карты, находка P3-11).
 *
 * Время ответа не записывалось нигде, и худший случай (100–150 с) был
 * оценкой. Теперь каждый ответ на четырёх поверхностях (веб `/api/ai/chat`,
 * Telegram, MAX, виджет партнёра) пишет одну строку в существующий журнал
 * `ai_actions_log` (action_type `kuzmich_answer`): сколько ждали, сколько
 * ходов сделал цикл, каким путём и кем произведён ответ. Без новой таблицы: у
 * журнала уже есть индекс (action_type, created_at). Ни текста, ни id чата,
 * ни имени — только числа и имя пути (pd-guard). Читает — перепись
 * `GET /api/cron/kuzmich-load-census` (p50/p95 по поверхностям); по p95 потолок
 * цикла (lib/kuzmich/answer-ceiling) снижается после недели данных.
 */

import { pool } from '@/lib/db-pool';
import { KUZMICH_ANSWER_ACTION, KUZMICH_ANSWER_CEILING_MS, type LoopTokens } from '@/lib/kuzmich/answer-ceiling';
import { stallMetadata, type LoopStall } from '@/lib/kuzmich/loop-stall';

/** Где прозвучал ответ. */
export type AnswerSurface = 'web' | 'web-stream' | 'telegram' | 'max' | 'widget' | 'a2a' | 'other';

/**
 * Каким путём произведён ответ: цикл инструментов, запасной водопад после
 * него, агент брони веб-чата, одиночный вызов модели (виджет, запасной путь
 * веб-чата).
 */
export type AnswerPath = 'tools' | 'waterfall' | 'sdk' | 'single';

export interface KuzmichAnswerRecord {
  surface: AnswerSurface;
  /** От входа в цикл (или в вызов модели там, где цикла нет) до готового ответа, мс. */
  elapsedMs: number;
  /** Ходы модели. null — путь их не считает (агент брони), «не записано» ≠ 0. */
  turns: number | null;
  /** Раунды инструментов. null — как у `turns`. */
  toolRounds: number | null;
  path: AnswerPath | null;
  provider: string | null;
  ceilingHit: boolean;
  /**
   * Расход ходов цикла (шаг 0 разбора 29.10). null/нет — цикл модели не звал
   * или путь его не считает: ключей в замере нет, и перепись не примет это
   * за ноль.
   */
  tokens?: LoopTokens | null;
  /**
   * Признаки застревания цикла (lib/kuzmich/loop-stall). null/нет — цикл не
   * ходил: ключей в замере нет, линза застреваний такой ответ не считает.
   */
  stall?: LoopStall | null;
}

/** Числа расхода для metadata замера — только числа, без слов реплик (pd-guard). */
function tokenMetadata(t: LoopTokens | null | undefined): Record<string, number | null> {
  if (!t) return {};
  return {
    input_tokens: t.inputTokens,
    max_call_input_tokens: t.maxCallInputTokens,
    completion_tokens: t.completionTokens,
    // Ни один ход кэш не назвал — «не знаю», а не «кэша не было».
    cache_read_tokens: t.cacheReportedCalls > 0 ? t.cacheReadTokens : null,
    usage_calls: t.reportedCalls,
    usage_unreported_calls: t.unreportedCalls,
  };
}

export const RECORD_KUZMICH_ANSWER_SQL =
  `INSERT INTO ai_actions_log (action_type, provider, metadata) VALUES ($1, $2, $3::jsonb)`;

/**
 * Записать замер ответа. Одна функция на все поверхности. Отказ записи не
 * роняет ответ человеку и не глушится: SQLSTATE — в лог (§4.0), иначе
 * сломанная запись неотличима от «Кузьмичу никто не пишет».
 */
export async function recordKuzmichAnswer(rec: KuzmichAnswerRecord): Promise<void> {
  try {
    await pool.query(RECORD_KUZMICH_ANSWER_SQL, [
      KUZMICH_ANSWER_ACTION,
      rec.provider,
      JSON.stringify({
        surface: rec.surface,
        elapsed_ms: Math.max(0, Math.round(rec.elapsedMs)),
        turns: rec.turns,
        tool_rounds: rec.toolRounds,
        path: rec.path,
        ceiling_hit: rec.ceilingHit,
        ceiling_ms: KUZMICH_ANSWER_CEILING_MS,
        ...tokenMetadata(rec.tokens),
        ...stallMetadata(rec.stall),
      }),
    ]);
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    console.error('[kuzmich-answer-timing] замер ответа не записан', {
      surface: rec.surface,
      sqlstate: typeof e?.code === 'string' ? e.code : 'нет кода',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
