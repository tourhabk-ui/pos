/**
 * lib/kuzmich/turn-control.ts — «Остановить» и «Ещё раз» в веб-чате
 * Кузьмича (#3412, п. 3; слово владельца 15.11 «карт-бланш»). Чистые
 * правила, их зовут страница /kuzmich и виджет.
 *
 * «Остановить» обрывает ожидание ответа в браузере, а не работу сервера:
 * ход, уже дошедший до Кузьмича, он доделает и запишет в историю чата. Поэтому
 * ответ на «да» (сводка заявки, #3407) не останавливается вовсе — заявка в
 * этот момент уже уходит, и кнопка «Остановить» обещала бы, что её не будет.
 *
 * «Ещё раз» — тот же вопрос новым ходом. Не повторяются: «да» и «нет» (это
 * ответы на сводку заявки, а не вопросы), вопрос с фото (снимок в истории
 * не хранится) и ход, после которого открыта или отправлена форма заявки.
 */
import { isNo, isYes } from '@/lib/kuzmich/yes-no';

export const TURN_STOPPED_TEXT =
  'Остановлено — ответ не показан. Если Кузьмич успел ответить, ответ будет в истории чата при следующем открытии.';

export const STOP_LOCKED_TEXT = 'Ответ на «да» не останавливается: заявка уже уходит.';

/** Можно ли остановить ожидание ответа на этот вопрос. */
export function canStopTurn(question: string): boolean {
  return !isYes(question);
}

export interface TurnMessage {
  role: 'user' | 'assistant';
  content: string;
  imagePreview?: string;
  bookingForm?: unknown;
  bookingConfirmed?: unknown;
}

/** Вопрос для «Ещё раз» — или null, если повторять нечего или нельзя. */
export function retryQuestion(messages: readonly TurnMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  if (last.bookingForm || last.bookingConfirmed) return null;
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const q = m.content.trim();
    if (!q || m.imagePreview || q === '(фото)') return null;
    if (isYes(q) || isNo(q)) return null;
    return q;
  }
  return null;
}

/** Ожидание оборвал сам человек (AbortController), а не сеть. */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}
