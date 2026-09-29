/**
 * Запрос свободных мест у оператора — чистая часть (без базы).
 *
 * Решения владельца 29.09: ответ оператора одним нажатием в мессенджере;
 * «Есть места» сразу создаёт и подтверждает бронь; на ответ 2 часа; ответ
 * туристу — туда, где ему удобно. Схема — миграция 1105.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** Срок ответа оператора — решение владельца 29.09 («2 часа»). */
export const SEAT_REQUEST_DEADLINE_MS = 2 * 60 * 60 * 1000;

export const SEAT_REQUEST_STATUSES = [
  'pending', 'confirmed', 'declined', 'other_date', 'expired', 'failed',
] as const;
export type SeatRequestStatus = (typeof SEAT_REQUEST_STATUSES)[number];

export const REPLY_CHANNELS = ['telegram', 'max', 'whatsapp', 'phone'] as const;
export type ReplyChannel = (typeof REPLY_CHANNELS)[number];

/** Что может ответить оператор. */
export type OperatorAnswer =
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'other_date'; date: string };

/**
 * Статус, который видит читатель. Ожидающий запрос после срока — «оператор
 * не ответил», даже если уборщик ещё не прошёл: срок — факт времени, а не
 * результат крона, и туристу не должно показываться «ждём» через три часа
 * только потому, что планировщик GitHub опоздал.
 *
 * Запрос, ответ на который уже принят в работу (`answered_at` есть, статус
 * ещё pending — идёт заведение брони), не просрочивается: оператор успел.
 */
export function effectiveStatus(
  row: { status: SeatRequestStatus; deadline_at: Date | string; answered_at: Date | string | null },
  now: number = Date.now(),
): SeatRequestStatus {
  if (row.status !== 'pending') return row.status;
  if (row.answered_at !== null) return 'pending';
  return new Date(row.deadline_at).getTime() <= now ? 'expired' : 'pending';
}

// ── Кнопки оператора в MAX ────────────────────────────────────────────────
// payload: sr:<y|n>:<uuid>. «Другая дата» — ссылкой на страницу ответа: дату
// выбирают календарём, а не перепиской с ботом.

const PAYLOAD_RE = /^sr:(y|n):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function answerPayload(kind: 'yes' | 'no', requestId: string): string {
  return `sr:${kind === 'yes' ? 'y' : 'n'}:${requestId}`;
}

export function parseAnswerPayload(payload: string): { requestId: string; kind: 'yes' | 'no' } | null {
  const m = PAYLOAD_RE.exec(payload);
  if (!m) return null;
  return { requestId: m[2]!, kind: m[1] === 'y' ? 'yes' : 'no' };
}

// ── Ключи ─────────────────────────────────────────────────────────────────

/**
 * Ключ страницы статуса для туриста: случайный, отдаётся ОДИН раз, в базе —
 * только хэш (как ключ брони, миграция 943). 24 байта = 32 символа base64url
 * — влезает в параметр start Telegram вместе с префиксом `sr_`.
 */
export function newStatusToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashStatusToken(token) };
}

export function hashStatusToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const TOURIST_START_PREFIX = 'sr_';

export function statusTokenFromStart(arg: string): string | null {
  if (!arg.startsWith(TOURIST_START_PREFIX)) return null;
  const t = arg.slice(TOURIST_START_PREFIX.length);
  return /^[A-Za-z0-9_-]{32}$/.test(t) ? t : null;
}

function secret(): string | null {
  // `||`, а не `??`: переменная, заданная пустой строкой, — это «не задана».
  const s = process.env.CONNECT_TOKEN_SECRET || process.env.JWT_SECRET || '';
  return s.length >= 16 ? s : null;
}

/**
 * Ключ страницы ответа ОПЕРАТОРА — подпись над id запроса. Нужен там, где
 * кнопки-действия недоступны: заглушка в Telegram (ПД туда не идут, а значит
 * и действия), пересылка ссылки в WhatsApp. Срок отдельно не шьётся: ответ
 * после срока отклоняет сам запрос (effectiveStatus), а не ключ.
 */
