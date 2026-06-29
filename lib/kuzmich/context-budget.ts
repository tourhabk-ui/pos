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
