/**
 * Уведомления о заявках на аренду снаряжения.
 * Зеркало lib/notifications/stay-booking.ts: админ (TELEGRAM_CHAT_ID) +
 * владелец проката (partners.telegram_chat_id). Всё non-fatal — сбой
 * Telegram не должен ломать создание заявки. До этого модуля заявка
 * падала в тишину: партнёр узнавал о ней, только сам зайдя в кабинет.
 */

async function tgSend(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch {
    // Non-fatal
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface GearRentalNotifyPayload {
  rentalId: string;
  gearName: string;
  quantity: number;
  startDate: string;
  endDate: string;
  totalPrice: number;
  customerName: string;
  customerPhone: string;
  /** Telegram chat владельца проката (partners.telegram_chat_id) */
  partnerChatId?: string | null;
}

export async function notifyNewGearRental(p: GearRentalNotifyPayload): Promise<void> {
  const text = [
    '<b>Новая заявка на аренду снаряжения</b>',
    '',
    `${esc(p.gearName)} — ${p.quantity} шт.`,
    `Даты: ${p.startDate} → ${p.endDate}`,
    `Сумма: ${p.totalPrice.toLocaleString('ru-RU')} ₽`,
    `Клиент: ${esc(p.customerName)}, ${esc(p.customerPhone)}`,
    '',
    `Подтвердить: /hub/gear/rentals`,
  ].join('\n');

  const jobs: Promise<void>[] = [];
  const adminChat = process.env.TELEGRAM_CHAT_ID;
  if (adminChat) jobs.push(tgSend(adminChat, text));
  if (p.partnerChatId) jobs.push(tgSend(p.partnerChatId, text));
  await Promise.allSettled(jobs);
}
