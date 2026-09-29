/**
 * Запрос свободных мест у оператора — чистая часть (без базы).
 *
 * Решения владельца 29.09: ответ оператора одним нажатием в мессенджере;
 * «Есть места» сразу создаёт и подтверждает бронь; на ответ 2 часа; ответ
 * туристу — туда, где ему удобно. Схема — миграция 1105.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { escapeHtml } from '@/lib/text/escape-html';

/** Срок ответа оператора — решение владельца 29.09 («2 часа»). */
export const SEAT_REQUEST_DEADLINE_MS = 2 * 60 * 60 * 1000;

export const SEAT_REQUEST_STATUSES = [
  'pending', 'confirmed', 'declined', 'other_date', 'expired', 'failed',
] as const;
export type SeatRequestStatus = (typeof SEAT_REQUEST_STATUSES)[number];

/** Почему запрос 'failed' (миграция 1105, failure_kind). */
export const FAILURE_KINDS = ['delivery', 'accounting', 'system', 'unfinished'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

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
  if (!expected || typeof given !== 'string') return false;
  // Сравниваются БАЙТЫ: строка из многобайтных символов той же длины в
  // символах даёт буфер другой длины, а timingSafeEqual на таком бросает
  // исключение — анонимный запрос получал бы 500 вместо отказа.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Даты ──────────────────────────────────────────────────────────────────

/** Сегодня по Камчатке, YYYY-MM-DD: даты туров — местные. */
export function kamchatkaToday(now: number = Date.now()): string {
  return new Date(now + 12 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Настоящая календарная дата: 2026-02-31 формой YYYY-MM-DD проходит, а датой не является. */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function isFutureOrToday(date: string, now: number = Date.now()): boolean {
  return isRealDate(date) && date >= kamchatkaToday(now);
}

// ── Тексты туристу ────────────────────────────────────────────────────────
// Без ПД: турист знает своё имя; в мессенджер уходит только суть исхода.
// Название тура экранируется: оба канала шлют HTML, и «<b>» в названии иначе
// ломал бы или подменял разметку.

/**
 * `statusUrl` — страница запроса туриста; null, если ссылку собрать не из чего
 * (ключ страницы не сохранён зашифрованным). Тогда текст не отсылает «на
 * страницу», которой туристу не назвали.
 */
export function touristOutcomeText(
  r: {
    status: SeatRequestStatus; tour_title: string; tour_date: string; participants: number; alt_date: string | null;
    /** Причина 'failed': 'unfinished' — ответ оператора неизвестен, «места есть» утверждать нельзя. */
    failure_kind?: FailureKind | null;
  },
  links: { statusUrl: string | null; bookingUrl: string | null },
): string {
  const title = escapeHtml(r.tour_title);
  const what = `«${title}», ${r.tour_date}, ${r.participants} чел.`;
  const more = links.statusUrl ? `: ${links.statusUrl}` : '.';
  switch (r.status) {
    case 'confirmed': {
      const pay = links.bookingUrl
        ? ` Оплатить можно на странице брони: ${links.bookingUrl}`
        : links.statusUrl
          ? ` Ссылка на оплату — на странице запроса: ${links.statusUrl}`
          : ' Оператор свяжется с вами по указанному телефону.';
      return `Оператор подтвердил места: ${what}. Бронь заведена и подтверждена.${pay}`;
    }
    case 'declined':
      return `На ${r.tour_date} мест нет: ${what}. Можно посмотреть другие даты или туры${more}`;
    case 'other_date':
      return `На ${r.tour_date} мест нет, оператор предлагает ${r.alt_date}: «${title}». Если дата подходит, отправьте запрос на неё${more}`;
    case 'expired':
      return `Оператор не ответил за 2 часа: ${what}. Это не значит, что мест нет — можно отправить запрос ещё раз или оставить заявку${more}`;
    case 'failed':
      // Разные исходы под одним статусом: где ответ оператора известен («места
      // есть»), а бронь не завелась, — и где сам ответ потерян. Во втором
      // случае «оператор ответил, что места есть» было бы выдумкой.
      if (r.failure_kind === 'unfinished') {
        return `Мы уточняем ответ оператора: ${what}. Бронь пока не заведена — свяжемся с вами${more}`;
      }
      if (r.failure_kind === 'delivery') {
        return `Запрос до оператора не дошёл: ${what}. Оставьте заявку — менеджер свяжется с оператором сам${more}`;
      }
      return `Оператор ответил, что места есть, но бронь автоматически не завелась: ${what}. Мы разбираемся и свяжемся с вами${more}`;
    case 'pending':
      return `Запрос отправлен оператору: ${what}. Ответ придёт сюда в течение 2 часов${more}`;
  }
}

/** Что сталось с сообщением туристу (notifyTourist). */
export type TouristMessageState = 'sent' | 'no_chat' | 'failed' | 'not_final';

export type OperatorReplyInput =
  | {
      ok: true;
      status: SeatRequestStatus;
      tourTitle: string;
      date: string;
      failureKind?: FailureKind | null;
      touristMessage?: TouristMessageState;
      /** Уведомление оператору с контактами туриста дошло (false — нет; null/undefined — не применимо). */
      operatorNotified?: boolean | null;
    }
  | {
      ok: false;
      reason:
        | 'not_found' | 'already_answered' | 'expired' | 'date_past' | 'bad_date'
        | 'db_error' | 'accepted_unfinished' | 'not_yours';
      status?: SeatRequestStatus;
    };

/**
 * Ответ оператору после нажатия. Говорит только то, что известно.
 *
 * `html` — куда уходит текст: в MAX/Telegram (оба шлют HTML, название
 * экранируется) или на веб-страницу ответа (React выводит строку как текст,
 * экранирование там показало бы оператору «&amp;» вместо «&»).
 */
export function operatorReplyText(result: OperatorReplyInput, opts: { html?: boolean } = {}): string {
  if (result.ok) {
    const title = opts.html === false ? result.tourTitle : escapeHtml(result.tourTitle);
    const what = `«${title}», ${result.date}`;
    switch (result.status) {
      case 'confirmed': {
        const tourist = result.touristMessage === 'sent'
          ? 'Турист получил ссылку на оплату в мессенджер.'
          : 'Турист увидит бронь на странице запроса; в мессенджер сообщение не ушло.';
        const contacts = result.operatorNotified === false
          ? 'Уведомление с контактами туриста сюда доставить не удалось — их передаст администратор (бронь уже в вашем кабинете).'
          : 'Контакты туриста придут отдельным уведомлением о брони (в MAX или в кабинет; если у вас нет ни того ни другого — их передаст администратор).';
        return `Принято: бронь на ${what} заведена и подтверждена. ${tourist} ${contacts}`;
      }
      case 'declined': return `Принято: мест на ${what} нет. Турист получит ответ.`;
      case 'other_date': return `Принято: туристу предложена другая дата для ${what}.`;
      case 'failed':
        return result.failureKind === 'accounting'
          ? `Бронь на ${what} не завелась: учёт платформы её не принял — дата закрыта или занята, группа больше вместимости либо тур снят с публикации (проверьте календарь и вместимость тура в кабинете). Туристу сказано, что мы разбираемся; администратор увидит запрос в течение часа.`
          : `Бронь на ${what} не завелась из-за сбоя на нашей стороне, не из-за вашей даты. Проверьте раздел броней в кабинете: если бронь там есть, подтвердите её. Туристу сказано, что мы разбираемся; администратор увидит запрос в течение часа.`;
      default: return `Ответ по ${what} записан.`;
    }
  }
  switch (result.reason) {
    case 'expired': return 'Срок ответа (2 часа) вышел — туристу уже сказано, что ответа не было. Он может отправить запрос снова.';
    case 'date_past': return 'Дата запроса уже прошла — ответ не принимается. Турист может отправить новый запрос на другую дату.';
    case 'already_answered': return 'На этот запрос уже ответили.';
    case 'not_found': return 'Запрос не найден.';
    case 'not_yours': return 'Этот запрос адресован другому оператору.';
    case 'bad_date': return 'Дата должна быть не раньше сегодняшней.';
    case 'accepted_unfinished': return 'Ответ принят, но записать исход не удалось. Повторно не нажимайте: запрос подберёт уборщик, а администратор увидит его в течение часа.';
    case 'db_error': return 'Не удалось записать ответ — база не ответила, ничего не сохранено. Нажмите ещё раз через минуту.';
  }
}
