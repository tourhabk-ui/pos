/**
 * lib/kuzmich/pending-request.ts — заявка из чата ждёт «да» на сводку
 * (#3399, п. 4; карт-бланш владельца 15.11).
 *
 * До этого быстрый путь веб-чата и MAX отправлял заявку оператору в том же
 * ходе, где человек назвал имя, телефон, дату и «согласен»: кому уйдут
 * данные, какой тур выбран и за какую цену, он узнавал уже после отправки.
 * Теперь ход с данными показывает сводку (её собирает код,
 * `chatRequestSummary`) и откладывает заявку здесь; уходит она только
 * следующим «да» на эту сводку.
 *
 * Хранение — в памяти процесса, на 30 минут, одна заявка на чат. Это
 * намеренно: потеря при перезапуске закрывает дверь, а не открывает её —
 * «да» без сводки говорит «сводка устарела» и ничего не отправляет.
 * Любой ответ, кроме «да» и «нет», заявку снимает: согласие — на ту сводку,
 * что стояла прямо перед ним.
 */
import type { ChatRequestPlan } from '@/lib/kuzmich/chat-request';

export interface PendingChatRequest {
  plan: ChatRequestPlan;
  /** Название тура для ответа после отправки. */
  tourTitle: string | null;
  at: number;
}

export const PENDING_REQUEST_TTL_MS = 30 * 60 * 1000;

const store = new Map<string, PendingChatRequest>();

/** Отложить заявку чата до «да»; прежняя отложенная заменяется. */
export function holdChatRequest(key: string, plan: ChatRequestPlan, tourTitle: string | null, now = Date.now()): void {
  for (const [k, v] of store) if (now - v.at > PENDING_REQUEST_TTL_MS) store.delete(k);
  store.set(key, { plan, tourTitle, at: now });
}

/** Есть ли у чата живая отложенная заявка. */
export function hasPendingChatRequest(key: string, now = Date.now()): boolean {
  const p = store.get(key);
  if (!p) return false;
  if (now - p.at > PENDING_REQUEST_TTL_MS) { store.delete(key); return false; }
  return true;
}

/** Забрать отложенную заявку — один раз: второй вызов вернёт null. */
export function takeChatRequest(key: string, now = Date.now()): PendingChatRequest | null {
  const p = store.get(key);
  store.delete(key);
  if (!p || now - p.at > PENDING_REQUEST_TTL_MS) return null;
  return p;
}

/** Снять отложенную заявку без отправки. */
export function dropChatRequest(key: string): void {
  store.delete(key);
}

/**
 * Ответ на сводку. «Да» — короткое сообщение со словом согласия и без
 * вопроса: «да, а сколько стоит?» — вопрос, а не согласие.
 */
export function answerToSummary(
  text: string,
  words: { isYes: (t: string) => boolean; isNo: (t: string) => boolean },
): 'yes' | 'no' | 'other' {
  const t = text.trim();
  if (!t || t.length > 40 || t.includes('?')) return 'other';
  if (words.isNo(t)) return 'no';
  if (words.isYes(t)) return 'yes';
  return 'other';
}

export const PENDING_REQUEST_CANCELLED = 'Не отправил. Данные никому не ушли. Если передумаете — напишите заявку ещё раз.';
export const PENDING_REQUEST_STALE = 'Сводка заявки устарела — ничего не отправлено. Напишите заявку ещё раз: имя, телефон, дату и согласие.';
export const PENDING_REQUEST_NO_SESSION = 'Отправить заявку из этого окна не могу: чат не сохранил сессию, и подтверждение «да» не к чему привязать. Оформите заявку в форме тура на сайте — там та же заявка.';