export function operatorAnswerKey(requestId: string): string | null {
  const key = secret();
  if (!key) return null;
  return createHmac('sha256', key).update('seat-answer:v1').update(requestId).digest('base64url').slice(0, 32);
}

export function verifyOperatorAnswerKey(requestId: string, given: string): boolean {
  const expected = operatorAnswerKey(requestId);
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// ── Даты ──────────────────────────────────────────────────────────────────

/** Сегодня по Камчатке, YYYY-MM-DD: даты туров — местные. */
export function kamchatkaToday(now: number = Date.now()): string {
  return new Date(now + 12 * 3600 * 1000).toISOString().slice(0, 10);
}

export function isFutureOrToday(date: string, now: number = Date.now()): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= kamchatkaToday(now);
}

// ── Тексты туристу ────────────────────────────────────────────────────────
// Без ПД: турист знает своё имя; в мессенджер уходит только суть исхода.

export function touristOutcomeText(
  r: { status: SeatRequestStatus; tour_title: string; tour_date: string; participants: number; alt_date: string | null },
  links: { statusUrl: string; bookingUrl: string | null },
): string {
  const what = `«${r.tour_title}», ${r.tour_date}, ${r.participants} чел.`;
  switch (r.status) {
    case 'confirmed':
      return `Оператор подтвердил места: ${what}. Бронь заведена и подтверждена — оплатить можно на странице брони: ${links.bookingUrl ?? links.statusUrl}`;
    case 'declined':
      return `На ${r.tour_date} мест нет: ${what}. Посмотрите другие даты или туры: ${links.statusUrl}`;
    case 'other_date':
      return `На ${r.tour_date} мест нет, оператор предлагает ${r.alt_date}: «${r.tour_title}». Если дата подходит, оформите запрос на неё: ${links.statusUrl}`;
    case 'expired':
      return `Оператор не ответил за 2 часа: ${what}. Это не значит, что мест нет — можно отправить запрос ещё раз или оставить заявку: ${links.statusUrl}`;
    case 'failed':
      return `Оператор ответил, что места есть, но бронь автоматически не завелась: ${what}. Мы разбираемся и свяжемся с вами: ${links.statusUrl}`;
    case 'pending':
      return `Запрос отправлен оператору: ${what}. Ответ придёт сюда в течение 2 часов: ${links.statusUrl}`;
  }
}

/** Ответ оператору после нажатия. */
export function operatorReplyText(
  result:
    | { ok: true; status: SeatRequestStatus; tourTitle: string; date: string }
    | { ok: false; reason: 'not_found' | 'already_answered' | 'expired' | 'bad_date' | 'db_error' | 'not_yours'; status?: SeatRequestStatus },
): string {
  if (result.ok) {
    const what = `«${result.tourTitle}», ${result.date}`;
    switch (result.status) {
      case 'confirmed': return `Принято: бронь на ${what} заведена и подтверждена. Контакты туриста — в кабинете, турист получил ссылку на оплату.`;
      case 'declined': return `Принято: мест на ${what} нет. Турист получит ответ.`;
      case 'other_date': return `Принято: туристу предложена другая дата для ${what}.`;
      case 'failed': return `Бронь на ${what} не завелась: учёт платформы видит эту дату закрытой или занятой (см. календарь и вместимость тура в кабинете). Туристу сказано, что мы разбираемся; администратор видит запрос.`;
      default: return `Ответ по ${what} записан.`;
    }
  }
  switch (result.reason) {
    case 'expired': return 'Срок ответа (2 часа) вышел — туристу уже сказано, что ответа не было. Он может отправить запрос снова.';
    case 'already_answered': return 'На этот запрос уже ответили.';
    case 'not_found': return 'Запрос не найден.';
    case 'not_yours': return 'Этот запрос адресован другому оператору.';
    case 'bad_date': return 'Дата должна быть не раньше сегодняшней.';
    case 'db_error': return 'Не удалось записать ответ — база не ответила. Нажмите ещё раз через минуту.';
  }
}
