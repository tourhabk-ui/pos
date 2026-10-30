/**
 * Нажатие «Свободно, беру» / «Занято» / «Позвоню сам» хозяином жилья — в его
 * личном чате (MAX, Telegram) и в карточке кабинета в чате. Одно правило для
 * всех дверей (answerStayRequest):
 *
 *  - заявка обязана быть его: скоуп — объект заявки принадлежит карточке
 *    партнёра привязанного чата (accommodations.partner_id);
 *  - ответ пишется один раз в саму заявку (stay_requests.owner_answer, 1359):
 *    UPDATE … WHERE owner_answer IS NULL — повтор ничего не меняет и назван;
 *  - после записи: гостю — его словами в переписку заявки (1349: MAX гостя
 *    или страница заявки; это же сообщение снимает заявку с ожидания во
 *    «Входящих»), менеджеру Ведара — факт без имени и телефона гостя. Отказ
 *    следствий записанный ответ не отменяет: он назван в логе и хозяину
 *    («сообщение гостю не ушло — позвоните»).
 *
 * Бронь этим не создаётся, даты не закрываются, оплата не открывается (1206).
 */
import { pool } from '@/lib/db-pool';
import { tgSend } from '@/lib/notifications/tg-send';
import { postOwnerMessage } from '@/lib/requests/request-chat-service';
import { isChatTargetId, ownerReplyButton } from '@/lib/requests/request-chat';
import { requestAnswerEditText } from '@/lib/rental/request-answer';
import type { PartnerChatLookup } from '@/lib/kuzmich/operator-chat';
import {
  guestStayAnswerText, managerStayAnswerText, ownerStayAnswerText, parseStayAnswerPress,
  type GuestTold, type StayAnswerFacts, type StayAnswerTell, type StayOwnerAnswer,
} from '@/lib/stay/owner-answer';

export type StayAnswerVia = 'max' | 'telegram' | 'site';

export interface StayAnswerActor {
  partnerId: string;
  partnerName: string;
}

interface Db { query: typeof pool.query }

/** Записать ответ: только своя заявка и только первый раз. */
export const ANSWER_STAY_SQL = `
  UPDATE stay_requests s
     SET owner_answer = $3, owner_answered_at = NOW(), owner_answer_via = $4
    FROM accommodations a
   WHERE s.id = $1::uuid AND a.id = s.accommodation_id AND a.partner_id = $2::uuid
     AND s.owner_answer IS NULL
  RETURNING a.name AS accommodation_name, s.check_in_date::text AS check_in, s.check_out_date::text AS check_out, s.guests::int AS guests`;

/** Почему не записалось: чужая, уже отвечена или нет такой. */
export const WHY_NOT_ANSWERED_SQL = `
  SELECT (a.partner_id = $2::uuid) AS mine, s.owner_answer
    FROM stay_requests s
    JOIN accommodations a ON a.id = s.accommodation_id
   WHERE s.id = $1::uuid`;

async function tellManager(text: string): Promise<void> {
  const sent = await tgSend('stay-request-answer', text);
  if (!sent.ok) console.error(`[stay-request-answer] менеджеру не доставлено: ${sent.reason}`);
}

/** Гостю — в переписку заявки. true/false — записано и видно / нет; отказ назван в логе. */
async function tellGuest(requestId: string, text: string): Promise<GuestTold> {
  if (!isChatTargetId(requestId)) return null;
  try {
    const r = await postOwnerMessage({ kind: 'stay', id: requestId }, text);
    if (r.outcome === 'sent') return r.pageVisible !== false;
    console.error(`[stay-request-answer] гостю по заявке ${requestId} не сообщено: ${r.outcome}`);
    return false;
  } catch (err) {
    console.error('[stay-request-answer] гостю не сообщено:', err instanceof Error ? err.message : err);
    return false;
  }
}

