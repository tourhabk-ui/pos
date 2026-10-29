/**
 * lib/kuzmich/answer-ceiling.ts — потолок ожидания ответа Кузьмича и ответ,
 * собранный на нём (аудит 15.10, A19, пункт 1.13 дорожной карты, находка
 * P3-11).
 *
 * У цикла инструментов (`aiChatAgentLoop`, lib/kuzmich/core.ts) не было
 * общего дедлайна: у каждой ноги водопада свой таймаут (lib/ai/providers.ts),
 * ходов до четырёх, и худший ответ оценивался в 100–150 с — оценкой, не
 * замером. Для человека в поле две минуты тишины — это «не ответил».
 *
 * После `KUZMICH_ANSWER_CEILING_MS` цикл не начинает новый ход модели или
 * инструмента, а отдаёт собранное с честной строкой (`composeCeilingAnswer`).
 * Уже идущий вызов провайдера не обрывается — это отдельный пункт (общий
 * AbortSignal в ноги водопада, 3.1). Блок 112 при признаках ЧП ставят
 * вызывающие (`withSosBlock`) поверх любого ответа цикла, включая собранный на
 * потолке, — потолок его не отменяет.
 *
 * Модуль чистый, без базы: его читает и перепись kuzmich-load-census, которая
 * объявлена непишущей (cron-capability-registry). Запись замера — в
 * lib/kuzmich/answer-timing.
 */

import { fullInputTokens, type ParsedUsage } from '@/lib/ai/provider-usage';

/**
 * Потолок ожидания ответа цикла инструментов, мс (аудит 15.10, A19).
 *
 * 60 с — жёсткий верх сейчас, решение (в): снизить до p95 с запасом через
 * неделю замера (`kuzmich_answer` в ai_actions_log, перепись
 * kuzmich-load-census). Число взято не из замера — замера до 15.10 не было.
 */
export const KUZMICH_ANSWER_CEILING_MS = 60_000;

/** Под этим action_type строка замера ложится в ai_actions_log. */
export const KUZMICH_ANSWER_ACTION = 'kuzmich_answer';

/**
 * Честная первая строка ответа, собранного на потолке. Без числа секунд:
 * потолок будет снижен по замеру, и «за минуту» стало бы неправдой.
 */
export const CEILING_HONEST_LINE = 'Не успел проверить всё — вот что известно:';

/** Потолок наступил, а собрать не успели ничего — так и говорим (§4.0). */
export const CEILING_NOTHING_LINE =
  'Не успел проверить — ответ затянулся, и данных собрать я не успел. Спросите ещё раз чуть позже; в беде — 112.';

/** Чужой текст подписан как чужой: веб-поиск платформа не проверяла. */
export const CEILING_WEB_LABEL = 'Из веб-поиска, не проверено платформой:';

/** Инструменты, чей вывод — выдержки чужих сайтов, а не данные платформы. */
const WEB_TOOLS: ReadonlySet<string> = new Set(['search_kamchatka']);

/**
 * Сколько знаков вывода одного инструмента идёт в собранный ответ. Меньше
 * потолка журнала (2000, core.ts): всё, что показано человеку, лежит и в
 * журнале, по которому сторож километража и сверка опасностей ищут опору.
 */
const CEILING_OUTPUT_KEEP = 1500;
/** Общий потолок собранного ответа: сообщение Telegram — до 4096 знаков. */
const CEILING_TOTAL_KEEP = 3500;

/** Что цикл успел узнать к потолку: вывод инструмента, принёсший данные. */
export interface CollectedOutput {
  name: string;
  content: string;
}

