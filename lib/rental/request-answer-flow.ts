/**
 * Нажатие «Беру» / «Не могу» в личном чате прокатчика пилота.
 * Ответ и отметка дней — одна транзакция: второе нажатие дни не меняет.
 * Менеджеру уходит один факт без персональных данных заказчика.
 */

import { tgSend } from '@/lib/notifications/tg-send';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import {
  managerAnswerText, parseRequestAnswer, partnerAnswerText, requestAnswerEditText,
} from '@/lib/rental/request-answer';
import {
  claimPartnerAnswer, loadOwnedRentalRequest, resolveRequestOffer,
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

export async function handleRentalRequestAnswer(opts: {
  lookup: AnswerLookup;
  payload: string;
  editMid: string | null;
  originalText: string | null;
  send: AnswerSend;
  notifyManager?: (text: string) => Promise<void>;
}): Promise<void> {
  const notify = opts.notifyManager ?? tellManager;
  const say = async (kind: Parameters<typeof partnerAnswerText>[0], edit: boolean) => {
    const line = partnerAnswerText(kind);
    const text = edit ? requestAnswerEditText(opts.originalText, line) : line;
    await opts.send(text, edit ? opts.editMid : null);
  };

  const press = parseRequestAnswer(opts.payload);
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
  const partner = opts.lookup.partner;
  if (!isRentalPilotSlug(partner.slug)) {
    await say({ kind: 'not_pilot' }, false);
    return;
  }

  const loaded = await loadOwnedRentalRequest(partner.partnerId, press.leadId);
  if (loaded.outcome !== 'ok') {
    const kind = loaded.outcome === 'missing' ? 'missing' as const
      : loaded.outcome === 'db_error' ? 'unread' as const
      : 'not_yours' as const;
    await say({ kind }, false);
    return;
  }
  const request = loaded.request;

  const offer = press.answer === 'take'
    ? await resolveRequestOffer(partner.partnerId, request.offerId, request.title)
    : null;
  if (offer?.outcome === 'db_error') {
    await say({ kind: 'retry' }, false);
    return;
  }
  const span = offer?.outcome === 'ok' ? spanOrNull(request.dateFrom, request.dateTo) : null;
  const carTitle = offer?.outcome === 'ok' ? offer.title : request.title;
  const claimed = await claimPartnerAnswer({
    leadId: request.leadId,
    answer: press.answer,
    partnerId: partner.partnerId,
    offerId: offer?.outcome === 'ok' ? offer.offerId : request.offerId,
    carTitle,
    dateFrom: span?.from ?? request.dateFrom,
    dateTo: span?.to ?? request.dateTo,
    mark: offer?.outcome === 'ok' && span
      ? { offerId: offer.offerId, dateFrom: span.from, dateTo: span.to }
      : null,
  });
  if (claimed.outcome === 'db_error') {
    await say({ kind: 'retry' }, false);
    return;
  }
  if (claimed.outcome === 'already') {
    await say({ kind: 'already', answer: claimed.answer }, true);
    return;
  }

  const tell = press.answer === 'decline'
    ? { kind: 'decline' as const }
    : claimed.marked !== null && span
      ? { kind: 'take' as const, from: span.from, to: span.to, marked: claimed.marked }
      : offer?.outcome === 'ok' && !span
        ? { kind: 'take_bad_dates' as const }
        : { kind: 'take_no_car' as const };
  try {
    await notify(managerAnswerText({
      partnerName: partner.partnerName,
      leadId: request.leadId,
      answer: press.answer,
      carTitle,
      from: request.dateFrom,
      to: request.dateTo,
      marked: press.answer === 'take' ? claimed.marked : null,
    }));
  } catch (err) {
    console.error('[rental-request-answer] менеджеру не доставлено:', err instanceof Error ? err.message : err);
  }
  await say(tell, true);
}
