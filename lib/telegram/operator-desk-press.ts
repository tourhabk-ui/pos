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
  ASK_CANCELLED, chatAnswerAsk, chatAnswerDateChangedText, chatAnswerLeadStatus, chatAnswerText, DECLINE_REASON_LABEL, declinePickText,
  declineReasonButtons, inboxOwns, parseChatAnswer, readLeadAnswerDate, recordChatAnswer,
} from '@/lib/requests/chat-answer';
import { createTicket } from '@/lib/support/ticket.service';
import {
  loadOperatorTours, operatorHelpText, operatorSeatsText, operatorToursReply, SUPPORT_BUTTON,
} from '@/lib/telegram/operator-desk';
import { WIZARD_TEXT } from '@/lib/operators/chat-dates/wizard';
import { answerDateCodable } from '@/lib/requests/answer-date';

const NOT_THIS = 'Эта кнопка — кабинет туроператора. В этом чате её не выполняю.';
const UNREAD = 'Не удалось проверить, чей это чат. Кнопку не выполнил.';
const DATE_UNREAD = 'Не удалось прочитать дату заявки. Ответ не записал — повторите через минуту.';
/** «Да» или причина отказа без даты заявки в кнопке — выпущены до 1422. */
const LEGACY_PRESS = 'Кнопка старая — сверьте дату заявки и подтвердите ответ ещё раз.';

/**
 * «Помощь» туроператора: справка и кнопка «Написать в поддержку» над строкой
 * меню. «Новые заявки» открывает кабинет в чате (lib/chat-cabinet): список с
 * карточками, где кнопки ответа на заявку и на бронь.
 */
export function operatorHelpPress(menu: MenuButton[]): { text: string; buttons: MenuButton[][] } {
  return { text: operatorHelpText(), buttons: appendMenu([[SUPPORT_BUTTON]], menu) };
}

export function isOperatorDeskPayload(payload: string): boolean {
  return payload === 'sup:new' || payload === 'opd:tours' || payload === 'opd:seats' || payload.startsWith('ia:') || payload.startsWith('sh:') || payload.startsWith('ss:');
}

