/**
 * Уведомления оператора о новых лидах и предложениях.
 *
 * notifyOperatorProposal — после AI-обработки: уведомление в TELEGRAM_CHAT_ID
 * notifyOperatorNewLead  — при входящем лиде (вызывается из POST /api/leads)
 */

import type { LeadProposalData } from '@/lib/services/operators/lead-processor.service';
import { getPublicBaseUrl } from '@/lib/config';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Кнопка под уведомлением: действие (callback) или ссылка (url). */
type TgButton = { text: string; callback_data: string } | { text: string; url: string };

async function tgSend(chatId: string, text: string, buttons?: TgButton[][]): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
      }),
    });
  } catch {
    // Silent fail — уведомление не критично
  }
}

/**
 * Уведомление оператора после того как AI сформировал предложение.
 * Отправляет в TELEGRAM_CHAT_ID (admin/operator group).
 */
export async function notifyOperatorProposal(proposal: LeadProposalData): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
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

  // Предложение готово — решение владельца одно: отправлять или нет. Кнопка
  // держит это решение в мессенджере: раньше на самом горячем шаге воронки
  // приходилось открывать хаб на телефоне, искать лид и жать «отправить» (#65).
  await tgSend(chatId, text, [
    [{ text: 'Отправить клиенту', callback_data: `lead_send:${proposal.lead_id}` }],
    [
      { text: 'Открыть и поправить', url: `${baseUrl}/hub/operator/leads/${proposal.lead_id}` },
      { text: 'PDF', url: `${baseUrl}/api/leads/${proposal.lead_id}/proposal/pdf` },
    ],
  ]);
}

/**
 * Уведомление о новом входящем лиде (до AI-обработки).
 */
export async function notifyOperatorNewLead(params: {
  leadId: string;
  name: string;
  phone: string;
  comment?: string;
  routeTitle?: string;
}): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  const baseUrl = getPublicBaseUrl();

  const text = [
    '<b>Новая заявка</b>',
    '',
    `<b>Имя:</b> ${esc(params.name)}`,
    `<b>Телефон:</b> ${esc(params.phone)}`,
    params.routeTitle ? `<b>Интерес:</b> ${esc(params.routeTitle)}` : '',
    params.comment ? `<b>Комментарий:</b> ${esc(params.comment.slice(0, 200))}` : '',
  ].filter(Boolean).join('\n');

  await tgSend(chatId, text, [
    [{ text: 'Обработать AI', callback_data: `lead_ai:${params.leadId}` }],
    [{ text: 'Открыть в кабинете', url: `${baseUrl}/hub/operator/leads/${params.leadId}` }],
  ]);
}
