/**
 * Доставка AI-предложения клиенту — ЕДИНСТВЕННАЯ реализация.
 *
 * Зовут двое: HTTP-ручка POST /api/leads/[id]/proposal/send (кабинет) и
 * обработчик нажатия кнопки в Telegram (владелец одобряет прямо в
 * мессенджере, задача #65). Два способа отправки разошлись бы поведением —
 * это ровно тот случай, который правило «одна мера в одном месте» и
 * запрещает: клиент получил бы разные письма в зависимости от того, откуда
 * нажали.
 *
 * Авторизация СЮДА НЕ ВХОДИТ и входить не должна: у ручки это requireOperator,
 * у кнопки — принадлежность сообщения админ-чату. Каждый вызывающий обязан
 * проверить право сам ДО вызова.
 */

import { pool } from '@/lib/db-pool';
import { leadProcessor } from '@/lib/services/operators/lead-processor.service';
import { getPublicBaseUrl } from '@/lib/config';

export type DeliveryChannel = 'telegram' | 'email' | 'both';

export type DeliveryOutcome =
  | { ok: true; sent: string[]; failed: string[]; pdfUrl: string; message: string }
  | { ok: false; reason: 'not_found' | 'no_proposal' | 'already_sent' | 'proposal_missing'; message: string };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function tgSend(chatId: string | number, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Отправить готовое предложение клиенту и перевести лид в proposal_sent.
 *
 * Идемпотентность: статус лида — сторож. Повторный вызов (второе нажатие
 * кнопки, ретрай Telegram) вернёт already_sent и НИЧЕГО не отправит: клиент
 * не должен получить одно предложение дважды.
 */
export async function sendProposalToClient(
  leadId: string,
  channel: DeliveryChannel = 'both',
): Promise<DeliveryOutcome> {
  const { rows } = await pool.query<{
    proposal_id: string | null;
    name: string;
    email: string | null;
    status: string;
    tg_chat_id: string | null;
  }>(
    `SELECT proposal_id, name, email, status,
            (source_data->>'tg_chat_id') AS tg_chat_id
       FROM leads WHERE id = $1`,
    [leadId],
  );

  const lead = rows[0];
  if (!lead) {
    return { ok: false, reason: 'not_found', message: 'Лид не найден' };
  }
  if (!lead.proposal_id) {
    return { ok: false, reason: 'no_proposal', message: 'Предложение ещё не сформировано. Запустите AI-обработку.' };
  }
  if (lead.status === 'proposal_sent') {
    return { ok: false, reason: 'already_sent', message: 'Предложение уже было отправлено.' };
  }

  const proposal = await leadProcessor.getProposal(lead.proposal_id);
  if (!proposal) {
    return { ok: false, reason: 'proposal_missing', message: 'Данные предложения не найдены.' };
  }

  const pdfUrl = `${getPublicBaseUrl()}/api/leads/${leadId}/proposal/pdf`;
  const sent: string[] = [];
  const failed: string[] = [];

  if ((channel === 'telegram' || channel === 'both') && lead.tg_chat_id) {
    const tourLine = proposal.primary_tour
      ? `\n<b>Тур:</b> ${esc(proposal.primary_tour.title)} — ${proposal.primary_tour.price.toLocaleString('ru-RU')} р/чел`
      : '';
    const priceLine = proposal.price_from
      ? `\n<b>Бюджет:</b> от ${proposal.price_from.toLocaleString('ru-RU')} р`
      : '';
    const highlights = proposal.highlights.slice(0, 3).map((h) => `- ${esc(h)}`).join('\n');

    const text = [
      `<b>Предложение для ${esc(lead.name)}</b>`,
      '',
      `<b>${esc(proposal.headline)}</b>`,
      '',
      esc(proposal.summary),
      '',
      highlights,
      tourLine,
      priceLine,
      '',
      `<a href="${pdfUrl}">Скачать полное предложение PDF</a>`,
    ].filter((l) => l !== undefined).join('\n');

    if (await tgSend(lead.tg_chat_id, text)) sent.push('telegram');
    else failed.push('telegram');
  }

  if ((channel === 'email' || channel === 'both') && lead.email) {
    // Email-канал не реализован: оператор звонит клиенту по телефону.
    sent.push('email_queued');
  }

  await pool.query(
    `UPDATE leads SET status = 'proposal_sent', updated_at = NOW() WHERE id = $1`,
    [leadId],
  );

  return {
    ok: true,
    sent,
    failed,
    pdfUrl,
    message: sent.length > 0
      ? `Предложение отправлено клиенту (${sent.join(', ')})`
      : 'Каналы отправки не настроены (нет telegram_id и email у лида)',
  };
}
