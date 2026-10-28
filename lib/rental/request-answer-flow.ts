/**
 * Нажатие «Беру» / «Не могу» в личном чате прокатчика пилота и в его кабинете
 * на сайте (answerRentalRequest — одно правило для обеих дверей).
 * Ответ и отметка дней — одна транзакция: второе нажатие дни не меняет.
 * Менеджеру уходит один факт без персональных данных заказчика.
 *
 * Кнопка из списка «Заявки» (с номером строки) список не правит: в нём
 * кнопки других заявок. Ответ — отдельным сообщением, первой строкой
 * названа заявка. Кнопка под самой заявкой правит её сообщение, как раньше.
 */

import { tgSend } from '@/lib/notifications/tg-send';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import {
  managerAnswerText, parseRequestAnswer, partnerAnswerText, requestAnswerEditText, requestAnswerListHead,
  type AnswerTell, type RequestAnswer,
} from '@/lib/rental/request-answer';
import {
  claimPartnerAnswer, loadOwnedRentalRequest, resolveRequestOffer, type OwnedRentalRequest,
} from '@/lib/rental/request-answer-store';

export interface AnswerActor {
  partnerId: string;
  partnerName: string;
  slug?: string | null;
}

export type AnswerLookup =
  | { outcome: 'found'; partner: AnswerActor }
  | { outcome: 'unavailable' | 'none' };

/** true — сообщение с кнопками заменено. Вызывающий иначе шлёт текст отдельно. */
export type AnswerSend = (text: string, editMid: string | null) => Promise<void>;

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

/**
 * Ответ прокатчика на заявку — одно правило для кнопки в чате и для кабинета
 * на сайте (/hub/carrier/rental). Заявка обязана быть его; ответ и отметка
 * дней — одна транзакция (claimPartnerAnswer), повтор дни не меняет.
 * Менеджеру — факт без персональных данных заказчика.
 *
 * request — прочитанная заявка (чат называет её первой строкой ответа из
 * списка); null, если до чтения не дошло или оно не удалось.
 */
export async function answerRentalRequest(opts: {
  partner: AnswerActor;
  leadId: string;
  answer: RequestAnswer;
  notifyManager?: (text: string) => Promise<void>;
}): Promise<{ tell: AnswerTell; request: OwnedRentalRequest | null }> {
  const notify = opts.notifyManager ?? tellManager;
  const partner = opts.partner;
  if (!isRentalPilotSlug(partner.slug)) return { tell: { kind: 'not_pilot' }, request: null };

  const loaded = await loadOwnedRentalRequest(partner.partnerId, opts.leadId);
  if (loaded.outcome !== 'ok') {
    const kind = loaded.outcome === 'missing' ? 'missing' as const
      : loaded.outcome === 'db_error' ? 'unread' as const
      : 'not_yours' as const;
    return { tell: { kind }, request: null };
  }
  const request = loaded.request;

  const offer = opts.answer === 'take'
    ? await resolveRequestOffer(partner.partnerId, request.offerId, request.title)
    : null;
  if (offer?.outcome === 'db_error') return { tell: { kind: 'retry' }, request };
  const span = offer?.outcome === 'ok' ? spanOrNull(request.dateFrom, request.dateTo) : null;
  const carTitle = offer?.outcome === 'ok' ? offer.title : request.title;
  const claimed = await claimPartnerAnswer({
    leadId: request.leadId,
    answer: opts.answer,
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

/** Исход, после которого сообщение заявки правится (ответ записан или уже был). */
const EDITS_REQUEST: ReadonlySet<AnswerTell['kind']> = new Set(['already', 'decline', 'take', 'take_no_car', 'take_bad_dates']);

export async function handleRentalRequestAnswer(opts: {
  lookup: AnswerLookup;
  payload: string;
  editMid: string | null;
  originalText: string | null;
  send: AnswerSend;
  notifyManager?: (text: string) => Promise<void>;
}): Promise<void> {
  const press = parseRequestAnswer(opts.payload);
  /** Заявка, когда она прочитана: из списка ответ без неё не называет, на что дан. */
  let listHead: string | null = null;
  const say = async (kind: Parameters<typeof partnerAnswerText>[0], edit: boolean) => {
    const line = partnerAnswerText(kind);
    if (press?.listNo !== undefined) {
      await opts.send(listHead ? `${listHead}\n${line}` : line, null);
      return;
    }
    const text = edit ? requestAnswerEditText(opts.originalText, line) : line;
    await opts.send(text, edit ? opts.editMid : null);
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
    notifyManager: opts.notifyManager,
  });
  if (press.listNo !== undefined && request) {
    listHead = requestAnswerListHead({
      listNo: press.listNo, title: request.title, from: request.dateFrom, to: request.dateTo,
    });
  }
  await say(tell, EDITS_REQUEST.has(tell.kind));
}
