/**
 * Нажатие «Беру» / «Не могу» в личном чате партнёра и в его кабинете на
 * сайте (answerRentalRequest — одно правило для обеих дверей). Два вида
 * заявки под одной кнопкой (вид читается из лида, не из payload):
 *
 *  - прокат (прокатчик пилота, `car_rental`): ответ и отметка дней — одна
 *    транзакция, второе нажатие дни не меняет; менеджеру — факт без ПД;
 *  - машина целиком (перевозчик, `charter`, #2862 этап A, 30.10): любой
 *    перевозчик с привязанным чатом, без пилотного списка. Дни не отмечаются
 *    и машина не закрепляется (§14). После записи ответа: статус лида
 *    («Беру» → contacted, «Не могу» → lost) той же дверью, что у оператора и
 *    гида (lib/leads/owner-lead-status), заказчику — сообщение в переписку
 *    заявки (1350) от имени перевозчика, менеджеру Ведара — факт без ПД
 *    («Не могу» — «нужен другой перевозчик»). Отказ любого из трёх шагов не
 *    отменяет записанный ответ: он назван в логе и, для заказчика, в ответе
 *    партнёру («сообщение не ушло — свяжитесь сами»).
 *
 * Кнопка из списка «Заявки» (с номером строки) список не правит: в нём
 * кнопки других заявок. Ответ — отдельным сообщением, первой строкой
 * названа заявка. Кнопка под самой заявкой правит её сообщение, как раньше.
 */

import { tgSend } from '@/lib/notifications/tg-send';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import {
  clientCharterAnswerText, managerAnswerText, parseRequestAnswer, partnerAnswerText, requestAnswerEditText,
  requestAnswerListHead,
  type AnswerTell, type ClientTold, type RequestAnswer,
} from '@/lib/rental/request-answer';
import {
  claimPartnerAnswer, loadOwnedRentalRequest, resolveRequestOffer, type OwnedRentalRequest,
} from '@/lib/rental/request-answer-store';
import { changeLeadStatus } from '@/lib/leads/owner-lead-status';
import { postOwnerMessage } from '@/lib/requests/request-chat-service';
import { isChatTargetId, ownerReplyButton } from '@/lib/requests/request-chat';
import type { OwnerStatusVia } from '@/lib/bookings/owner-status';

export interface AnswerActor {
  partnerId: string;
  partnerName: string;
  slug?: string | null;
  /** `partners.user_id` — от чьего имени меняется статус лида; null — у карточки нет аккаунта. */
  userId?: string | null;
}

export type AnswerLookup =
  | { outcome: 'found'; partner: AnswerActor }
  | { outcome: 'unavailable' | 'none' };

/**
 * Отправка ответа партнёру. `editMid` — сообщение с кнопками, которое можно
 * заменить (null — новым сообщением). `keep` — кнопки, которые остаются под
 * ответом («Ответить клиенту» у заявки на машину): вызывающий ставит их,
 * если канал умеет (MAX); Telegram переписки не ведёт и их не ставит.
 */
export type AnswerSend = (
  text: string,
  editMid: string | null,
  keep?: Array<{ text: string; payload: string }>,
) => Promise<void>;

function spanOrNull(from: string | null, to: string | null): { from: string; to: string } | null {
  if (!from || !to) return null;
  return { from, to };
}

async function tellManager(text: string): Promise<void> {
  const sent = await tgSend('rental-request-answer', text);
  if (!sent.ok) {
    console.error(`[rental-request-answer] менеджеру не доставлено: ${sent.reason}`);
  }
}

/** Статус лида после ответа перевозчика: одна дверь с оператором и гидом. */
async function markCharterLeadStatus(partner: AnswerActor, leadId: string, answer: RequestAnswer, via: OwnerStatusVia): Promise<void> {
  try {
    const r = await changeLeadStatus({
      leadId,
      status: answer === 'take' ? 'contacted' : 'lost',
      actor: { kind: 'partner_user', userId: partner.userId ?? null },
      scope: { kind: 'owner', partnerId: partner.partnerId, claimUnowned: false },
      via,
    });
    if (r.kind === 'not_found') console.error(`[charter-request-answer] статус заявки ${leadId} не сменён: заявка не в скоупе перевозчика`);
  } catch (err) {
    console.error('[charter-request-answer] статус заявки не сменён, SQLSTATE', (err as { code?: string }).code ?? 'нет');
  }
}

