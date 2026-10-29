/**
 * lib/ai/provider-usage.ts — разбор поля `usage` ответа провайдера в числа
 * книг расхода (`llm_usage_log`).
 *
 * Зачем (разбор «мозг Кузьмича при росте каталога», шаг 0, 29.10). Цикл
 * инструментов Кузьмича — главный путь ответа туристу — не писал в книги ни
 * одной строки: его четыре ноги разбирали в ответе только `choices`. Сколько
 * весит подсказка Кузьмича, было оценкой по формуле, а не замером, и сравнивать
 * модели и архитектуры памяти было не с чем (§4.0, §10.09).
 *
 * Разбор отдельной чистой функцией, потому что формы у провайдеров разные:
 *   - OpenAI-совместимая (OpenRouter, Qwen/DashScope, xAI): `prompt_tokens`,
 *     `completion_tokens`, кэш — `prompt_tokens_details.cached_tokens`;
 *   - DeepSeek: те же два числа и кэш отдельными полями
 *     `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.
 * У обеих форм `prompt_tokens` ВКЛЮЧАЕТ прочитанное из кэша. А в книгах кэш
 * лежит в своей колонке и во вход не входит (миграция 1285: «в total_tokens не
 * входит», цена — `inputEquivalentTokens`). Поэтому вход здесь возвращается
 * БЕЗ кэша, а прочитанное — отдельно. Вход целиком = promptTokens +
 * (cacheReadTokens ?? 0).
 *
 * Кэша не сообщили — `null` («не знаю»), а не ноль: ноль значил бы «провайдер
 * сказал, что кэша не было» (тот же уговор, что у колонки, миграция 1285).
 */

/**
 * Кто тратит, когда цикл инструментов зовут вне учёта агента. Цикл
 * инструментов — путь одного Кузьмича (lib/kuzmich/core.ts — сайт, Telegram,
 * MAX, A2A; lib/kuzmich/operator-chat.ts — Кузьмич партнёра). Внутри
 * `runWithUsageTracking` (эвал, кроны) строка несёт имя того агента: эвал не
 * должен считаться расходом живого Кузьмича.
 */
export const TOOLS_LOOP_AGENT_ID = 'kuzmich';

export interface ParsedUsage {
  /** Вход БЕЗ прочитанного из кэша — как колонка `prompt_tokens` книг. */
  promptTokens: number;
  completionTokens: number;
  /** Прочитано из кэша. null — провайдер не сообщил (это не ноль). */
  cacheReadTokens: number | null;
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

function field(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * Числа книг из `usage` ответа. null — `usage` нет или он не содержит входа и
 * выхода: такую строку честно не записать (вход в книгах NOT NULL), и
 * вызывающий говорит об этом в лог, а не пишет нули.
 */
export function parseProviderUsage(raw: unknown): ParsedUsage | null {
  if (raw === null || typeof raw !== 'object') return null;

  const hit = count(field(raw, 'prompt_cache_hit_tokens'));
  const miss = count(field(raw, 'prompt_cache_miss_tokens'));
  let prompt = count(field(raw, 'prompt_tokens'));
  if (prompt === null && hit !== null && miss !== null) prompt = hit + miss;
  const completion = count(field(raw, 'completion_tokens'));
  if (prompt === null || completion === null) return null;

  // DeepSeek называет попадания своим полем; прочие — в деталях входа.
  let cacheRead = hit ?? count(field(field(raw, 'prompt_tokens_details'), 'cached_tokens'));
  // Кэша больше, чем всего входа, — числа противоречат друг другу. Вход
  // остаётся, кэш — «не знаю», а не вычитание, уводящее вход в минус.
  if (cacheRead !== null && cacheRead > prompt) cacheRead = null;

  return {
    promptTokens: prompt - (cacheRead ?? 0),
    completionTokens: completion,
    cacheReadTokens: cacheRead,
  };
}

/** Вход целиком: без кэша плюс прочитанное из него. */
export function fullInputTokens(u: ParsedUsage): number {
  return u.promptTokens + (u.cacheReadTokens ?? 0);
}
