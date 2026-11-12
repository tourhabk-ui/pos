/**
 * lib/stay/other-stays-notice.ts — сообщение гостю после ответа хозяина
 * «Занято»: другое жильё на те же ночи (план «после отказа», этап 5).
 *
 * Это отдельное сообщение Ведара, а не слова хозяина: хозяин ответил только
 * про свой объект. Поэтому оно не идёт в переписку заявки его реплике, а
 * уходит гостю напрямую в подключённый MAX; гость без MAX и ИИ-агент читают
 * тот же список в виде заявки (lib/stay/other-stays-status).
 *
 * Правила:
 *  - только после записанного «Занято» и только пока заезд впереди;
 *  - список — тот же загрузчик, что у вида заявки (lib/stay/other-stays);
 *  - имени и телефона гостя в чтении нет; сообщение уходит в чат самого гостя;
 *  - исход назван хозяину и менеджеру как есть: «ушло в MAX» / «увидит на
 *    странице заявки» / ничего (не нашли, не прочиталось, зона не размечена);
 *  - сбой не отменяет записанный ответ хозяина и не роняет нажатие.
 *
 * Только сервер. Сторожа: tests/unit/other-stays.test.ts (вызовом),
 * tests/integration/request-chat.pg.test.ts (сцена «другое жильё на даты»).
 */
import { pool } from '@/lib/db-pool';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { loadOtherStays, type OtherStay } from '@/lib/stay/other-stays';
import { getPublicBaseUrl } from '@/lib/config';
import {
  OTHER_STAYS_LIMIT_NOTE_RU, OTHER_STAYS_NOT_ANSWER_RU, OTHER_STAYS_ORDER_NOTE_RU, otherStayDatesWords, otherStayTypeWords,
} from '@/lib/stay/other-stays-words';
import { escapeHtml } from '@/lib/text/escape-html';

const LOG = '[other-stays-notice]';

/** Срок одной отправки гостю. */
export const OTHER_STAYS_SEND_TIMEOUT_MS = 8_000;

/** Заявка с ответом «Занято»: объект, ночи, гости и подключённый MAX гостя. */
export const OTHER_STAYS_SUBJECT_SQL = `
  SELECT s.accommodation_id::text AS accommodation_id, a.name AS accommodation_name,
         s.check_in_date::text AS check_in, s.check_out_date::text AS check_out,
         s.guests::int AS guests, s.guest_max_chat_id::text AS guest_chat
    FROM stay_requests s
    JOIN accommodations a ON a.id = s.accommodation_id
   WHERE s.id = $1::uuid AND s.owner_answer = 'busy'`;

/** Чем кончилось — для слов хозяину и менеджеру. */
export type OtherStaysTold =
  /** Сообщение принял MAX гостя. */
  | { state: 'sent'; names: string[] }
  /** Список есть, но чата у гостя нет или он сообщение не принял — список на странице заявки. */
  | { state: 'page'; names: string[] }
  /** Называть нечего или нечем: не нашли, зона не размечена, заезд прошёл, не прочиталось. */
  | { state: 'nothing' };

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

export interface OtherStaysNoticeDeps {
  query?: Query;
  load?: typeof loadOtherStays;
  sendMax?: (chatId: string, text: string) => Promise<{ ok: boolean }>;
  now?: () => number;
  timeoutMs?: number;
}

function ruDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Сообщение гостю. HTML для MAX. Сказано, чьё это сообщение, что «свободно» —
 * календарь, а не слово хозяина, кому уйдут данные и каким правилом идёт
 * список.
 */
export function guestOtherStaysText(a: {
  refusedName: string; zoneName: string; checkIn: string; checkOut: string; guests: number | null; items: readonly OtherStay[];
}): string {
  const lines = a.items.map((s, i) => {
    const type = otherStayTypeWords(s.type);
    return `${i + 1}. «${escapeHtml(clip(s.name))}»${type ? ` (${type.toLowerCase()})` : ''} — ${otherStayDatesWords(s, a.guests)}. Заявка: ${escapeHtml(s.url)}`;
  });
  return [
    `<b>Другое жильё на ваши даты — ${escapeHtml(a.zoneName)}</b>`,
    `С ${ruDay(a.checkIn)} по ${ruDay(a.checkOut)}${a.guests ? `, гостей: ${a.guests}` : ''}. Это сообщение Ведара, а не хозяина «${escapeHtml(clip(a.refusedName))}».`,
    ...lines,
    `${OTHER_STAYS_LIMIT_NOTE_RU} ${escapeHtml(`${getPublicBaseUrl()}/accommodations`)}`,
    OTHER_STAYS_NOT_ANSWER_RU,
    OTHER_STAYS_ORDER_NOTE_RU,
  ].join('\n');
}

async function defaultSendMax(chatId: string, text: string): Promise<{ ok: boolean }> {
  const { maxSendDm } = await import('@/lib/notifications/max-channel');
  return maxSendDm(chatId, text);
}

async function inTime<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([p.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Назвать гостю другое жильё после «Занято». Никогда не бросает: это довесок
 * к записанному ответу хозяина.
 */
export async function tellGuestOtherStays(requestId: string, deps: OtherStaysNoticeDeps = {}): Promise<OtherStaysTold> {
  const q: Query = deps.query ?? ((sql, params) => pool.query(sql, params));
  try {
    const subject = (await q(OTHER_STAYS_SUBJECT_SQL, [requestId])).rows[0] as {
      accommodation_id: string; accommodation_name: string; check_in: string; check_out: string; guests: number | null; guest_chat: string | null;
    } | undefined;
    // Ответ не «Занято» или заезд уже прошёл — называть нечего.
    if (!subject || subject.check_in < kamchatkaToday((deps.now ?? Date.now)())) return { state: 'nothing' };
    const guests = Number(subject.guests ?? 0) > 0 ? Math.trunc(Number(subject.guests)) : null;
    const stays = await (deps.load ?? loadOtherStays)({
      accommodationId: subject.accommodation_id, checkIn: subject.check_in, checkOut: subject.check_out, guests,
    });
    if (stays.state !== 'ok') {
      if (stays.state === 'failed') console.warn(`${LOG} другое жильё по заявке ${requestId} не прочиталось — гостю не названо`);
      return { state: 'nothing' };
    }
    const names = stays.items.map((s) => s.name);
    if (!subject.guest_chat) return { state: 'page', names };
    const text = guestOtherStaysText({
      refusedName: subject.accommodation_name, zoneName: stays.zoneName, checkIn: subject.check_in, checkOut: subject.check_out,
      guests, items: stays.items,
    });
    const sent = await inTime((deps.sendMax ?? defaultSendMax)(subject.guest_chat, text), deps.timeoutMs ?? OTHER_STAYS_SEND_TIMEOUT_MS);
    if (sent?.ok) return { state: 'sent', names };
    console.warn(`${LOG} MAX гостя по заявке ${requestId} сообщение о другом жилье не принял — список остаётся на странице заявки`);
    return { state: 'page', names };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error(`${LOG} другое жильё по заявке ${requestId} гостю не названо, SQLSTATE`, typeof code === 'string' ? code : 'нет SQLSTATE');
    return { state: 'nothing' };
  }
}
