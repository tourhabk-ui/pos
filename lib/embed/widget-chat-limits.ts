/**
 * lib/embed/widget-chat-limits.ts — пределы публичного чата виджета партнёра.
 *
 * Одно место на сервер (`POST /api/widget/chat`, проверка Zod) и окно чата
 * (`app/widget/[partnerId]/page.tsx`, что оно шлёт). Модуль чистый: окно —
 * клиентский код, и тянуть в него серверное (базу, провайдеров) нельзя.
 *
 * Почему пределы вообще (аудит 15.10, WID-safety): до 15.10 у реплик истории
 * не было длины — 20 элементов произвольного размера уходили в платную модель
 * из открытого всем чата. Ограничитель частоты (15 в минуту на адрес) объёма
 * одного запроса не ограничивает.
 */

/** Сколько прежних реплик принимает сервер. */
export const WIDGET_HISTORY_MAX_ITEMS = 20;

/** Длина одной реплики — и нового сообщения, и каждой из истории. */
export const WIDGET_MESSAGE_MAX_CHARS = 2000;

/** Общий объём истории в знаках. 20 × 2000 = 40 000 — уже книга, а не разговор. */
export const WIDGET_HISTORY_TOTAL_MAX_CHARS = 12_000;

export interface WidgetTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Хвост разговора, который окно вправе отправить: последние реплики в пределах
 * числа и общего объёма, каждая не длиннее предела. Длинный разговор не должен
 * упираться в 400 на двадцать первой реплике — окно отдаёт хвост, а не всё.
 */
export function trimWidgetHistory(turns: readonly WidgetTurn[]): WidgetTurn[] {
  const out: WidgetTurn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < WIDGET_HISTORY_MAX_ITEMS; i--) {
    const content = turns[i].content.slice(0, WIDGET_MESSAGE_MAX_CHARS);
    if (total + content.length > WIDGET_HISTORY_TOTAL_MAX_CHARS) break;
    total += content.length;
    out.unshift({ role: turns[i].role, content });
  }
  return out;
}
