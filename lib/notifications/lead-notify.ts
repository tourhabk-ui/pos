/**
 * Уведомления оператора о новых лидах и предложениях.
 *
 * notifyOperatorProposal — после AI-обработки. Тоже содержит ПД, хотя по виду
 *   полей их там нет: proposal.headline и summary строятся моделью с
 *   плейсхолдером {name}, а имя подставляется ЛОКАЛЬНО перед возвратом
 *   (lead-processor.service, withName). То есть заголовок несёт имя туриста.
 * notifyOperatorNewLead  — при входящем лиде (вызывается из POST /api/leads).
 *   Содержит имя, телефон и комментарий туриста — значит идёт в MAX через
 *   sendPdAlert, а не в Telegram (решение владельца 23.08, юрисдикция).
 *   Адресат — рабочий чат платформы, несмотря на имя функции.
 * notifyPartnerNewLeadPersonally — та же заявка ЛИЧНО оператору, которому она
 *   адресована (lead.operator_id: форма на его странице vedarai.ru/<slug>,
 *   виджет на его сайте). До 13.10 такой лид ложился в его кабинет, а
 *   уведомление уходило только в рабочий чат платформы — оператор узнавал о
 *   заявке, когда заходил в кабинет сам. Гиду со своими турами (29.10) — ещё
 *   кнопки ответа «Связался», «Договорились», «Отказ» (только MAX).
 */

import type { LeadProposalData } from '@/lib/services/operators/lead-processor.service';
import { getPublicBaseUrl } from '@/lib/config';
import { sendPdAlert, type PdAlertChannel, type PdAlertResult } from '@/lib/notifications/pd-alert';
import { reachForPartner } from '@/lib/partners/reach';
import { ownerLeadUrl } from '@/lib/partners/cabinet-links';
import { notifyTeam } from '@/lib/operators/team-notify';
import { chatActionsEnabledFor, leadAnswerButtons } from '@/lib/bookings/chat-owner-press';
import { isChatTargetId, ownerReplyButton } from '@/lib/requests/request-chat';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Уведомление оператора после того как AI сформировал предложение.
 * Идёт в MAX: заголовок содержит имя туриста.
 */
export async function notifyOperatorProposal(
  proposal: LeadProposalData,
): Promise<import('@/lib/notifications/pd-alert').PdAlertResult> {
  const baseUrl = getPublicBaseUrl();

  // NULL — «не оценено» (ИИ не дал оценку), а не ноль и не выдуманное число.
  const score = proposal.ai_score;
  const scoreTag = score === null ? '' : score >= 80 ? ' [HOT]' : score >= 50 ? ' [OK]' : '';
  const scoreText = score === null ? 'не оценено' : `${score} / 100`;
  const toursText = proposal.primary_tour
    ? `<b>${esc(proposal.primary_tour.title)}</b> — ${proposal.primary_tour.price.toLocaleString('ru-RU')} руб/чел`
    : 'Туры подобраны вручную';

  const text = [
    `<b>AI обработал лид${scoreTag}</b>`,
    '',
    `<b>Заголовок:</b> ${esc(proposal.headline)}`,
    `<b>AI-оценка:</b> ${scoreText}`,
    `<b>Тур:</b> ${toursText}`,
    proposal.price_from
      ? `<b>Бюджет:</b> от ${proposal.price_from.toLocaleString('ru-RU')} ₽`
      : '',
    `<b>Генерация:</b> ${(proposal.generation_ms / 1000).toFixed(1)} сек`,
  ].filter(Boolean).join('\n');

  // Заглушка без ПД: заголовка здесь нет именно потому, что в нём имя.
  const stub = [
    `<b>AI обработал заявку${scoreTag}</b>`,
    '',
    `Заявка <code>${esc(proposal.lead_id)}</code>.`,
    `AI-оценка: ${scoreText}`,
    `Тур: ${toursText}`,
    'Заголовок предложения — в MAX и в кабинете: он содержит имя туриста.',
  ].filter(Boolean).join('\n');

  // Предложение готово — решение владельца одно: отправлять или нет. Кнопка
  // держит это решение в мессенджере: раньше на самом горячем шаге воронки
  // приходилось открывать хаб на телефоне, искать лид и жать «отправить» (#65).
  return sendPdAlert({
    text,
    stub,
    buttons: [
      { text: 'Отправить клиенту', payload: `lead_send:${proposal.lead_id}` },
      { text: 'Открыть и поправить', url: `${baseUrl}/hub/operator/leads/${proposal.lead_id}` },
      { text: 'PDF', url: `${baseUrl}/api/leads/${proposal.lead_id}/proposal/pdf` },
    ],
  });
}

