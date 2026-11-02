/**
 * Подпись и срок кнопок-записей в чатах MAX и Telegram (план CRM в
 * мессенджере, PR1; слово владельца 02.11: «кнопки записи живут 3 дня»).
 *
 * Кнопка, которая что-то меняет (ответ на заявку, дата, задача, черновик,
 * бронь), получает хвост `~<срок>~<подпись>`:
 *   срок    — минуты эпохи base36, до которых кнопка действует (3 суток);
 *   подпись — 8 символов base64url от HMAC-SHA256(ключ, payload~срок).
 * Хвост — 15 байт; payload с хвостом не длиннее 64 байт (лимит callback_data
 * Telegram). Кнопка длиннее лимита не подписывается — сторож теста проверяет,
 * что таких среди кнопок-записей нет, кроме «Освободить» жилья (61 байт),
 * у которой право проверяет запись по чату.
 *
 * Подпись не заменяет проверку права: чей чат и чей предмет по-прежнему
 * решают сервисы по чату сообщения с кнопкой. Она закрывает две дыры:
 * старую кнопку (через неделю «Подтвердить» сработал бы) и payload,
 * собранный руками.
 *
 * Вебхуки снимают хвост ДО разбора (`unwrapPress`): обработчики видят прежний
 * payload и ничего о подписи не знают.
 *
 * Ключ — CALLBACK_SIGNING_SECRET, иначе секрет вебхука MAX/Telegram, иначе
 * токен бота. Ключа нет (тесты, локально) — кнопки без хвоста, проверка
 * пропускает: подпись нечем ни поставить, ни проверить.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const WRITE_BUTTON_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const CALLBACK_MAX_BYTES = 64;
const SEP = '~';
const MAC_LEN = 8;

/**
 * Неподписанные кнопки-записи, разосланные до выката подписи, принимаются
 * до этой даты (выкат + 3 дня — тот же срок, что у подписанных).
 */
export const LEGACY_UNSIGNED_UNTIL_MS = Date.parse('2026-11-05T12:00:00Z');

function legacyUntilMs(): number {
  const v = Number(process.env.CALLBACK_LEGACY_UNTIL_MS);
  return Number.isFinite(v) && v > 0 ? v : LEGACY_UNSIGNED_UNTIL_MS;
}

/** Кнопки-записи: всё, что меняет данные. Чтение и листание не подписываются. */
const WRITE_PATTERNS: readonly RegExp[] = [
  /^ia:/, // ответ на заявку (#2931)
  /^oc:y:/, // «Да» под вопросом брони/заявки
  /^od:o:/, // «Открыть» даты
  /^cb:g:[mdeo]$/, // время сводки
  /^cb:[dzkr]:/, // задача, звонок, напоминание
  /^cb:v:[az]:/, // машина на линию / с линии
  /^cb:w:[oc]:/, // открыть / закрыть дату гида
  /^cb:e:[stc]:/, // черновик тура: сохранить, выбрать тур, создать
  /^cb:u:[ps]:/, // опубликовать / снять тур
  /^cb:b:s:/, // черновик гида: записать
  /^cb:p:[an]:/, /^cb:p:y$/, // команда
  /^cb:q:[aft]:/, // документ гида
];

/** «Освободить» жилья не помещается в лимит с хвостом — см. шапку. */
const UNSIGNABLE: readonly RegExp[] = [/^cb:b:r:/];

export function isWritePayload(payload: string): boolean {
  return WRITE_PATTERNS.some((re) => re.test(payload));
}

function signingKey(): string | null {
  const e = process.env;
  return e.CALLBACK_SIGNING_SECRET || e.MAX_WEBHOOK_SECRET || e.TELEGRAM_WEBHOOK_SECRET
    || e.TELEGRAM_BOT_TOKEN || e.MAX_BOT_TOKEN || null;
}

function mac(key: string, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url').slice(0, MAC_LEN);
}

/** Подписать кнопку-запись. Чтение, ключа нет или не влезает — как было. */
export function signPayload(payload: string, nowMs: number = Date.now()): string {
  if (!isWritePayload(payload) || UNSIGNABLE.some((re) => re.test(payload))) return payload;
  if (payload.includes(SEP)) return payload;
  const key = signingKey();
  if (!key) return payload;
  const exp = Math.ceil((nowMs + WRITE_BUTTON_TTL_MS) / 60000).toString(36);
  const body = `${payload}${SEP}${exp}`;
  const signed = `${body}${SEP}${mac(key, body)}`;
  return Buffer.byteLength(signed) <= CALLBACK_MAX_BYTES ? signed : payload;
}

export type PressVerdict =
  | { ok: true; payload: string }
  | { ok: false; reason: 'expired' | 'forged' };

export const EXPIRED_TEXT = 'Кнопка устарела (кнопки действуют 3 дня). Ничего не изменил — откройте свежую карточку.';
export const FORGED_TEXT = 'Кнопку не удалось проверить. Ничего не изменил.';

/** Снять и проверить хвост. Чужие для подписи payload проходят как есть. */
export function unwrapPress(raw: string, nowMs: number = Date.now()): PressVerdict {
  const parts = raw.split(SEP);
  const key = signingKey();
  if (parts.length === 1) {
    if (!key || !isWritePayload(raw) || UNSIGNABLE.some((re) => re.test(raw))) return { ok: true, payload: raw };
    return nowMs <= legacyUntilMs() ? { ok: true, payload: raw } : { ok: false, reason: 'expired' };
  }
  if (parts.length !== 3 || !key) return { ok: false, reason: 'forged' };
  const [payload, exp, sig] = parts as [string, string, string];
  const want = mac(key, `${payload}${SEP}${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'forged' };
  const expMs = parseInt(exp, 36) * 60000;
  if (!Number.isFinite(expMs) || nowMs > expMs) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

export function pressRefusalText(reason: 'expired' | 'forged'): string {
  return reason === 'expired' ? EXPIRED_TEXT : FORGED_TEXT;
}
