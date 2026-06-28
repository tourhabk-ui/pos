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

// Грубая оценка: смешанный RU/EN текст ≈ 1 токен на 3 символа.
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 3);
}

// Обрезает слишком длинное сообщение по краям, сохраняя начало и конец.
export function capMessage(content: string): string {
  if (!content || content.length <= PER_MSG_CHAR_CAP) return content;
  const head = content.slice(0, Math.floor(PER_MSG_CHAR_CAP * 0.7));
  const tail = content.slice(-Math.floor(PER_MSG_CHAR_CAP * 0.3));
  return `${head}\n…[сообщение сокращено]…\n${tail}`;
}

// Из истории (хронологический порядок) оставляет хвост, влезающий в бюджет токенов,
// но не меньше HISTORY_KEEP_MIN последних сообщений.
export function trimHistoryToBudget(messages: ChatMessage[]): ChatMessage[] {
  const capped = messages.map(m => ({ ...m, content: capMessage(m.content) }));
  const kept: ChatMessage[] = [];
  let total = 0;
  for (let i = capped.length - 1; i >= 0; i--) {
    const t = estimateTokens(capped[i].content);
    if (total + t > HISTORY_TOKEN_BUDGET && kept.length >= HISTORY_KEEP_MIN) break;
    kept.push(capped[i]);
    total += t;
  }
  return kept.reverse();
}