function cut(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Ответ из собранного к потолку: честная строка, затем выводы инструментов с
 * данными — в порядке вызова. Текст, который модель написала рядом с вызовом
 * инструмента («сейчас проверю…»), сюда не идёт: это намерение, а не данные,
 * и проверить его цикл не успел. Ничего не собрано — честная строка «не
 * успел» без «вот что известно».
 */
export function composeCeilingAnswer(collected: readonly CollectedOutput[]): string {
  const parts: string[] = [];
  let used = 0;
  const push = (block: string): void => {
    const room = CEILING_TOTAL_KEEP - used;
    // Огрызок в пару слов хуже, чем ничего: меньше 200 знаков не начинаем.
    if (!block || room < 200) return;
    const piece = cut(block, Math.min(room, CEILING_OUTPUT_KEEP));
    parts.push(piece);
    used += piece.length;
  };

  const seen = new Set<string>();
  for (const o of collected) {
    const body = o.content.trim();
    if (!body || seen.has(body)) continue;
    seen.add(body);
    push(WEB_TOOLS.has(o.name) ? `${CEILING_WEB_LABEL}\n${body}` : body);
  }

  if (parts.length === 0) return CEILING_NOTHING_LINE;
  return [CEILING_HONEST_LINE, ...parts].join('\n\n');
}

/**
 * Что цикл сообщает о себе вызывающему — наружная отметка, как журнал
 * инструментов и провайдер. Заполняется при любом выходе из цикла.
 */
export interface AgentLoopTiming {
  /** Сколько вызовов модели цикл начал. */
  turns: number;
  /** Сколько раз исполнял инструменты хода. */
  toolRounds: number;
  /** От входа в цикл до выхода из него, мс. */
  elapsedMs: number;
  /** Цикл остановился на потолке и собрал ответ из уже собранного. */
  ceilingHit: boolean;
  /** Расход ходов модели — суммы по вызовам (шаг 0 разбора 29.10). */
  tokens: LoopTokens;
}

/**
 * Сколько весили ходы одного ответа. Пишется в замер ответа
 * (lib/kuzmich/answer-timing), и перепись kuzmich-load-census считает по нему
 * p50/p95 входа ПО ПОВЕРХНОСТЯМ: в книгах расхода (llm_usage_log) поверхности
 * нет, там строка — один вызов модели. Только числа, ни слова реплик.
 */
export interface LoopTokens {
  /** Вызовов модели, по которым провайдер отдал usage. */
  reportedCalls: number;
  /** Вызовов без usage — «не знаю», а не ноль: суммы ниже тогда неполны. */
  unreportedCalls: number;
  /** Вход целиком (вместе с прочитанным из кэша), сумма по ходам. */
  inputTokens: number;
  /** Самый большой вход одного хода — то, что упирается в окно модели. */
  maxCallInputTokens: number;
  completionTokens: number;
  /** Прочитано из кэша — сумма по ходам, где провайдер кэш назвал. */
  cacheReadTokens: number;
  /** Ходов, где провайдер кэш назвал. 0 — доля кэша неизвестна. */
  cacheReportedCalls: number;
}

export function newLoopTiming(): AgentLoopTiming {
  return {
    turns: 0, toolRounds: 0, elapsedMs: 0, ceilingHit: false,
    tokens: {
      reportedCalls: 0, unreportedCalls: 0, inputTokens: 0, maxCallInputTokens: 0,
      completionTokens: 0, cacheReadTokens: 0, cacheReportedCalls: 0,
    },
  };
}

/**
 * Добавить расход одного хода. null/undefined — провайдер usage не отдал:
 * считается вызовом без чисел, а не нулём.
 */
export function addTurnUsage(timing: AgentLoopTiming, usage: ParsedUsage | null | undefined): void {
  const t = timing.tokens;
  if (!usage) { t.unreportedCalls += 1; return; }
  const input = fullInputTokens(usage);
  t.reportedCalls += 1;
  t.inputTokens += input;
  t.maxCallInputTokens = Math.max(t.maxCallInputTokens, input);
  t.completionTokens += usage.completionTokens;
  if (usage.cacheReadTokens !== null) {
    t.cacheReadTokens += usage.cacheReadTokens;
    t.cacheReportedCalls += 1;
  }
}

/** Расход для замера ответа; null — цикл модели не звал (ответ без него). */
export function answerTokens(timing: AgentLoopTiming): LoopTokens | null {
  const t = timing.tokens;
  return t.reportedCalls + t.unreportedCalls === 0 ? null : { ...t };
}
