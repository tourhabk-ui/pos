/**
 * Перевод сообщений переписки заявки — в обе стороны (слово владельца 13.11:
 * «когда иностранцы обращаются к оператору, то нужно для оператора переводить
 * на русский, а ответ оператора должен быть наоборот на языке обратившегося»;
 * о прежнем правиле «текст переписки в модели не уходит» — «переписать»).
 *
 * ── Что делает ────────────────────────────────────────────────────────────
 *
 *  · сообщение клиента не по-русски — адресату с русским переводом рядом;
 *  · русский ответ адресата — клиенту с переводом на язык клиента рядом.
 *    Язык клиента называет образец: его последнее сообщение в переписке или,
 *    если он ещё не писал, комментарий заявки. Образец по-русски — клиент
 *    читает по-русски, перевода нет.
 *
 * Правило перевода одно — lib/ai/translate-text: текст — данные, а не
 * поручение модели; ответ сверяется; исходов три. В модель текст уходит с
 * маской переписки (`redactChatPD`): телефоны, почта, ссылки, ники, подпись,
 * представившееся имя и известное имя клиента — плейсхолдерами. Модели
 * зарубежные, а в переписке люди называют себя и друг друга (находка ревью
 * безопасности на #3328: ПД в зарубежную модель не уходят).
 *
 * ── Чего не делает ────────────────────────────────────────────────────────
 *
 *  · исходник не заменяет: перевод стоит РЯДОМ и назван машинным;
 *  · сообщение не держит: перевод ждут не дольше CHAT_TRANSLATE_TIMEOUT_MS,
 *    и оно уходит и без него — тогда так и сказано (§4.0);
 *  · русское сообщение русскому клиенту модель не зовёт и переводчик не
 *    загружает: таких большинство;
 *  · в лог — род причины отказа, без слов людей.
 *
 * ── Контакты ──────────────────────────────────────────────────────────────
 *
 * Модель видит «[телефон]» вместо номера. В переводе плейсхолдер телефона и
 * почты заменяется обратно на то, что написал человек, — только когда это
 * однозначно: такой контакт в сообщении один. Два телефона перевод мог
 * переставить, и угадывать порядок нельзя: плейсхолдеры остаются, а номера
 * читаются в исходнике рядом. Ссылки, ники и имена в перевод не
 * возвращаются: они стоят в исходнике над ним.
 *
 * Подписи перевода и слова «перевод не получен» — в lib/requests/request-chat
 * (тексты переписки живут там).
 *
 * Сторож: tests/unit/chat-translation.test.ts.
 */

import { needsRussian } from '@/lib/ai/russian-text';
import { logText } from '@/lib/log/log-text';
import { redactChatPD, redactPII } from '@/lib/security/pii-redact';

/** Сколько ждём перевод, прежде чем отправить сообщение без него. */
export const CHAT_TRANSLATE_TIMEOUT_MS = 8000;

/** `model` — путь водопада, которым сделан перевод: пишется рядом с ним. */
export type ChatTranslation =
  | { status: 'translated'; text: string; model: string }
  /** Переводить незачем: читатель и так поймёт. */
  | { status: 'not_needed' }
  | { status: 'failed' };

const PLACEHOLDER = /\[телефон\]|\[email\]/g;

/**
 * Что скрыла чистка — по порядку. null — восстановить нельзя: два
 * плейсхолдера подряд или разбор не сошёлся с исходником.
 */
export function hiddenContacts(original: string): Array<{ mark: string; value: string }> | null {
  const redacted = redactPII(original);
  const marks = redacted.match(PLACEHOLDER) ?? [];
  if (marks.length === 0) return [];
  const literals = redacted.split(PLACEHOLDER);
  if (!original.startsWith(literals[0])) return null;
  let pos = literals[0].length;
  const out: Array<{ mark: string; value: string }> = [];
  for (let i = 0; i < marks.length; i += 1) {
    const next = literals[i + 1];
    const last = i === marks.length - 1;
    // Между двумя плейсхолдерами ничего нет — где кончается первый контакт, не узнать.
    if (next === '' && !last) return null;
    // Где кончается контакт: у последнего — там, где начинается хвост текста; у
    // прочих — первое место, где кусок до следующих слов сам читается чисткой
    // как этот контакт. Просто «первое вхождение» не годится: точка после
    // почты встречается и внутри неё.
    let end = -1;
    if (last) {
      end = original.endsWith(next) ? original.length - next.length : -1;
    } else {
      for (let at = original.indexOf(next, pos); at >= 0; at = original.indexOf(next, at + 1)) {
        if (redactPII(original.slice(pos, at)) === marks[i]) { end = at; break; }
      }
    }
    if (end < pos) return null;
    const value = original.slice(pos, end);
    // Кусок обязан быть ровно тем контактом, что скрыла чистка, и ничем больше.
    if (!value || redactPII(value) !== marks[i]) return null;
    out.push({ mark: marks[i], value });
    pos = end + next.length;
  }
  return pos === original.length ? out : null;
}

