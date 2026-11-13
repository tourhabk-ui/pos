/**
 * lib/requests/my-trip-cancel.ts — «Отменить заявку» под «Моей поездкой» (1427).
 *
 * Слово владельца 11.11: заявку можно отменить «как самим человеком»; что
 * будет по нажатию — «зависит от ответа»: оператор ещё не ответил — заявка
 * отменяется сразу, уже ответил — ему уходит просьба, отменяет он. Само
 * правило и запись — lib/requests/cancel-request; здесь — дверь чата: чья
 * заявка, вопрос перед отменой и ответ человеку словами на каждый исход.
 *
 * Только заявка на тур на дату (лид `create_booking_request`) — как «Изменить
 * дату»: у машины, проката и жильё «ответил» устроено иначе, их отмена —
 * следующими шагами.
 *
 * Право — та же связь, что у смены даты: заявка привязана к ЭТОМУ чату живым
 * ключом НОВОЙ заявки (`chat_request_links`, `opens_chat`). Ключ повтора
 * получил бы любой, кто знает чужой телефон, тур и дату, — он видит статус,
 * но не отменяет. Адресат при этом не обязателен: большую группу, переданную
 * другим операторам, человек отменить вправе — иначе её раздают дальше.
 *
 * Отмена необратима, поэтому нажатий два: «Отменить заявку» только спрашивает
 * (и говорит, что именно произойдёт), записывает — «Да». Между вопросом и
 * «Да» оператор мог ответить: тогда вместо отмены уходит просьба, и человеку
 * сказано именно это.
 *
 * ПД нет ни в ответе человеку, ни оператору: тур, дата, число людей.
 */
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { escapeHtml } from '@/lib/text/escape-html';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { myTripCancelYesPayload, parseMyTripCancel } from '@/lib/requests/my-trip-ask';
import {
  CANCEL_LEAD_COLUMNS_SQL, CANCEL_LEAD_JOINS_SQL, cancelBlock, cancelLeadByClient, cancelMode, priorCancelRequest,
  type CancelLeadRow, type CancelOutcome,
} from '@/lib/requests/cancel-request';
import { operatorTold } from '@/lib/requests/notify-request-operator';
import type { LinkChannel } from '@/lib/requests/chat-links';
import type { ChatReply } from '@/lib/requests/request-chat-service';

export { isMyTripCancelPayload, myTripCancelAskPayload, myTripCancelYesPayload, parseMyTripCancel } from '@/lib/requests/my-trip-ask';

/**
 * Заявка на тур, привязанная к этому чату ключом новой заявки. `$1` — канал,
 * `$2` — чат, `$3` — лид. Нет строки — заявка не этого чата (или ключ истёк,
 * или это не заявка на тур на дату). Адресат не требуется — см. шапку.
 */
export const MY_TRIP_CANCEL_LEAD_SQL = `
  SELECT ${CANCEL_LEAD_COLUMNS_SQL}
    FROM leads l
    ${CANCEL_LEAD_JOINS_SQL}
   WHERE l.id = $3::uuid
     AND l.is_self = FALSE
     AND EXISTS (
       SELECT 1 FROM chat_request_links c
         JOIN agent_request_keys k ON k.id = c.key_id
        WHERE c.channel = $1 AND c.chat_id = $2
          AND k.lead_id = l.id AND k.expires_at > NOW()
          AND k.opens_chat AND k.tool_name = 'create_booking_request')`;

const TEXT = {
  unknownButton: 'Кнопка не распознана — ничего не изменено. Откройте «Моя поездка» заново.',
  notYours: 'Эта заявка не подключена к этому чату — отменить её здесь нельзя. Откройте «Моя поездка» и выберите заявку из списка.',
  failed: 'Не удалось отменить заявку — это сбой на нашей стороне. Ничего не изменено, повторите через минуту.',
  cancelled: 'Заявка уже отменена — ничего не изменено.',
  closed: 'Заявка уже закрыта — отменять нечего.',
  past: 'Поездка по заявке уже прошла — отменять нечего.',
} as const;

/** Просьба уже есть — словами о том, кому она дошла на деле. */
const ALREADY_REQUESTED = {
  operator: 'Просьба об отмене по этой заявке уже отправлена оператору — повторно не отправляю. Заявка действует, пока он её не закроет; напишите ему или позвоните.',
  manager: 'Просьба об отмене по этой заявке уже передана менеджеру Ведара — повторно не отправляю. Заявка действует, пока её не закроют.',
  pending: 'Просьба об отмене по этой заявке уже отправляется — второе нажатие ничего не добавило. Если ответа на первое нажатие не пришло, нажмите ещё раз через пару минут.',
} as const;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function ruDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

const reply = (text: string, buttons: ChatReply['buttons'] = []): ChatReply => ({ text, buttons });

/** «Тур «…», 14.01.2027, участников 3» — что именно отменяют. */
function headOf(lead: CancelLeadRow): string {
  const date = lead.booking_date ?? lead.date;
  return [
    `Тур «${escapeHtml(lead.tour_title ?? 'тур заявки')}»`,
    date && ISO_DAY.test(date) ? ruDate(date) : null,
    lead.participants && lead.participants > 0 ? `участников ${lead.participants}` : null,
  ].filter(Boolean).join(', ');
}

async function readLead(channel: LinkChannel, chatId: string | number, leadId: string): Promise<CancelLeadRow | null | 'failed'> {
  try {
    const { rows: [row] } = await pool.query<CancelLeadRow>(MY_TRIP_CANCEL_LEAD_SQL, [channel, String(chatId), leadId]);
    return row ?? null;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error(
      '[my-trip-cancel] заявка не прочиталась:',
      typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : 'SQLSTATE=нет',
      logText(err instanceof Error ? err.message : err, 160),
    );
    return 'failed';
  }
}

