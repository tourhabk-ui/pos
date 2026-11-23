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
import { logSwallowedFailure } from '@/lib/observability/swallowed';

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
    } catch (err) { logSwallowedFailure('telegram/admin-notify', 'сообщение админу о новом обращении', err); }
  })();
}

/**
 * Бюджет LLM превышен — алерт владельцу. Возвращает исход доставки: «алерт
 * отправлен» вызывающий вправе сказать только при `ok: true`.
 */
export function notifyBudgetAlert(spentUsd: number, limitUsd: number, runnerUsd: number | null = null): Promise<TgSendOutcome> {
  return sendAdminMessage('llm-budget-check', budgetAlertText(spentUsd, limitUsd, runnerUsd));
}

/**
 * Текст тревоги о бюджете. Ссылка — на раздел, где расход разложен по
 * моделям и агентам: «Расходы AI», вкладка «Деньги» (`/hub/admin/ai-usage`).
 * До 22.11 тревога вела в корень админки и звала в «Статистику LLM» —
 * раздела с таким именем нет (разбор 03.11).
 *
 * С 23.11 порог сверяется с расходом сайта — тем, что считает суточный стоп
 * (слово владельца «1 да», `lib/ai/spend-scope.ts`). Расход раннера GitHub
 * стоп не закрывает и назван отдельной строкой; null — сумма не передана.
 */
export function budgetAlertText(spentUsd: number, limitUsd: number, runnerUsd: number | null = null): string {
  return [
    '<b>Превышен дневной бюджет LLM сайта</b>',
    '',
    `<b>Потрачено сайтом:</b> $${spentUsd.toFixed(4)}`,
    `<b>Лимит:</b> $${limitUsd.toFixed(2)}`,
    `<b>Превышение:</b> $${(spentUsd - limitUsd).toFixed(4)}`,
    ...(runnerUsd !== null && Number.isFinite(runnerUsd)
      ? [`<b>Раннер GitHub (в лимит не входит):</b> $${runnerUsd.toFixed(4)}`]
      : []),
    '',
    'Суточный стоп закрыт до 00:00 UTC: Кузьмич отвечает туристам, что на сегодня отдыхает.',
    'Расход по моделям и агентам — <a href="https://vedarai.ru/hub/admin/ai-usage">Расходы AI → Деньги</a>.',
  ].join('\n');
}

/**
 * Сайты партнёров изменились (наблюдение 1311, lib/partners/site-watch) —
 * владельцу в личку. Текст собран и экранирован там же; здесь только доставка
 * с исходом: «сообщил» крон вправе сказать только при `ok: true`.
 */
export function notifyOwnerPartnerSites(text: string): Promise<TgSendOutcome> {
  return sendAdminMessage('partner-site-watch', text);
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
    } catch (err) { logSwallowedFailure('telegram/admin-notify', 'сообщение админу об эскалации обращения', err); }
  })();
}
