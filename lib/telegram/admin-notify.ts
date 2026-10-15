/**
 * Уведомления о событиях поддержки в личку владельцу.
 * Использует TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_ID.
 *
 * Отправка идёт общим отправителем `tgSend` с названным получателем: отказ
 * Telegram пишется в лог, а алерт о бюджете LLM возвращает исход вызывающему
 * (аудит 15.10, P4-01). Тикетные уведомления по-прежнему fire-and-forget —
 * но без глушения: недоставка видна в логе.
 */

import type { SupportTicket } from '@/lib/support/ticket.service';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';
import { tgSend, type TgSendOutcome } from '@/lib/notifications/tg-send';

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

/**
 * Сообщение в личку владельцу. До аудита 15.10 (P4-01) здесь был свой fetch с
 * `.catch(() => {})`: ответ Telegram не читался, и `/api/cron/llm-budget-check`
 * отвечал `status: 'alert_sent'` при любом исходе — бюджет «срабатывал» только
 * в JSON. Теперь исход доставки возвращается.
 */
function sendAdminMessage(scope: string, text: string): Promise<TgSendOutcome> {
  const ownerId = process.env.TELEGRAM_OWNER_ID ?? '171286547';
  return tgSend(scope, text, { chatId: ownerId });
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
 * Бюджет LLM превышен — алерт владельцу. Возвращает исход доставки: «алерт
 * отправлен» вызывающий вправе сказать только при `ok: true`.
 */
export function notifyBudgetAlert(spentUsd: number, limitUsd: number): Promise<TgSendOutcome> {
  return sendAdminMessage('llm-budget-check', [
    '<b>Превышен дневной бюджет LLM</b>',
    '',
    `<b>Потрачено:</b> $${spentUsd.toFixed(4)}`,
    `<b>Лимит:</b> $${limitUsd.toFixed(2)}`,
    `<b>Превышение:</b> $${(spentUsd - limitUsd).toFixed(4)}`,
    '',
    'Проверь <a href="https://vedarai.ru/hub/admin">панель</a> → Статистика LLM.',
  ].join('\n'));
}

/**
 * Тикет эскалирован — срочное уведомление в @tourhab_bot.
 */
export function notifyAdminEscalated(ticket: SupportTicket, reason: string): void {
  void (async () => {
    try {
      const site = 'https://vedarai.ru';
      await sendAdminMessage('admin-notify', [
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