/** «Отменить заявку»: что произойдёт по «Да». Только чтение. */
async function ask(channel: LinkChannel, chatId: string | number, leadId: string, today: string): Promise<ChatReply> {
  const lead = await readLead(channel, chatId, leadId);
  if (lead === 'failed') return reply(TEXT.failed);
  if (lead === null) return reply(TEXT.notYours);
  const block = cancelBlock(lead, today);
  if (block) return reply(TEXT[block]);
  const head = `${headOf(lead)}.`;
  const yes = (text: string) => [{ text, payload: signPayload(myTripCancelYesPayload(leadId)) }];
  const back = 'Передумали — ничего нажимать не нужно.';
  if (cancelMode(lead) === 'request') {
    const prior = priorCancelRequest(lead);
    if (prior === 'operator' || prior === 'manager' || prior === 'pending') return reply(ALREADY_REQUESTED[prior]);
    return reply(
      (lead.operator_id === null
        ? [
          'Попросить отменить заявку?', head,
          'По заявке уже есть договорённость, поэтому сразу она не отменяется: просьба уйдёт менеджеру Ведара. Заявка действует, пока её не закроют.',
          back,
        ]
        : [
          'Попросить оператора отменить заявку?', head,
          `Оператор уже ответил по заявке, поэтому отменяет он: ему уйдёт ваша просьба. ${lead.booking_status !== null
            ? 'Заявка и бронь действуют, пока он их не закроет.'
            : 'Заявка действует, пока он её не закроет.'}`,
          back,
        ]).join('\n'),
      yes('Да, попросить об отмене'),
    );
  }
  return reply(
    [
      'Отменить заявку?', head,
      lead.operator_id === null
        ? 'Оператора у заявки сейчас нет — она отменится сразу, и дальше её никому не передадут.'
        : 'Оператор ещё не ответил — заявка отменится сразу, оператору уйдёт сообщение.',
      'Вернуть отменённую заявку нельзя: понадобится новая.',
      back,
    ].join('\n'),
    yes('Да, отменить заявку'),
  );
}

const MANAGER_TOLD = ' Менеджер Ведара предупреждён.';

/** Исход отмены — словами человеку. */
export function cancelReplyText(o: CancelOutcome, head: string): string {
  switch (o.kind) {
    case 'cancelled': {
      const done = `Заявка отменена: ${head}.`;
      const again = 'Новую заявку можно оставить здесь же, в чате.';
      if (o.told === 'no_addressee') return `${done} Оператора у неё не было — дальше её никому не передадут. ${again}`;
      if (operatorTold(o.told)) return `${done} Оператору ушло сообщение. ${again}`;
      return `${done} Сообщить оператору сейчас не удалось — в кабинете он увидит её отменённой.${o.manager === 'told' ? MANAGER_TOLD : ''} ${again}`;
    }
    case 'requested':
      if (o.told === 'no_addressee') {
        return 'По заявке уже есть договорённость, поэтому сразу она не отменяется: просьба об отмене передана менеджеру Ведара. Заявка действует, пока её не закроют.';
      }
      return operatorTold(o.told)
        ? 'Оператор уже ответил по заявке, поэтому отменяет он: просьба ему отправлена. Заявка действует, пока он её не закроет.'
        : 'Оператор уже ответил по заявке, поэтому отменяет он. Сообщить ему сейчас не удалось — просьба передана менеджеру Ведара. Заявка остаётся в силе, пока её не закроют; надёжнее написать оператору или позвонить.';
    case 'request_undelivered':
      return o.addressee
        ? 'Оператор уже ответил по заявке, поэтому отменяет он, но передать просьбу сейчас не удалось — ни ему, ни менеджеру Ведара. Заявка остаётся в силе. Нажмите ещё раз через пару минут или напишите оператору, позвоните ему.'
        : 'По заявке уже есть договорённость, поэтому сразу она не отменяется, а передать просьбу менеджеру Ведара сейчас не удалось. Заявка остаётся в силе — нажмите ещё раз через пару минут.';
    case 'already_cancelled': return TEXT.cancelled;
    case 'already_requested': return ALREADY_REQUESTED[o.via];
    case 'closed': return TEXT.closed;
    case 'past': return TEXT.past;
    case 'failed': return TEXT.failed;
  }
}

/** «Да»: отмена сразу или просьба оператору — по тому, что с заявкой СЕЙЧАС. */
async function yes(channel: LinkChannel, chatId: string | number, leadId: string, today: string): Promise<ChatReply> {
  const lead = await readLead(channel, chatId, leadId);
  if (lead === 'failed') return reply(TEXT.failed);
  if (lead === null) return reply(TEXT.notYours);
  const outcome = await cancelLeadByClient({
    lead, channel, today, reread: () => readLead(channel, chatId, leadId),
  });
  return reply(cancelReplyText(outcome, headOf(lead)));
}

/**
 * Нажатие «Отменить заявку» или «Да» под «Моей поездкой» — MAX и Telegram.
 * Канал и чат — того апдейта, в котором нажали (личный диалог).
 */
export async function pressMyTripCancel(
  payload: string, channel: LinkChannel, chatId: string | number, opts: { now?: number } = {},
): Promise<ChatReply> {
  const p = parseMyTripCancel(payload);
  if (!p) return reply(TEXT.unknownButton);
  const today = kamchatkaToday(opts.now);
  return p.kind === 'ask' ? ask(channel, chatId, p.leadId, today) : yes(channel, chatId, p.leadId, today);
}