export async function answerStayRequest(opts: {
  partner: StayAnswerActor;
  requestId: string;
  answer: StayOwnerAnswer;
  via: StayAnswerVia;
  db?: Db;
  notifyManager?: (text: string) => Promise<void>;
}): Promise<{ tell: StayAnswerTell; facts: StayAnswerFacts | null }> {
  const db = opts.db ?? pool;
  const notify = opts.notifyManager ?? tellManager;
  let facts: StayAnswerFacts | null = null;
  try {
    const { rows } = await db.query<{ accommodation_name: string; check_in: string; check_out: string; guests: number }>(
      ANSWER_STAY_SQL, [opts.requestId, opts.partner.partnerId, opts.answer, opts.via],
    );
    if (rows[0]) {
      facts = { accommodationName: rows[0].accommodation_name, checkIn: rows[0].check_in, checkOut: rows[0].check_out, guests: rows[0].guests };
    } else {
      const why = await db.query<{ mine: boolean; owner_answer: StayOwnerAnswer | null }>(WHY_NOT_ANSWERED_SQL, [opts.requestId, opts.partner.partnerId]);
      const w = why.rows[0];
      if (!w) return { tell: { kind: 'missing' }, facts: null };
      if (!w.mine) return { tell: { kind: 'not_yours' }, facts: null };
      if (w.owner_answer) return { tell: { kind: 'already', answer: w.owner_answer }, facts: null };
      return { tell: { kind: 'retry' }, facts: null };
    }
  } catch (err) {
    console.error('[stay-request-answer] ответ не записан, SQLSTATE', (err as { code?: string }).code ?? 'нет', err instanceof Error ? err.message : err);
    return { tell: { kind: 'retry' }, facts: null };
  }

  // Ответ записан; дальше — следствия, каждое само по себе и каждое с логом.
  const guestTold = await tellGuest(opts.requestId, guestStayAnswerText(facts, opts.answer));
  try {
    await notify(managerStayAnswerText({ partnerName: opts.partner.partnerName, requestId: opts.requestId, answer: opts.answer, facts }));
  } catch (err) {
    console.error('[stay-request-answer] менеджеру не доставлено:', err instanceof Error ? err.message : err);
  }
  return { tell: { kind: 'answered', answer: opts.answer, guestTold }, facts };
}

/**
 * Отправка ответа хозяину. `editMid` — сообщение с кнопками, которое можно
 * заменить (null — новым сообщением). `keep` — кнопки, которые остаются под
 * ответом («Ответить гостю»): вызывающий ставит их, если канал умеет (MAX).
 */
export type StayAnswerSend = (
  text: string,
  editMid: string | null,
  keep?: Array<{ text: string; payload: string }>,
) => Promise<void>;

/** Исход, после которого сообщение заявки правится (ответ записан или уже был). */
const EDITS_REQUEST: ReadonlySet<StayAnswerTell['kind']> = new Set(['answered', 'already']);

export async function handleStayAnswerPress(opts: {
  lookup: PartnerChatLookup;
  payload: string;
  editMid: string | null;
  originalText: string | null;
  via: StayAnswerVia;
  send: StayAnswerSend;
  notifyManager?: (text: string) => Promise<void>;
}): Promise<void> {
  const press = parseStayAnswerPress(opts.payload);
  const say = async (tell: StayAnswerTell, keep?: Array<{ text: string; payload: string }>) => {
    const line = ownerStayAnswerText(tell);
    const edit = EDITS_REQUEST.has(tell.kind);
    await opts.send(edit ? requestAnswerEditText(opts.originalText, line) : line, edit ? opts.editMid : null, keep);
  };
  if (!press) return say({ kind: 'unparsed' });
  if (opts.lookup.outcome === 'unavailable') return say({ kind: 'unread' });
  if (opts.lookup.outcome !== 'found') return say({ kind: 'not_yours' });

  const { tell } = await answerStayRequest({
    partner: { partnerId: opts.lookup.partner.partnerId, partnerName: opts.lookup.partner.partnerName },
    requestId: press.requestId,
    answer: press.answer,
    via: opts.via,
    notifyManager: opts.notifyManager,
  });
  // Переписка остаётся: хозяин может дописать гостю словами (только MAX).
  const keep = opts.via === 'max' && isChatTargetId(press.requestId) ? [ownerReplyButton({ kind: 'stay', id: press.requestId })] : undefined;
  await say(tell, keep);
}
