/**
 * Нажатие «Беру» / «Не могу» в личном чате прокатчика пилота.
 * Пишет журнал, «Беру» отмечает дни заявки занятыми, менеджеру шлёт факт
 * без персональных данных заказчика и просит править то же сообщение.
 */

import { tgSend } from '@/lib/notifications/tg-send';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import {
  managerAnswerText, parseRequestAnswer, partnerAnswerText, requestAnswerEditText, type RequestAnswer,
} from '@/lib/rental/request-answer';
import {
  loadOwnedRentalRequest, markRequestBusy, readPartnerAnswer, resolveRequestOffer, writePartnerAnswer,
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

  const prior = await readPartnerAnswer(request.leadId);
  if (prior === 'db_error') {
    await say({ kind: 'unread' }, false);
    return;
  }
  if (prior === 'take' || prior === 'decline') {
    await say({ kind: 'already', answer: prior }, true);
    return;
  }

  const finish = async (
    answer: RequestAnswer,
    tell: Parameters<typeof partnerAnswerText>[0],
    extra: { carTitle: string | null; from: string | null; to: string | null; marked: number | null },
  ) => {
    const written = await writePartnerAnswer(request.leadId, answer, {
      offer_id: request.offerId,
      car_title: extra.carTitle,
      date_from: extra.from,
      date_to: extra.to,
      days_marked: extra.marked,
    });
    if (written === 'db_error') {
      await say({ kind: 'retry' }, false);
      return;
    }
    try {
      await notify(managerAnswerText({
        partnerName: partner.partnerName,
        leadId: request.leadId,
        answer,
        carTitle: extra.carTitle,
        from: extra.from,
        to: extra.to,
        marked: extra.marked,
      }));
    } catch (err) {
      console.error('[rental-request-answer] менеджеру не доставлено:', err instanceof Error ? err.message : err);
    }
    await say(tell, true);
  };

  if (press.answer === 'decline') {
    await finish('decline', { kind: 'decline' }, {
      carTitle: request.title, from: request.dateFrom, to: request.dateTo, marked: null,
    });
    return;
  }

  const offer = await resolveRequestOffer(partner.partnerId, request.offerId, request.title);
  if (offer.outcome === 'db_error') {
    await say({ kind: 'retry' }, false);
    return;
  }
  if (offer.outcome !== 'ok') {
    await finish('take', { kind: 'take_no_car' }, {
      carTitle: request.title, from: request.dateFrom, to: request.dateTo, marked: null,
    });
    return;
  }
  const span = spanOrNull(request.dateFrom, request.dateTo);
  if (!span) {
    await finish('take', { kind: 'take_bad_dates' }, {
      carTitle: offer.title, from: request.dateFrom, to: request.dateTo, marked: null,
    });
    return;
  }

  const marked = await markRequestBusy(
    partner.partnerId, offer.offerId, span.from, span.to, request.leadId,
  );
  if (marked.outcome !== 'saved') {
    if (marked.outcome === 'db_error') {
      await say({ kind: 'retry' }, false);
      return;
    }
    await finish('take', marked.outcome === 'bad_dates' ? { kind: 'take_bad_dates' } : { kind: 'take_no_car' }, {
      carTitle: offer.title, from: span.from, to: span.to, marked: null,
    });
    return;
  }
  const daysMarked = marked.marked;
  await finish('take', { kind: 'take', from: span.from, to: span.to, marked: daysMarked }, {
    carTitle: offer.title, from: span.from, to: span.to, marked: daysMarked,
  });
}
