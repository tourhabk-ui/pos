/**
 * Уведомления о событиях поддержки в личку владельцу.
 * Использует TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_ID.
 * Fire-and-forget, ошибки подавляются.
 */

import type { SupportTicket } from '@/lib/support/ticket.service';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';

const CATEGORY_LABELS: Record<string, string> = {
  billing:  'Оплата',
  booking:  'Бронирование',
  safety:   'Безопасность',
  refund:   'Возврат',
  content:  'Контент',
  technical:'Технический',
  operator: 'Оператор',
  other:    'Другое',
};

async function sendAdminMessage(text: string): Promise<void> {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const ownerId = process.env.TELEGRAM_OWNER_ID ?? '171286547';
  if (!token) return;

  await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:                  ownerId,
      text,
      parse_mode:               'HTML',
      disable_web_page_preview: true,
    }),
  }).catch(() => {});
}

/**
 * Новый тикет поддержки — уведомление в @tourhab_bot.
 */
export function notifyAdminNewTicket(ticket: SupportTicket): void {
  void (async () => {
    try {
      const site     = getPublicBaseUrl();
      const category = CATEGORY_LABELS[ticket.category] ?? ticket.category;
      const user     = ticket.userName
        ? `${ticket.userName}${ticket.userEmail ? ` (${ticket.userEmail})` : ''}`
        : (ticket.userEmail ?? ticket.userId.slice(0, 8));

      // Имя и почта обратившегося — ПД: идут в MAX. В Telegram остаётся тикет
      // без них: тема, категория, канал и первый абзац обращения.
      const common = [
        '<b>Новый тикет поддержки</b>',
        '',
        `<b>Тема:</b> ${ticket.subject}`,
        `<b>Категория:</b> ${category}`,
        `<b>Резидент:</b> ${ticket.assignedAgent ?? 'не назначен'}`,
      ];
      const tail = [
        `<b>Канал:</b> ${ticket.channel}`,
        '',
        ticket.messages[0] ? `<i>${ticket.messages[0].text.slice(0, 200)}</i>` : '',
      ].filter(s => s !== '');

      const res = await sendPdAlert({
        text: [...common, `<b>Пользователь:</b> ${user}`, ...tail].join('\n'),
        stub: [
          ...common,
          `<b>Пользователь:</b> <code>${ticket.userId.slice(0, 8)}</code>`,
          ...tail,
          '',
          'Имя и почта обратившегося — в MAX и в панели.',
        ].join('\n'),
        buttons: [{ text: 'Открыть в панели', url: `${site}/hub/admin/support` }],
      });
      if (!res.delivered) {
        console.error(`[notifyAdminNewTicket] ПД не доставлены (${res.channel}) — ${res.reason}`);
      }
    } catch { /* silent */ }
  })();
}

/**
 * Бюджет LLM превышен — алерт владельцу.
 */
export function notifyBudgetAlert(spentUsd: number, limitUsd: number): void {
  void (async () => {
    try {
      await sendAdminMessage([
        '<b>Превышен дневной бюджет LLM</b>',
        '',
        `<b>Потрачено:</b> $${spentUsd.toFixed(4)}`,
        `<b>Лимит:</b> $${limitUsd.toFixed(2)}`,
        `<b>Превышение:</b> $${(spentUsd - limitUsd).toFixed(4)}`,
        '',
        'Проверь <a href="https://vedarai.ru/hub/admin">панель</a> → Статистика LLM.',
      ].join('\n'));
    } catch { /* silent */ }
  })();
}

/**
 * Тикет эскалирован — срочное уведомление в @tourhab_bot.
 */
export function notifyAdminEscalated(ticket: SupportTicket, reason: string): void {
  void (async () => {
    try {
      const site = 'https://vedarai.ru';
      await sendAdminMessage([
        '<b>ЭСКАЛАЦИЯ тикета</b>',
        '',
        `<b>Тема:</b> ${ticket.subject}`,
        `<b>Причина:</b> ${reason}`,
        `<b>Статус:</b> ожидает решения`,
        '',
        `<a href="${site}/hub/admin/support">Открыть в панели →</a>`,
      ].join('\n'));
    } catch { /* silent */ }
  })();
}
