/**
 * Нажатие «Принять / Нет мест / Уточнить / Свяжусь сам» в личном чате
 * партнёра. Пишет ответ и сообщает менеджеру факт без персональных данных
 * заказчика. Бронь и оплату не трогает.
 */

import { tgSend } from '@/lib/notifications/tg-send';
import type { PartnerChatLookup } from '@/lib/kuzmich/operator-chat';
import {
  incomingAnswerText, incomingEditText, incomingManagerText, parseIncomingAnswer,
  type IncomingAnswer,
} from '@/lib/requests/incoming-card';
import { claimIncomingAnswer } from '@/lib/requests/incoming-answer-store';

export type IncomingSend = (text: string, editMid: string | null) => Promise<void>;

async function tellManager(text: string): Promise<void> {
  const sent = await tgSend('incoming-answer', text);
  if (!sent.ok) console.error(`[incoming-answer] менеджеру не доставлено: ${sent.reason}`);
}

export async function handleIncomingAnswer(opts: {
  lookup: PartnerChatLookup;
  payload: string;
  editMid: string | null;
  originalText: string | null;
  send: IncomingSend;
  notifyManager?: (text: string) => Promise<void>;
}): Promise<void> {
  const notify = opts.notifyManager ?? tellManager;
  const say = async (html: string, edit: boolean) => {
    const text = edit ? incomingEditText(opts.originalText, html) : html;
    await opts.send(text, edit ? opts.editMid : null);
  };

  const press = parseIncomingAnswer(opts.payload);
  if (!press) {
    await say('Кнопка заявки не распознана. Ответ не записан.', false);
    return;
  }
  if (opts.lookup.outcome === 'unavailable') {
    await say('Не удалось проверить, чей это чат. Ответ не записан.', false);
    return;
  }
  if (opts.lookup.outcome !== 'found') {
    await say('Этот чат не привязан к партнёру. Ответ не записан.', false);
    return;
  }

  const claimed = await claimIncomingAnswer({
    partnerId: opts.lookup.partner.partnerId,
    kind: press.kind,
    subjectId: press.subjectId,
    answer: press.answer,
  });
  if (claimed.outcome === 'unread') {
    await say('Ответ не записал: база не ответила. Нажмите кнопку ещё раз.', false);
    return;
  }
  if (claimed.outcome === 'missing') {
    await say('Заявку не нашёл. Ответ не записан.', false);
    return;
  }
  if (claimed.outcome === 'not_yours') {
    await say('Эта заявка не ваша. Ответ не записан.', false);
    return;
  }

  const answer: IncomingAnswer = claimed.outcome === 'already' ? claimed.answer : press.answer;
  if (claimed.outcome === 'saved') {
    try {
      await notify(incomingManagerText({
        partnerName: opts.lookup.partner.partnerName,
        kind: press.kind,
        subjectId: press.subjectId,
        answer,
      }));
    } catch (err) {
      console.error('[incoming-answer] менеджеру не доставлено:', err instanceof Error ? err.message : err);
    }
  }
  await say(incomingAnswerText(answer, claimed.outcome === 'already'), true);
}
