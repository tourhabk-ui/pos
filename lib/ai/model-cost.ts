/**
 * lib/ai/model-cost.ts
 *
 * Во что обходится НАША работа на данной модели.
 *
 * Зачем не «$ за миллион токенов»: прайс сам по себе ничего не решает. Модель
 * с дорогим выводом и дешёвым входом выигрывает у обратной ровно там, где
 * работа входо-тяжёлая, и проигрывает там, где выходо-тяжёлая. У нас есть и
 * та и другая — судья читает много и отвечает строкой, Editor читает мало и
 * пишет абзац, — и сравнивать их одним числом нельзя. Поэтому админка
 * показывает не прайс, а счёт за наши прогоны.
 *
 * ── Честность чисел ────────────────────────────────────────────────────────
 *
 * Формы ниже — ОЦЕНКА из потолков в коде, а не замер. Каждое число названо
 * вместе с источником (`basis`), и наружу всегда едет `estimated: true`.
 * Настоящий замер станет возможен, когда `callOpenRouterModel` начнёт писать
 * `usage`: сейчас самая дорогая ступень не пишет его вовсе, и в
 * `llm_usage_log` её расхода нет. Пока этого нет, выдавать оценку за факт
 * нельзя — по ней принимают решение о смене модели.
 */

export interface ModelPrice {
  /** $ за миллион входных токенов. `null` — каталог цену не назвал (это НЕ ноль). */
  usdPerMTokIn: number | null;
  usdPerMTokOut: number | null;
}

export interface Workload {
  key: WorkloadKey;
  title: string;
  /** Вызовов за один прогон. */
  calls: number;
  inTokens: number;
  outTokens: number;
  /** Откуда взяты числа — чтобы оценку можно было оспорить, а не только принять. */
  basis: string;
  /** Прогонов в сутки по расписанию; 0 — только по маркеру. */
  runsPerDay: number;
}

export type WorkloadKey = 'judge' | 'review' | 'editor';

export const WORKLOADS: readonly Workload[] = [
  {
    key: 'judge',
    title: 'Судья находок (evo-judge)',
    calls: 100,
    inTokens: 5000,
    outTokens: 250,
    basis:
      'вызовов — EVO_JUDGE_LIMIT по умолчанию (100); вход — сниппет до SNIPPET_MAX ' +
      '(16 000 знаков) плюс системный промпт 1069 знаков, при ~3.4 знака на токен; ' +
      'выход — вердикт и причина не длиннее двадцати слов',
    runsPerDay: 1,
  },
  {
    key: 'review',
    title: 'AI-ревью кода (evo-review)',
    calls: 1,
    inTokens: 20000,
    outTokens: 2000,
    basis:
      'один вызов на прогон, весь набор файлов одним промптом; выход — потолок ' +
      'maxTokens решателя (2000). Вход — грубая оценка по размеру набора: ' +
      'ЕДИНСТВЕННОЕ число здесь, у которого нет опоры в константе кода',
    runsPerDay: 1,
  },
  {
    key: 'editor',
    title: 'Описания туров (editor-runner)',
    calls: 12,
    inTokens: 1000,
    outTokens: 1600,
    basis:
      'вызовов — MAX_ROUTES очереди (12); выход — max_tokens раннера (1600); ' +
      'вход — промпт Editor’а с текущим описанием',
    runsPerDay: 1,
  },
] as const;

/**
 * Счёт за один прогон. `null` — цену не знаем, и это не ноль.
 *
 * Отдельный исход намеренно: строка «0,00 $» рядом с моделью, у которой
 * каталог цену не назвал, читается как «бесплатно» и ровно так и была бы
 * понята при выборе.
 */
export function workloadCostUsd(price: ModelPrice, w: Workload): number | null {
  if (price.usdPerMTokIn === null || price.usdPerMTokOut === null) return null;
  return (w.calls * (w.inTokens * price.usdPerMTokIn + w.outTokens * price.usdPerMTokOut)) / 1e6;
}

/** Счёт за месяц по расписанию. `null` — либо цены нет, либо расписания нет. */
export function workloadMonthlyUsd(price: ModelPrice, w: Workload): number | null {
  const run = workloadCostUsd(price, w);
  if (run === null || w.runsPerDay === 0) return null;
  return run * w.runsPerDay * 30;
}

export function workloadByKey(key: WorkloadKey): Workload {
  const w = WORKLOADS.find((x) => x.key === key);
  if (!w) throw new Error(`неизвестная форма работы: ${key}`);
  return w;
}

/**
 * Цена из строки каталога OpenRouter: там она за ОДИН токен строкой.
 *
 * Разбор отдельной функцией, потому что различить надо три вещи: числа нет
 * («не назвали»), число ноль («бесплатная модель» — это факт, а не пробел) и
 * мусор («не разобрали» — тоже не ноль).
 */
export function parseCatalogPrice(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw * 1e6;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n * 1e6 : null;
}

/** Вендор из слага каталога: `z-ai/glm-5.3` → `z-ai`. Без слеша — сам id. */
export function vendorOf(modelId: string): string {
  const i = modelId.indexOf('/');
  return i > 0 ? modelId.slice(0, i) : modelId;
}
