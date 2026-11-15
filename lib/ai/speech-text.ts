/**
 * Текст ответа Кузьмича → текст для голоса. Одно правило на голос Ведара
 * (сервер, `lib/ai/tts.ts`) и на голос телефона (кнопка «Озвучить», когда
 * голос Ведара недоступен): оба читают одно и то же и одинаково признают
 * обрезку.
 *
 * Модуль без серверных зависимостей: его импортирует клиентский компонент.
 */

import { plainResponse } from '@/lib/text/plain-response';

/** Потолок озвучиваемого текста. Длиннее — режем по границе предложения. */
export const SPEECH_MAX_CHARS = 1200;

/**
 * Без разметки и эмодзи (их нельзя произнести), без адресов, не длиннее
 * потолка. Режем по концу предложения, чтобы голос не обрывался на полуслове,
 * и сообщаем, что озвучено не всё.
 */
export function prepareSpeechText(raw: string, max = SPEECH_MAX_CHARS): { text: string; truncated: boolean } {
  const clean = plainResponse(raw)
    .replace(/https?:\/\/\S+/g, '')          // адрес вслух — шум, а не смысл
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (clean.length <= max) return { text: clean, truncated: false };
  const head = clean.slice(0, max);
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  const cut = lastStop > max * 0.5 ? head.slice(0, lastStop + 1) : head;
  return { text: cut.trim(), truncated: true };
}
