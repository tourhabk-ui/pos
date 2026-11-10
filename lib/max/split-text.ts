/**
 * Длинный ответ в MAX — частями, а не одним сообщением сверх предела (#3199, K8).
 *
 * Предел текста MAX — 4000 знаков (`MAX_MESSAGE_CHARS`, его же держит рассылка
 * админа). Ответ Кузьмича с планом по дням, «Важно», сметой и строкой 112
 * бывает длиннее; одно сообщение сверх предела API может не принять, и тогда
 * человек не получает ничего, а отказ остаётся в логе.
 *
 * Делит тот же разбор, что у Telegram (`splitTelegramHtmlReport`): по абзацам,
 * теги не рвутся, открытые переоткрываются в следующей части. Короткий текст
 * не трогается вовсе — разбор экранирует голый `<` и снимает ограждения кода,
 * и короткие ответы менять незачем.
 */
import { splitTelegramHtmlReport } from '@/lib/notifications/telegram-html';
import { MAX_MESSAGE_CHARS } from '@/lib/operators/chat-dates/texts';

export const MAX_TEXT_LIMIT = MAX_MESSAGE_CHARS;

export interface MaxSplit {
  parts: string[];
  /** Сколько знаков не поместилось ни в одну часть (больше пяти частей). */
  droppedChars: number;
}

export function splitMaxText(text: string, limit: number = MAX_TEXT_LIMIT): MaxSplit {
  if (text.length <= limit) return { parts: [text], droppedChars: 0 };
  const { parts, droppedChars } = splitTelegramHtmlReport(text, limit);
  return parts.length > 0 ? { parts, droppedChars } : { parts: [text.slice(0, limit)], droppedChars: Math.max(0, text.length - limit) };
}