/** Вернуть в перевод контакт, который скрыла чистка, — если такой в сообщении один. */
export function restoreContacts(original: string, translation: string): string {
  const hidden = hiddenContacts(original);
  if (!hidden || hidden.length === 0) return translation;
  let out = translation;
  for (const mark of new Set(hidden.map((h) => h.mark))) {
    const same = hidden.filter((h) => h.mark === mark);
    if (same.length !== 1 || out.split(mark).length !== 2) continue;
    out = out.replace(mark, () => same[0].value);
  }
  return out;
}

async function withTimeout<T>(run: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(late), ms); });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Outcome = { status: 'translated'; text: string; model: string } | { status: 'not_needed' } | { status: 'failed'; reason: string };
type Mask = (text: string) => string;

export interface TranslateDeps {
  toRussian?: (text: string, mask: Mask) => Promise<Outcome>;
  fromRussian?: (text: string, sample: string, mask: Mask) => Promise<Outcome>;
  timeoutMs?: number;
}

/** Маска переписки перед моделью: с известными именами (имя клиента из заявки). */
export function chatMask(names: ReadonlyArray<string | null | undefined>): Mask {
  return (text) => redactChatPD(text, names);
}

/** В лог — род причины, без хвоста после двоеточия: в хвосте бывает обрывок ответа модели. */
function logFailure(where: string, what: string, reason: string): void {
  console.error(`[chat-translation] ${logText(where, 80)}: ${what} — ${logText(reason.split(':')[0], 80)}`);
}

async function run(where: string, what: string, original: string, call: () => Promise<Outcome>, timeoutMs: number): Promise<ChatTranslation> {
  let out: Outcome;
  try {
    out = await withTimeout(call(), timeoutMs, { status: 'failed', reason: `перевод не уложился в ${Math.round(timeoutMs / 1000)} с` });
  } catch (err) {
    out = { status: 'failed', reason: `перевод упал: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (out.status === 'translated') return { status: 'translated', text: restoreContacts(original, out.text), model: out.model };
  if (out.status === 'not_needed') return { status: 'not_needed' };
  logFailure(where, what, out.reason);
  return { status: 'failed' };
}

/**
 * Сообщение клиента — на русский, для адресата. По-русски — `not_needed`, и
 * модель не зовётся. Не бросает.
 */
export async function translateForOwner(
  text: string, names: ReadonlyArray<string | null | undefined>, where: string, deps: TranslateDeps = {},
): Promise<ChatTranslation> {
  if (!needsRussian(text)) return { status: 'not_needed' };
  const call = deps.toRussian
    ?? (async (t: string, mask: Mask) => (await import('@/lib/ai/translate-text')).translateToRussian(t, { mask }));
  const mask = chatMask(names);
  return run(where, 'сообщение клиента не по-русски, перевод не получен', text, () => call(text, mask), deps.timeoutMs ?? CHAT_TRANSLATE_TIMEOUT_MS);
}

/**
 * Русский ответ адресата — на язык клиента. `sample` — слова клиента, по
 * которым узнают язык; пусто или по-русски — `not_needed`, и модель не
 * зовётся. Не бросает.
 */
export async function translateForGuest(
  text: string, sample: string | null | undefined, names: ReadonlyArray<string | null | undefined>, where: string, deps: TranslateDeps = {},
): Promise<ChatTranslation> {
  const s = (sample ?? '').trim();
  // Ответ не по-русски переводить не с чего; клиент, пишущий по-русски, читает по-русски.
  if (!needsRussian(s) || needsRussian(text)) return { status: 'not_needed' };
  const call = deps.fromRussian
    ?? (async (t: string, smp: string, mask: Mask) => (await import('@/lib/ai/translate-text')).translateFromRussian(t, smp, { mask }));
  const mask = chatMask(names);
  return run(where, 'клиент пишет не по-русски, перевод ответа не получен', text, () => call(text, s, mask), deps.timeoutMs ?? CHAT_TRANSLATE_TIMEOUT_MS);
}
