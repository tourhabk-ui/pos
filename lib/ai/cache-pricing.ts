/**
 * lib/ai/cache-pricing.ts
 *
 * Вход с кэшем подсказок — во «входо-эквиваленте»: сколько обычных входных
 * токенов он стоит. Аудит 15.10, находка AC-1.
 *
 * Зачем. «Руки» (claude-code-action в claude.yml, issue-triage, ci-sweeper,
 * weekly-chronicle) считают на раннере ключом Anthropic, и их расход до книг
 * `llm_usage_log` не доходил вовсе. Довезти одни вход и выход мало: по разбору
 * счёта 21.08–19.09 (CLAUDE.md §5.1) 70% денег Anthropic — кэш, а не работа
 * модели. Книги без кэша занизили бы расход рук в разы, и дневной бюджет
 * (`/api/cron/llm-budget-check`) снова складывал бы не то, что тратится.
 *
 * Почему эквивалент, а не своя формула цены. Кэш у Anthropic оплачивается
 * долей ЦЕНЫ ВХОДА — значит запись и чтение кэша можно выразить входными
 * токенами и отдать в `resolveCostUsd` вместе с обычным входом. Цену при этом
 * по-прежнему называет один источник — каталог моделей (или запасная таблица
 * с её пометкой `cost_table_fallback`), — а не третий, придуманный здесь.
 *
 * Множители — документация Anthropic, «Prompt caching → Pricing»: запись в
 * 5-минутный кэш — 1,25 цены входа, в часовой — 2, чтение — 0,1. Те же числа
 * записаны в CLAUDE.md §5.1 при разборе счёта 19.09.
 *
 * Чего здесь НЕ знаем, и куда это ведёт:
 *   - сводка экшена (`modelUsage`) не делит запись в кэш по сроку жизни.
 *     Берём 5-минутный — срок по умолчанию. Если рука писала в часовой, книги
 *     ЗАНИЖАЮТ запись (1,25 против 2);
 *   - у части новых моделей чтение кэша дешевле 0,1 (в документации — вдвое и
 *     вчетверо). Для них книги ЗАВЫШАЮТ чтение.
 *   Оба расхождения видны глазами: шаг учёта печатает в сводку прогона рядом
 *   цену книг и `total_cost_usd`, заявленную самим экшеном, и предупреждает,
 *   когда они расходятся. В книги заявление экшена не пишется: книги для того
 *   и нужны, чтобы проверять заявления, а не переписывать их.
 */

/** Запись в 5-минутный кэш — доля цены входа (документация Anthropic, Prompt caching). */
export const ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER = 1.25;

/** Чтение из кэша — доля цены входа (документация Anthropic, Prompt caching). */
export const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;

export interface PromptCacheTokens {
  /** Записано в кэш. null — источник не сообщил (это не ноль). */
  creation: number | null;
  /** Прочитано из кэша. null — источник не сообщил (это не ноль). */
  read: number | null;
}

/**
 * Модель вызвана у Anthropic. Ключ журнала несёт вендора префиксом:
 * `anthropic:<модель>` (прямой вызов) или `anthropic/<модель>` (слаг каталога).
 * Судим по вендору, а не по имени модели: имя меняется с каждым выпуском.
 */
export function isAnthropicLogKey(model: string): boolean {
  return /^anthropic[:/]/.test(model);
}

/**
 * Сколько обычных входных токенов стоит вход вместе с кэшем.
 *
 * null — кэш есть, а множителей вендора мы не знаем: цена такой строки —
 * честное «не знаем» (§4.0), а не вход без кэша, выданный за полную цену.
 */
export function inputEquivalentTokens(
  model: string,
  promptTokens: number,
  cache: PromptCacheTokens,
): number | null {
  const creation = cache.creation ?? 0;
  const read = cache.read ?? 0;
  if (creation === 0 && read === 0) return promptTokens;
  if (!isAnthropicLogKey(model)) return null;
  return (
    promptTokens
    + creation * ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER
    + read * ANTHROPIC_CACHE_READ_MULTIPLIER
  );
}
