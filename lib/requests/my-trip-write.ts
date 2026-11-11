/**
 * lib/requests/my-trip-write.ts — «Написать оператору» из «Моей поездки»
 * (#2970, шаг 3, слово владельца 11.11 «п1 делай»).
 *
 * Переписка по заявке (1349, 1350) у клиента открывалась только ссылкой
 * `sq_<ключ>`: заявка, созданная в чате Кузьмича, в «Моей поездке» видна, а
 * написать по ней было нельзя — чат не подключён к заявке. Кнопка под
 * «Моей поездкой» делает это по той же связи, по которой заявка в списке:
 *
 *   1. заявка привязана к ЭТОМУ чату (`chat_request_links`, 1416) живым
 *      ключом, и ключ открывает переписку (`opens_chat`: ключ новой заявки,
 *      а не повтора — повтор получил бы и знающий чужой телефон);
 *   2. чат клиента подключается к заявке, только если к ней не подключён
 *      другой чат (`guest_max_chat_id` пуст или этот же) — как у `sq_`;
 *   3. дальше — общее ожидание следующего сообщения (`armChatWait`).
 *
 * Только MAX: клиент пишет по заявке из MAX и со страницы заявки
 * (lib/requests/request-chat), Telegram клиента переписка не знает.
 * Кнопка — запись (подключает чат): подписывается (`signPayload`) и
 * принимается только по заверенному апдейту личного диалога.
 */
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { CHAT_TEXT } from '@/lib/requests/request-chat';
import { armChatWait, type ChatReply } from '@/lib/requests/request-chat-service';
import { parseMyTripWrite } from '@/lib/requests/my-trip-ask';

export { isMyTripWritePayload, myTripWritePayload, myTripWriteText, parseMyTripWrite } from '@/lib/requests/my-trip-ask';

/**
 * Связь ЭТОГО чата MAX с заявкой: живой ключ из `chat_request_links`.
 * `opens_chat` — хоть один такой ключ открывает переписку.
 */
export const MY_TRIP_WRITE_LINK_SQL = `
  SELECT BOOL_OR(k.opens_chat OR k.stay_request_id IS NOT NULL) AS opens_chat
    FROM chat_request_links c
    JOIN agent_request_keys k ON k.id = c.key_id
   WHERE c.channel = 'max' AND c.chat_id = $1
     AND k.expires_at > NOW()
     AND (k.lead_id = $2::uuid OR k.stay_request_id = $2::uuid)`;

/** Подключить чат клиента к лиду: чужой чат не перезаписывается. */
export const MY_TRIP_BIND_LEAD_SQL = `
  UPDATE leads
     SET guest_max_chat_id = $2::bigint,
         guest_chat_bound_at = COALESCE(guest_chat_bound_at, NOW())
   WHERE id = $1::uuid
     AND (guest_max_chat_id IS NULL OR guest_max_chat_id = $2::bigint)
  RETURNING id::text AS id`;

/** То же для заявки на жильё. */
export const MY_TRIP_BIND_STAY_SQL = `
  UPDATE stay_requests
     SET guest_max_chat_id = $2::bigint,
         guest_chat_bound_at = COALESCE(guest_chat_bound_at, NOW())
   WHERE id = $1::uuid
     AND (guest_max_chat_id IS NULL OR guest_max_chat_id = $2::bigint)
  RETURNING id::text AS id`;

function logFail(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  console.error(
    `[my-trip-write] ${what}:`,
    typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет',
    logText(err instanceof Error ? err.message : err, 160),
  );
}

/**
 * Нажатие «Написать оператору» под «Моей поездкой» в MAX. Право — по связи
 * чата с заявкой; отказ базы — «не смог проверить», не «не ваша».
 */
export async function pressMyTripWrite(payload: string, chatId: number): Promise<ChatReply> {
  const target = parseMyTripWrite(payload);
  if (!target) return { text: 'Кнопка не распознана — ничего не отправлено. Откройте «Моя поездка» заново.', buttons: [] };
  try {
    const { rows: [link] } = await pool.query<{ opens_chat: boolean | null }>(MY_TRIP_WRITE_LINK_SQL, [String(chatId), target.id]);
    // Нет живой связи — заявка не этого чата (или ключ истёк).
    if (!link || link.opens_chat === null) return { text: CHAT_TEXT.notYoursGuest, buttons: [] };
    if (link.opens_chat !== true) return { text: CHAT_TEXT.bindNoChat, buttons: [] };
    const { rows: [bound] } = await pool.query<{ id: string }>(
      target.kind === 'stay' ? MY_TRIP_BIND_STAY_SQL : MY_TRIP_BIND_LEAD_SQL,
      [target.id, String(chatId)],
    );
    // К заявке подключён другой чат MAX: переписку себе не забираем.
    if (!bound) return { text: CHAT_TEXT.notYoursGuest, buttons: [] };
  } catch (err) {
    logFail('связь чата с заявкой не проверена', err);
    return { text: CHAT_TEXT.unchecked, buttons: [] };
  }
  return armChatWait('guest', target, chatId, 'max');
}