/** Заказчику — в переписку заявки. true/false — записано и видно / нет; отказ назван в логе. */
async function tellCharterClient(partner: AnswerActor, leadId: string, answer: RequestAnswer): Promise<ClientTold> {
  if (!isChatTargetId(leadId)) return null;
  try {
    const r = await postOwnerMessage({ kind: 'lead', id: leadId }, clientCharterAnswerText(partner.partnerName, answer));
    // Записано и прочитать есть где (MAX клиента или страница заявки с живой ссылкой).
    if (r.outcome === 'sent') return r.pageVisible !== false;
    console.error(`[charter-request-answer] заказчику по заявке ${leadId} не сообщено: ${r.outcome}`);
    return false;
  } catch (err) {
    console.error('[charter-request-answer] заказчику не сообщено:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Ответ партнёра на заявку — одно правило для кнопки в чате и для кабинета
 * на сайте. Заявка обязана быть его; ответ (и у проката — отметка дней) —
 * одна транзакция (claimPartnerAnswer), повтор ничего не меняет. Менеджеру —
 * факт без персональных данных заказчика.
 *
 * request — прочитанная заявка (чат называет её первой строкой ответа из
 * списка); null, если до чтения не дошло или оно не удалось.
 */
export async function answerRentalRequest(opts: {
  partner: AnswerActor;
  leadId: string;
  answer: RequestAnswer;
  /** Откуда нажато — в событие ленты CRM у заявки на машину. */
  via?: OwnerStatusVia;
  notifyManager?: (text: string) => Promise<void>;
}): Promise<{ tell: AnswerTell; request: OwnedRentalRequest | null }> {
  const notify = opts.notifyManager ?? tellManager;
  const partner = opts.partner;

  const loaded = await loadOwnedRentalRequest(partner.partnerId, opts.leadId);
  if (loaded.outcome !== 'ok') {
    const kind = loaded.outcome === 'missing' ? 'missing' as const
      : loaded.outcome === 'db_error' ? 'unread' as const
      : 'not_yours' as const;
    return { tell: { kind }, request: null };
  }
  const request = loaded.request;
  // Прокат — только пилот (кабинет проката включается списком); машина
  // целиком — каждому перевозчику с привязанным чатом (решение 30.10).
  if (request.kind === 'car_rental' && !isRentalPilotSlug(partner.slug)) return { tell: { kind: 'not_pilot' }, request: null };

  if (request.kind === 'charter') return answerCharter(partner, request, opts.answer, opts.via ?? 'max', notify);

  const offer = opts.answer === 'take'
    ? await resolveRequestOffer(partner.partnerId, request.offerId, request.title)
    : null;
  if (offer?.outcome === 'db_error') return { tell: { kind: 'retry' }, request };
  const span = offer?.outcome === 'ok' ? spanOrNull(request.dateFrom, request.dateTo) : null;
  const carTitle = offer?.outcome === 'ok' ? offer.title : request.title;
  const claimed = await claimPartnerAnswer({
    leadId: request.leadId,
    answer: opts.answer,
    kind: 'car_rental',
    partnerId: partner.partnerId,
    offerId: offer?.outcome === 'ok' ? offer.offerId : request.offerId,
    carTitle,
    dateFrom: span?.from ?? request.dateFrom,
    dateTo: span?.to ?? request.dateTo,
    mark: offer?.outcome === 'ok' && span
      ? { offerId: offer.offerId, dateFrom: span.from, dateTo: span.to }
      : null,
  });
  if (claimed.outcome === 'db_error') return { tell: { kind: 'retry' }, request };
  if (claimed.outcome === 'already') return { tell: { kind: 'already', answer: claimed.answer }, request };

  const tell: AnswerTell = opts.answer === 'decline'
    ? { kind: 'decline' }
    : claimed.marked !== null && span
      ? { kind: 'take', from: span.from, to: span.to, marked: claimed.marked }
      : offer?.outcome === 'ok' && !span
        ? { kind: 'take_bad_dates' }
        : { kind: 'take_no_car' };
  try {
    await notify(managerAnswerText({
      kind: 'car_rental',
      partnerName: partner.partnerName,
      leadId: request.leadId,
      answer: opts.answer,
      carTitle,
      from: request.dateFrom,
      to: request.dateTo,
      marked: opts.answer === 'take' ? claimed.marked : null,
    }));
  } catch (err) {
    console.error('[rental-request-answer] менеджеру не доставлено:', err instanceof Error ? err.message : err);
  }
  return { tell, request };
}

async function answerCharter(
  partner: AnswerActor,
  request: OwnedRentalRequest,
  answer: RequestAnswer,
  via: OwnerStatusVia,
  notify: (text: string) => Promise<void>,
): Promise<{ tell: AnswerTell; request: OwnedRentalRequest }> {
  const claimed = await claimPartnerAnswer({
    leadId: request.leadId,
    answer,
    kind: 'charter',
    partnerId: partner.partnerId,
    offerId: null,
    carTitle: request.title,
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    mark: null,
  });
  if (claimed.outcome === 'db_error') return { tell: { kind: 'retry' }, request };
  if (claimed.outcome === 'already') return { tell: { kind: 'already', answer: claimed.answer }, request };

  // Ответ записан; дальше — следствия, каждое само по себе и каждое с логом.
  await markCharterLeadStatus(partner, request.leadId, answer, via);
  const clientTold = await tellCharterClient(partner, request.leadId, answer);
  try {
    await notify(managerAnswerText({
      kind: 'charter',
      partnerName: partner.partnerName,
      leadId: request.leadId,
      answer,
      carTitle: request.title,
      from: request.dateFrom,
      to: request.dateTo,
      marked: null,
    }));
  } catch (err) {
    console.error('[charter-request-answer] менеджеру не доставлено:', err instanceof Error ? err.message : err);
  }
  return {
    tell: answer === 'take' ? { kind: 'charter_take', clientTold } : { kind: 'charter_decline', clientTold },
    request,
  };
}

/** Исход, после которого сообщение заявки правится (ответ записан или уже был). */
const EDITS_REQUEST: ReadonlySet<AnswerTell['kind']> = new Set([
  'already', 'decline', 'take', 'take_no_car', 'take_bad_dates', 'charter_take', 'charter_decline',
]);

export async function handleRentalRequestAnswer(opts: {
  lookup: AnswerLookup;
  payload: string;
  editMid: string | null;
  originalText: string | null;
  send: AnswerSend;
  via?: OwnerStatusVia;
  notifyManager?: (text: string) => Promise<void>;
}): Promise<void> {
  const press = parseRequestAnswer(opts.payload);
  /** Заявка, когда она прочитана: из списка ответ без неё не называет, на что дан. */
  let listHead: string | null = null;
  /** Кнопки, которые остаются под ответом: переписка с заказчиком у заявки на машину. */
  let keep: Array<{ text: string; payload: string }> | undefined;
  const say = async (kind: Parameters<typeof partnerAnswerText>[0], edit: boolean) => {
    const line = partnerAnswerText(kind);
    if (press?.listNo !== undefined) {
      await opts.send(listHead ? `${listHead}\n${line}` : line, null, keep);
      return;
    }
    const text = edit ? requestAnswerEditText(opts.originalText, line) : line;
    await opts.send(text, edit ? opts.editMid : null, keep);
  };

  if (!press) {
    await say({ kind: 'unparsed' }, false);
    return;
  }
  if (opts.lookup.outcome === 'unavailable') {
    await say({ kind: 'unread' }, false);
    return;
  }
  if (opts.lookup.outcome !== 'found') {
    await say({ kind: 'not_yours' }, false);
    return;
  }

  const { tell, request } = await answerRentalRequest({
    partner: opts.lookup.partner,
    leadId: press.leadId,
    answer: press.answer,
    via: opts.via,
    notifyManager: opts.notifyManager,
  });
  if (press.listNo !== undefined && request) {
    listHead = requestAnswerListHead({
      listNo: press.listNo, title: request.title, from: request.dateFrom, to: request.dateTo,
    });
  }
  if (request?.kind === 'charter' && isChatTargetId(request.leadId)) keep = [ownerReplyButton({ kind: 'lead', id: request.leadId })];
  await say(tell, EDITS_REQUEST.has(tell.kind));
}
