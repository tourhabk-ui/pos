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
 */

import type { LeadProposalData } from '@/lib/services/operators/lead-processor.service';
import { getPublicBaseUrl } from '@/lib/config';
import { sendPdAlert } from '@/lib/notifications/pd-alert';

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

  const scoreTag = proposal.ai_score >= 80 ? ' [HOT]' : proposal.ai_score >= 50 ? ' [OK]' : '';
  const toursText = proposal.primary_tour
    ? `<b>${esc(proposal.primary_tour.title)}</b> — ${proposal.primary_tour.price.toLocaleString('ru-RU')} руб/чел`
    : 'Туры подобраны вручную';

  const text = [
    `<b>AI обработал лид${scoreTag}</b>`,
    '',
    `<b>Заголовок:</b> ${esc(proposal.headline)}`,
    `<b>AI-оценка:</b> ${proposal.ai_score} / 100`,
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
    `AI-оценка: ${proposal.ai_score} / 100`,
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
}): Promise<import('@/lib/notifications/pd-alert').PdAlertResult> {
  const baseUrl = getPublicBaseUrl();

  const text = [
    '<b>Новая заявка</b>',
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
