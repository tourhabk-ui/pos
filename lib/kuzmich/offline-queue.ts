/**
 * Вопрос без сети ждёт в телефоне и уходит Кузьмичу, когда связь вернётся.
 *
 * Карт-бланш владельца 27.11, шаг 3 после «памяток» и «фактов маршрута».
 * Без сети Кузьмич отвечает памяткой Спасателя или фактами сохранённого
 * маршрута; на остальное ответа в телефоне нет. До этого шага такой вопрос
 * пропадал: человеку оставалось помнить его и задать ещё раз, когда появится
 * сеть.
 *
 * Хранится в sessionStorage — до закрытия вкладки. Вопрос — свободный текст
 * человека и может нести его данные, поэтому дольше вкладки он на устройстве
 * не лежит. Хранилище закрыто (приватный режим) — вопрос ждёт в памяти
 * страницы, и человеку так и сказано: «пока эта страница открыта».
 *
 * Уходит вопрос только по признаку связи — событию `online` или удачному
 * ответу сервера, — а не по «браузер считает, что сеть есть»: при ложной
 * сети такой повтор крутился бы без конца.
 */

export const WAITING_PREFIX = 'kh_kuzmich_waiting_';
/** Больше пяти вопросов не копим: одним сообщением они уже не читаются. */
export const WAITING_MAX = 5;

export type WaitingSurface = 'kuzmich' | 'ai-assistant';
/** Где ждёт вопрос: во вкладке (переживёт перезагрузку) или только в памяти страницы. */
export type WaitingKept = 'tab' | 'page';

export interface WaitingQuestion {
  text: string;
  /** Когда задан (мс). */
  askedAt: number;
  /** Номер разговора: в новом разговоре вопрос старого не всплывает. */
  session: string;
}

/** Что ушло Кузьмичу из очереди: подпись к вопросу в чате. */
export interface AskedOffline {
  at: number;
  count: number;
}

export function waitingKey(surface: WaitingSurface): string {
  return `${WAITING_PREFIX}${surface}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Разобрать сохранённое; чужой разговор, битое и пустое — мимо. */
export function parseWaiting(raw: string | null, session: string): WaitingQuestion[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(isRecord)
      .filter((q) => typeof q.text === 'string' && q.text.trim() !== '' && typeof q.askedAt === 'number' && q.session === session)
      .map((q) => ({ text: String(q.text), askedAt: Number(q.askedAt), session }))
      .slice(0, WAITING_MAX);
  } catch {
    return [];
  }
}

export function readWaiting(surface: WaitingSurface, session: string): WaitingQuestion[] {
  try {
    if (typeof sessionStorage === 'undefined') return [];
    return parseWaiting(sessionStorage.getItem(waitingKey(surface)), session);
  } catch {
    return [];
  }
}

/** Записать очередь целиком. Хранилище закрыто — false: вопрос ждёт только в памяти. */
export function storeWaiting(surface: WaitingSurface, list: readonly WaitingQuestion[]): boolean {
  try {
    if (list.length === 0) sessionStorage.removeItem(waitingKey(surface));
    else sessionStorage.setItem(waitingKey(surface), JSON.stringify(list));
    return true;
  } catch (err) {
    console.error('[kuzmich-waiting] вопрос не записан во вкладку:', err instanceof Error ? err.name : 'unknown');
    return false;
  }
}

/** Вопросы одним сообщением — по строке на вопрос, как очередь во время ответа. */
export function joinWaiting(list: readonly WaitingQuestion[]): { text: string; asked: AskedOffline } | null {
  if (list.length === 0) return null;
  return {
    text: list.map((q) => q.text).join('\n'),
    asked: { at: Math.min(...list.map((q) => q.askedAt)), count: list.length },
  };
}

/** Ответ на вопрос, который встал ждать связи. `lead` — первая строка «в сохранённом маршруте ответа нет» (`offlineKuzmichReply`), если вопрос назвал маршрут. */
export function waitingReply(kept: WaitingKept, lead: string | null = null): string {
  const where = kept === 'tab' ? 'пока эта вкладка открыта' : 'пока эта страница открыта';
  const reply = `Связи нет. Вопрос ждёт в телефоне и уйдёт Кузьмичу сам, когда сеть вернётся, — ${where}. ` +
    'Если есть опасность — звоните 112; кнопка SOS в шапке работает и без сети.';
  return lead ? `${lead}\n\n${reply}` : reply;
}

function questions(n: number): string {
  const d = n % 10;
  const h = n % 100;
  if (d === 1 && h !== 11) return `${n} вопрос`;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return `${n} вопроса`;
  return `${n} вопросов`;
}

/** Строка над полем ввода, пока вопросы ждут. */
export function waitingStrip(count: number): string {
  return `Ждут связи: ${questions(count)} — уйдут Кузьмичу, когда сеть вернётся.`;
}

/** Подпись к вопросу, ушедшему из очереди. Время — часы телефона человека. */
export function askedOfflineCaption(asked: AskedOffline): string {
  const time = new Date(asked.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return asked.count > 1
    ? `Заданы без сети с ${time} — отправлены, когда появилась связь.`
    : `Задан без сети в ${time} — отправлен, когда появилась связь.`;
}
