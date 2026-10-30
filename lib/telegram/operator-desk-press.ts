/**
 * Нажатие в кабинете туроператора: ответ на заявку, туры, места, поддержка.
 * Кнопка ответа не подтверждает бронь и не открывает оплату.
 * Слово «Помощь» сюда не входит — тикет создаёт только «Написать в поддержку».
 */

import { loadInbox } from '@/lib/crm/inbox';
import { findPartnerByChat, type PartnerChatContext } from '@/lib/kuzmich/operator-chat';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { appendMenu, type MenuButton } from '@/lib/roles/chat-menu';
import { partnerMenu } from '@/lib/roles/role-menu';
import {
  chatAnswerText, inboxOwns, parseChatAnswer, recordChatAnswer,
} from '@/lib/requests/chat-answer';
import { createTicket } from '@/lib/support/ticket.service';
import {
  loadOperatorTours, operatorHelpText, operatorSeatsText, operatorToursReply, SUPPORT_BUTTON,
} from '@/lib/telegram/operator-desk';

const NOT_THIS = 'Эта кнопка — кабинет туроператора. В этом чате её не выполняю.';
const UNREAD = 'Не удалось проверить, чей это чат. Кнопку не выполнил.';

/**
 * «Помощь» туроператора: справка и кнопка «Написать в поддержку» над строкой
 * меню. «Новые заявки» открывает кабинет в чате (lib/chat-cabinet): список с
 * карточками, где кнопки ответа на заявку и на бронь.
 */
export function operatorHelpPress(menu: MenuButton[]): { text: string; buttons: MenuButton[][] } {
  return { text: operatorHelpText(), buttons: appendMenu([[SUPPORT_BUTTON]], menu) };
}

export function isOperatorDeskPayload(payload: string): boolean {
  return payload === 'sup:new' || payload === 'opd:tours' || payload === 'opd:seats' || payload.startsWith('ia:');
}

export async function operatorDeskPress(opts: {
  channel: 'telegram' | 'max';
  chatId: number;
  payload: string;
}): Promise<{ text: string; buttons: MenuButton[][] } | null> {
  if (!isOperatorDeskPayload(opts.payload)) return null;
  const lookup = await findPartnerByChat(opts.channel, opts.chatId);
  if (lookup.outcome === 'unavailable') return { text: UNREAD, buttons: [] };
  if (lookup.outcome !== 'found' || lookup.partner.category !== 'operator' || isRentalPilotSlug(lookup.partner.slug)) {
    return { text: NOT_THIS, buttons: [] };
  }
  const partner = lookup.partner;
  const menu = partnerMenu({
    partnerId: partner.partnerId,
    category: partner.category,
    slug: partner.slug,
    userId: partner.userId,
  }) ?? [];
  const withMenu = (text: string, rows: MenuButton[][] = []) => ({
    text,
    buttons: appendMenu(rows, menu),
  });

  if (opts.payload === 'opd:tours') {
    return withMenu(operatorToursReply(await loadOperatorTours(partner.partnerId)));
  }
  if (opts.payload === 'opd:seats') return withMenu(operatorSeatsText());
  if (opts.payload === 'sup:new') return withMenu(await supportTicketText(partner, opts.channel));

  const parsed = parseChatAnswer(opts.payload);
  if (!parsed) return withMenu('Кнопка ответа не разобрана. Ничего не записал.');
  const inbox = await loadInbox(partner.partnerId, 'operator', partner.userId, {});
  if (!inboxOwns(inbox.items, parsed.kind, parsed.subjectId)) {
    const missed = inbox.failed.length > 0
      ? 'Не удалось проверить, что заявка ваша. Ответ не записал.'
      : 'Этой заявки во входящих нет. Ответ не записал.';
    return withMenu(missed);
  }
  const saved = await recordChatAnswer({
    partnerId: partner.partnerId,
    kind: parsed.kind,
    subjectId: parsed.subjectId,
    answer: parsed.answer,
  });
  if (!saved.ok) return withMenu('Не удалось записать ответ. Бронь не менял.');
  return withMenu(chatAnswerText(parsed.answer, saved.already));
}

async function supportTicketText(partner: PartnerChatContext, channel: 'telegram' | 'max'): Promise<string> {
  if (!partner.userId) {
    return 'У этой карточки нет аккаунта на Ведаре. Напишите через форму на сайте — из чата обращение не создать.';
  }
  try {
    const ticket = await createTicket({
      userId: partner.userId,
      channel: channel === 'telegram' ? 'telegram' : 'max',
      category: 'operator',
      subject: 'Обращение туроператора из мессенджера',
      firstMessage: channel === 'telegram'
        ? 'Оператор нажал «Написать в поддержку» в Telegram.'
        : 'Оператор нажал «Написать в поддержку» в MAX.',
    });
    return `Обращение принято. Номер #${ticket.id.slice(0, 8)}.`;
  } catch (err) {
    console.error('[operator-desk] тикет не создан, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return 'Не удалось создать обращение. Попробуйте ещё раз или напишите на сайте.';
  }
}