/**
 * Уведомление о новом входящем лиде (до AI-обработки).
 *
 * Содержит ПД туриста → уходит в MAX.
 *
 * Возвращает исход доставки — вызывающий волен его залогировать; «не смог»
 * молча успехом не становится.
 */
export async function notifyOperatorNewLead(params: {
  leadId: string;
  name: string;
  phone: string;
  comment?: string;
  routeTitle?: string;
  /**
   * Заявка адресована оператору: имя партнёра и исход личной доставки ему —
   * рабочий чат видит, дошло ли до него, и кого привязывать, если нет.
   */
  forPartner?: { name: string; outcome: PersonalLeadOutcome | null };
}): Promise<PdAlertResult> {
  const baseUrl = getPublicBaseUrl();
  const partnerLine = personalDeliveryLine(params.forPartner);

  const text = [
    '<b>Новая заявка</b>',
    partnerLine,
    '',
    `<b>Имя:</b> ${esc(params.name)}`,
    `<b>Телефон:</b> ${esc(params.phone)}`,
    params.routeTitle ? `<b>Интерес:</b> ${esc(params.routeTitle)}` : '',
    params.comment ? `<b>Комментарий:</b> ${esc(params.comment.slice(0, 200))}` : '',
  ].filter(Boolean).join('\n');

  // Заглушка без ПД: если MAX недоступен, оператор всё равно узнаёт о заявке,
  // но имя и телефон остаются за логином.
  const stub = [
    '<b>Новая заявка</b>',
    partnerLine,
    '',
    `Заявка <code>${esc(params.leadId)}</code> принята.`,
    params.routeTitle ? `Интерес: ${esc(params.routeTitle)}` : '',
    'Имя и телефон — в кабинете: MAX недоступен, в Telegram они не передаются.',
  ].filter(Boolean).join('\n');

  return sendPdAlert({
    text,
    stub,
    buttons: [
      { text: 'Обработать AI', payload: `lead_ai:${params.leadId}` },
      { text: 'Открыть в кабинете', url: `${baseUrl}/hub/operator/leads/${params.leadId}` },
    ],
  });
}

/** Исход личной доставки оператору — четыре состояния, не два (§4.0). */
export type PersonalLeadOutcome =
  | { state: 'delivered'; channel: 'max' }
  /** ПД остались в кабинете: в его Telegram ушла заглушка. */
  | { state: 'stub'; channel: 'telegram-stub' }
  | { state: 'failed'; channel: PdAlertChannel; reason: string }
  /** Оператор не привязан ни к MAX, ни к Telegram. */
  | { state: 'no_channel' }
  /** Адрес не прочитался — «не знаю», а не «адреса нет». */
  | { state: 'unknown' };

/** Строка для рабочего чата платформы: кому заявка и дошла ли до него лично. */
function personalDeliveryLine(fp: { name: string; outcome: PersonalLeadOutcome | null } | undefined): string {
  if (!fp) return '';
  const who = `Оператор «${esc(fp.name)}»`;
  const o = fp.outcome;
  if (!o) return `${who}: лично не уведомлялся`;
  switch (o.state) {
    case 'delivered': return `${who}: доставлено лично в MAX`;
    case 'stub': return `${who}: в его Telegram ушла заглушка, контакты — в кабинете`;
    case 'no_channel': return `${who} не привязан ни к MAX, ни к Telegram — узнает из кабинета. Привязка: «Привязать мессенджер» в его кабинете или ссылка от админа`;
    case 'unknown': return `${who}: адрес не прочитался — лично не доставлено`;
    case 'failed': return `${who}: лично не доставлено (${esc(o.reason)})`;
  }
}

/**
 * Новая заявка — ЛИЧНО оператору, которому она адресована.
 *
 * Адрес — только его: `reachForPartner` → `sendPdAlert({ to })`, строго, без
 * отката на рабочий чат платформы (прецедент notifyNewBooking: ПД туриста в
 * чужой чат — не доставка). Туроператору кнопка одна, и это ссылка: кнопки
 * лида рабочего чата (`lead_*`) бот принимает только оттуда. Гиду со своими
 * турами над ссылкой — «Связался», «Договорились», «Отказ» (`ld:`): их бот
 * принимает в его личном чате кабинета, вопросом и «Да»
 * (lib/bookings/chat-owner-action). Только в MAX — из заглушки Telegram
 * действия убирает sendPdAlert. Копия команде — со ссылкой: кнопки нажимает
 * человек, подключивший чат кабинета, а не менеджер.
 *
 * Отказ не глушится: каждый исход, кроме доставки, назван в логе и
 * возвращается вызывающему — тот показывает его рабочему чату.
 */
