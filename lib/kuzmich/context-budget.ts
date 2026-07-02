/**
 * lib/kuzmich/context-budget.ts
 *
 * Управление контекстом диалога (harness / context management).
 * Раньше история бралась по количеству (последние 20) — один длинный месседж мог
 * раздуть контекст и стоимость. Здесь бюджетируем по приблизительным токенам и
 * обрезаем самое старое, всегда сохраняя несколько последних реплик.
 *
 * Чистые функции без зависимостей от БД/AI — тестируются изолированно.
 */

import type { ChatMessage } from '@/lib/ai/prompts';

export const HISTORY_TOKEN_BUDGET = 3000; // бюджет на историю (без системного промпта)
export const HISTORY_KEEP_MIN = 4;        // минимум последних сообщений сохраняем всегда
export const PER_MSG_CHAR_CAP = 4000;     // одно сообщение не должно доминировать
export const DYNAMIC_CONTEXT_TOKEN_BUDGET = 6000; // бюджет на динамический RAG-контекст промпта

// Оценка токенов с поправкой на язык. Кириллица токенизируется тяжелее под BPE
// (~1 токен на 2 символа), латиница/ASCII ~1 токен на 3 символа. Раньше делили
// всё на 3 и недосчитывали русский текст (Roitman §18.2.6: приближение «4 симв/токен»
// ошибается на 20-40% для не-английского) — теперь считаем по долям.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cyr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0400 && c <= 0x04ff) cyr++; // кириллический блок Unicode
  }
  const other = text.length - cyr;
  return Math.ceil(cyr / 2 + other / 3);
}

// Обрезает слишком длинное сообщение по краям, сохраняя начало и конец.
export function capMessage(content: string): string {
  if (!content || content.length <= PER_MSG_CHAR_CAP) return content;
  const head = content.slice(0, Math.floor(PER_MSG_CHAR_CAP * 0.7));
  const tail = content.slice(-Math.floor(PER_MSG_CHAR_CAP * 0.3));
  return `${head}\n…[сообщение сокращено]…\n${tail}`;
}

export interface HistorySplit {
  kept: ChatMessage[];
  dropped: ChatMessage[]; // хронологический порядок, то что не влезло в бюджет
}

// Из истории (хронологический порядок) отделяет хвост, влезающий в бюджет
// токенов (не меньше HISTORY_KEEP_MIN последних сообщений), от отброшенной
// по бюджету головы. Разделение вынесено из trimHistoryToBudget (Roitman
// §18, Eq 18.4): компакция должна суммировать отброшенное, а не просто
// стирать — но само разбиение чистое и не знает про AI/суммаризацию.
export function splitHistoryForCompaction(messages: ChatMessage[]): HistorySplit {
  const capped = messages.map(m => ({ ...m, content: capMessage(m.content) }));
  const kept: ChatMessage[] = [];
  let total = 0;
  let cutIndex = 0; // индекс в capped, начиная с которого сообщения попали в kept
  for (let i = capped.length - 1; i >= 0; i--) {
    const t = estimateTokens(capped[i].content);
    if (total + t > HISTORY_TOKEN_BUDGET && kept.length >= HISTORY_KEEP_MIN) {
      cutIndex = i + 1;
      break;
    }
    kept.push(capped[i]);
    total += t;
  }
  return { kept: kept.reverse(), dropped: capped.slice(0, cutIndex) };
}

// Из истории (хронологический порядок) оставляет хвост, влезающий в бюджет токенов,
// но не меньше HISTORY_KEEP_MIN последних сообщений.
export function trimHistoryToBudget(messages: ChatMessage[]): ChatMessage[] {
  return splitHistoryForCompaction(messages).kept;
}

// Pre-flight против Silent Truncation (Roitman §18.2): если динамический контекст
// превышает бюджет токенов — обрезаем С КОНЦА до бюджета (важные блоки place/route
// идут первыми, в хвосте — менее критичные) и помечаем маркером. Только урезает,
// никогда не расширяет — fail-safe. Бинарный поиск длины префикса под бюджет.
export function fitTextToTokenBudget(text: string, budget = DYNAMIC_CONTEXT_TOKEN_BUDGET): string {
  if (!text || estimateTokens(text) <= budget) return text;
  const marker = '\n\n…[контекст сокращён по бюджету токенов]';
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + marker;
}
