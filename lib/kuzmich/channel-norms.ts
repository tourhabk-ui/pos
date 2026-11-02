/**
 * Нормы ответа в мессенджере (02.11, владелец: «хорошо Карт-бланш»): связный
 * текст — до ~100 слов, вопрос — один за раз. Строки списка («- …», кнопки
 * тура «61 · …»), ссылки и сводка заявки в лимит не входят: полезное не
 * режем. Это проверка для тестов и журнала, а не обрезка ответа.
 */
import { stripTags } from '@/lib/html/text';

export const MESSENGER_WORD_LIMIT = 100;

/** Связный текст без строк списка, ссылок и разметки. */
export function proseOf(text: string): string {
  return stripTags(text)
    .split('\n')
    .filter((l) => !/^\s*(?:[-•–]\s|\d+[.)]\s|\d+\s·)/.test(l))
    .join('\n')
    .replace(/https?:\/\/\S+/g, ' ');
}

export function proseWords(text: string): number {
  return proseOf(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function questionCount(text: string): number {
  // Примеры в кавычках («опасно ли…?») — не вопрос человеку.
  const own = proseOf(text).replace(/"[^"\n]*"|«[^»\n]*»/g, ' ');
  return (own.match(/\?/g) ?? []).length;
}

export function messengerNormIssues(text: string): string[] {
  const out: string[] = [];
  const w = proseWords(text);
  if (w > MESSENGER_WORD_LIMIT) out.push(`слов ${w} > ${MESSENGER_WORD_LIMIT}`);
  const q = questionCount(text);
  if (q > 1) out.push(`вопросов ${q}`);
  return out;
}