export async function notifyPartnerNewLeadPersonally(params: {
  operatorId: string;
  leadId: string;
  name: string;
  phone: string;
  comment?: string;
  routeTitle?: string;
  /** Откуда заявка — словами для оператора («форма на вашей странице на Ведаре»). */
  origin?: string;
  sourceUrl?: string;
  /**
   * Кнопка «Ответить клиенту» — переписка по заявке (1350). false — у заявки
   * переписки нет: своя проба (is_self, 1145) — партнёру некому отвечать.
   */
  chat?: boolean;
}): Promise<PersonalLeadOutcome> {
  // Общая часть — без ПД: её видно в обоих каналах.
  const common = [
    '<b>Новая заявка вам</b>',
    params.origin ? `Откуда: ${esc(params.origin)}` : '',
    params.sourceUrl ? `Страница: ${esc(params.sourceUrl)}` : '',
    params.routeTitle ? `<b>Интерес:</b> ${esc(params.routeTitle)}` : '',
  ].filter(Boolean);
  const text = [
    ...common,
    '',
    `<b>Имя:</b> ${esc(params.name)}`,
    `<b>Телефон:</b> ${esc(params.phone)}`,
    params.comment ? `<b>Комментарий:</b> ${esc(params.comment.slice(0, 200))}` : '',
  ].filter(Boolean).join('\n');
  const stub = [
    ...common,
    '',
    `Заявка <code>${esc(params.leadId)}</code> принята.`,
    'Имя и телефон — в кабинете: в Telegram они не передаются.',
  ].filter(Boolean).join('\n');

  // Адрес и категория — одним запросом. Гид со своими турами работает в
  // кабинете гида: кабинет оператора его не пустит (lib/partners/cabinet-links).
  const reach = await reachForPartner(params.operatorId);
  const buttons = [{ text: 'Открыть заявку', url: ownerLeadUrl(reach?.category, params.leadId) }];
  const answer = reach && chatActionsEnabledFor({ category: reach.category, sellsTours: reach.sellsTours })
    ? leadAnswerButtons(params.leadId)
    : [];

  // Менеджеры команды кабинета (CRM 2г-4) — до проверки адреса кабинета: у
  // команды свои адреса, и заявка доходит до неё, даже если у кабинета канала нет.
  await notifyTeam(params.operatorId, { text, stub, buttons }, `заявка ${params.leadId}`);

  if (reach === null) {
    console.error(`[lead-notify] адрес оператора ${params.operatorId} не прочитался — о заявке ${params.leadId} лично не сообщено`);
    return { state: 'unknown' };
  }
  if (!reach.reachable) {
    console.error(`[lead-notify] у оператора ${params.operatorId} нет ни MAX, ни Telegram — о заявке ${params.leadId} он узнает из кабинета`);
    return { state: 'no_channel' };
  }

  // «Ответить клиенту» — переписка с клиентом в этом же чате (1350). Ответ
  // уходит клиенту в MAX и на страницу заявки; кнопка-действие — только в MAX.
  const reply = params.chat !== false && isChatTargetId(params.leadId) ? [ownerReplyButton({ kind: 'lead', id: params.leadId })] : [];
  const res = await sendPdAlert({
    // Подсказка про кнопку — только в личное сообщение: у копии команде кнопки нет.
    text: reply.length > 0 ? `${text}\n\nНаписать клиенту в этом чате — кнопка «Ответить клиенту».` : text,
    stub,
    buttons: [...reply, ...answer, ...buttons],
    to: { maxChatId: reach.maxChatId, telegramChatId: reach.telegramChatId },
  });
  if (res.channel === 'max' && res.delivered) return { state: 'delivered', channel: 'max' };
  if (res.channel === 'telegram-stub') return { state: 'stub', channel: 'telegram-stub' };
  console.error(`[lead-notify] оператору ${params.operatorId} о заявке ${params.leadId} лично не доставлено (${res.channel}) — ${res.reason}`);
  return { state: 'failed', channel: res.channel, reason: res.reason };
}