export async function operatorDeskPress(opts: {
  channel: 'telegram' | 'max';
  chatId: number;
  payload: string;
  /** Личный диалог с ботом. В MAX даты кнопками — только в нём: в группе «Открыть» нажал бы любой участник. */
  dialog?: boolean;
  nowMs?: number;
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
  if (opts.payload === 'opd:seats') {
    // MAX, личный диалог — даты кнопками (31.10): тур, месяц, дни, места и то
    // же предложение с «Открыть», что у фразы. Telegram и группа — текстом.
    if (opts.channel === 'max' && opts.dialog === true) {
      const { datesWizardStart } = await import('@/lib/operators/chat-dates/wizard-flow');
      const step = await datesWizardStart(partner, opts.nowMs ?? Date.now());
      return withMenu(step.text, step.rows);
    }
    if (opts.channel === 'max') return withMenu(WIZARD_TEXT.groupChat);
    return withMenu(operatorSeatsText('operator'));
  }
  if (opts.payload === 'sup:new') return withMenu(await supportTicketText(partner, opts.channel));

  if (opts.payload.startsWith('sh:')) {
    const { holdPress } = await import('@/lib/operators/seat-holds');
    const r = await holdPress({
      partnerId: partner.partnerId, userId: partner.userId ?? null, payload: opts.payload,
      via: opts.channel, dialog: opts.dialog === true,
    });
    return r ? withMenu(r.text, r.rows) : withMenu('Кнопка не разобрана. Ничего не записал.');
  }
  if (opts.payload.startsWith('ss:')) {
    // Стоп-продажи (PR5) — только туроператор: категорию проверили выше.
    const { stopSalesPress } = await import('@/lib/operators/stop-sales');
    const r = await stopSalesPress({
      partnerId: partner.partnerId, userId: partner.userId ?? null, payload: opts.payload,
      via: opts.channel, dialog: opts.dialog === true, nowMs: opts.nowMs,
    });
    return r ? withMenu(r.text, r.rows) : withMenu('Кнопка не разобрана. Ничего не записал.');
  }
  if (opts.payload === 'ia:no') return withMenu(ASK_CANCELLED);
  const parsed = parseChatAnswer(opts.payload);
  if (!parsed) return withMenu('Кнопка ответа не разобрана. Ничего не записал.');
  const inbox = await loadInbox(partner.partnerId, 'operator', partner.userId, {});
  if (!inboxOwns(inbox.items, parsed.kind, parsed.subjectId)) {
    const missed = inbox.failed.length > 0
      ? 'Не удалось проверить, что заявка ваша. Ответ не записал.'
      : 'Этой заявки во входящих нет. Ответ не записал.';
    return withMenu(missed);
  }
  // Дата заявки (1422): оператор отвечает о той дате, которую видит в
  // вопросе, — она уходит в «Да» и в кнопки причин, и ответ запишется, только
  // если к нажатию дата заявки та же. Турист мог перенести её после «Нет мест».
  const leadDate = parsed.kind === 'lead' ? await readLeadAnswerDate(parsed.subjectId) : undefined;
  if (leadDate === 'failed') return withMenu(DATE_UNREAD);
  const reasons = (date: string | null | undefined) => declineReasonButtons(parsed.kind, parsed.subjectId, date);
  // «Отказать»: сначала причина кнопкой, запись — только нажатием причины.
  if (parsed.answer === 'decline_pick') return withMenu(declinePickText(leadDate), reasons(leadDate));
  // «Да» и причина без даты в кнопке у заявки — выпущены до 1422: дату,
  // которую оператор видел, не знаем, поэтому спрашиваем заново с датой.
  // Дата, которой нет в календаре (30.02), в кнопку не кладётся (answerDayCode):
  // такую кнопку старой не считаем, а пишем без сверки — иначе вопрос по кругу.
  const legacy = parsed.kind === 'lead' && (parsed.answer === 'decline' || parsed.confirmed) && parsed.date === undefined
    && answerDateCodable(leadDate ?? null);
  if (parsed.answer === 'decline' && legacy) return withMenu(`${LEGACY_PRESS}\n${declinePickText(leadDate)}`, reasons(leadDate));
  // Первое нажатие одной из пяти кнопок — только вопрос; пишет второе «Да».
  if (parsed.answer !== 'decline' && (!parsed.confirmed || legacy)) {
    const ask = chatAnswerAsk(parsed.answer, parsed.kind, parsed.subjectId, leadDate);
    let text = legacy ? `${LEGACY_PRESS}\n${ask.text}` : ask.text;
    if (parsed.answer === 'other_date' && parsed.kind === 'booking') {
      const { nextOpenDates, openDatesLine } = await import('@/lib/operators/live-seats');
      text = `${openDatesLine(await nextOpenDates(partner.partnerId, parsed.subjectId))}\n${text}`;
    }
    return withMenu(text, ask.rows);
  }
  const reason = parsed.answer === 'decline' ? parsed.reason : null;
  const saved = await recordChatAnswer({
    partnerId: partner.partnerId,
    kind: parsed.kind,
    subjectId: parsed.subjectId,
    answer: parsed.answer,
    reason,
    expectDate: parsed.kind === 'lead' ? parsed.date : undefined,
  });
  if (!saved.ok) return withMenu('Не удалось записать ответ. Бронь не менял.');
  if (saved.dateChanged) {
    const head = chatAnswerDateChangedText(saved.subjectDate);
    if (parsed.answer === 'decline') return withMenu(`${head}\n${declinePickText(saved.subjectDate)}`, reasons(saved.subjectDate));
    const ask = chatAnswerAsk(parsed.answer, parsed.kind, parsed.subjectId, saved.subjectDate);
    return withMenu(`${head}\n${ask.text}`, ask.rows);
  }
  const doneText = (already: boolean) => (reason && !already
    ? `${chatAnswerText('decline', false)} Причина: ${DECLINE_REASON_LABEL[reason].toLowerCase()}.`
    : chatAnswerText(parsed.answer as Exclude<typeof parsed.answer, 'decline_pick'>, already, saved.subjectDate));
  const leadStatus = chatAnswerLeadStatus(parsed.kind, parsed.answer);
  // Что ушло туристу (план «после отказа», 2б): строка исхода к ответу.
  const outcomeLine = async (): Promise<string | null> => {
    if (parsed.kind !== 'lead') return null;
    const notices = await import('@/lib/requests/answer-notice');
    const { operatorOutcomeLine } = await import('@/lib/requests/answer-notice-text');
    if (saved.already) {
      const was = await notices.readNoticeOutcomeFor(parsed.subjectId, partner.partnerId, saved.subjectDate);
      return was ? operatorOutcomeLine(was) : null;
    }
    const n = saved.notice;
    if (!n) return null;
    if (n.state === 'skipped') {
      const reason = n.skipped === 'lead_closed' || n.skipped === 'not_addressee' || n.skipped === 'self' ? n.skipped : 'outgrown';
      return operatorOutcomeLine({ state: 'skipped', reason });
    }
    return operatorOutcomeLine(await notices.deliverAnswerNotice(n.id));
  };
  const withOutcome = async (text: string) => {
    const line = await outcomeLine();
    return withMenu(line ? `${text}\n${line}` : text);
  };
  if (saved.already || !leadStatus) return withOutcome(doneText(saved.already));
  // Статус заявки — только своей: скоуп карточки без захвата ничейных,
  // поверх проверки входящих выше. Ошибка не прячется — оператор её видит.
  // Сообщение туристу — после статуса: вид заявки, из которого строится
  // сообщение, читает статус («Отказать» — `lost`).
  let statusNote: string | null = null;
  try {
    const { changeLeadStatus } = await import('@/lib/leads/owner-lead-status');
    const res = await changeLeadStatus({
      leadId: parsed.subjectId,
      status: leadStatus,
      actor: { kind: 'partner_user', userId: partner.userId ?? null },
      scope: { kind: 'owner', partnerId: partner.partnerId, claimUnowned: false },
      via: opts.channel,
    });
    if (res.kind === 'not_found') statusNote = 'Ответ записан, но заявка не ваша по карточке — статус не менял.';
  } catch (err) {
    console.error('[operator-desk] статус заявки не сменён, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    statusNote = 'Ответ записан, статус заявки сменить не удалось. Отметьте её в кабинете.';
  }
  return withOutcome(statusNote ?? doneText(false));
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
