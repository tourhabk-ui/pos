/**
 * Уведомления о бронях жилья владельцу.
 * Зеркало lib/notifications/operator-booking.ts, но для accommodation_bookings:
 * админ (TELEGRAM_CHAT_ID) + владелец объекта (partners.telegram_chat_id).
 * Всё non-fatal — сбой Telegram не должен ломать создание/отмену брони.
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

function money(v: number | null | undefined): string {
  return v != null ? `${v.toLocaleString('ru-RU')} ₽` : 'не указана';
}

export interface StayBookingNotifyPayload {
  bookingId: string;
  accommodationName: string;
  roomName?: string | null;
  checkInDate: string;
  checkOutDate: string;
  guests: number;
  totalPrice?: number | null;
  guestName?: string | null;
  guestPhone?: string | null;
  /** Telegram chat владельца объекта (partners.telegram_chat_id) */
  ownerTelegramChatId?: string | null;
}

function fmtDate(d: string): string {
  // 'YYYY-MM-DD' → 'DD.MM.YYYY'
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('.') : d;
}

export async function notifyNewStayBooking(p: StayBookingNotifyPayload): Promise<void> {
  const text = [
    `<b>Новая бронь жилья #${p.bookingId}</b>`,
    `Объект: ${esc(p.accommodationName)}`,
    p.roomName ? `Номер: ${esc(p.roomName)}` : null,
    `Заезд: ${fmtDate(p.checkInDate)} · Выезд: ${fmtDate(p.checkOutDate)}`,
    `Гостей: ${p.guests}`,
    p.guestName ? `Гость: ${esc(p.guestName)}` : null,
    p.guestPhone ? `Телефон: ${esc(p.guestPhone)}` : null,
    `Сумма: ${money(p.totalPrice)}`,
    `<a href="https://vedarai.ru/hub/stay/bookings">Открыть брони</a>`,
  ].filter(Boolean).join('\n');

  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (adminChatId) await tgSend(adminChatId, text);
  if (p.ownerTelegramChatId) await tgSend(p.ownerTelegramChatId, text);
}

export interface StayBookingCancelPayload {
  bookingId: string;
  accommodationName: string;
  checkInDate: string;
  checkOutDate: string;
  ownerTelegramChatId?: string | null;
  /** Кто отменил — влияет только на формулировку заголовка */
  byOwner?: boolean;
  /** Была ли бронь оплачена (иначе возврат не нужен) */
  wasPaid?: boolean;
  /** Сумма к возврату (офлайн-исполнение), если бронь была оплачена */
  refundAmount?: number | null;
  /** Процент возврата по политике */
  refundPercent?: number | null;
  /** Причина/итог по политике (точная формулировка тира) */
  refundReason?: string | null;
}

export async function notifyStayBookingCancelled(p: StayBookingCancelPayload): Promise<void> {
  const refundLine = p.wasPaid
    ? (p.refundAmount && p.refundAmount > 0
        ? `К возврату гостю: ${money(p.refundAmount)}${p.refundPercent != null ? ` (${p.refundPercent}%)` : ''}. Возврат — вручную по CloudPayments.`
        : (p.refundReason || 'Возврат не предусмотрен по условиям отмены.'))
    : `Предоплаты не было — возврат не требуется.`;

  const text = [
    `<b>Бронь жилья #${p.bookingId} отменена ${p.byOwner ? 'объектом' : 'гостем'}</b>`,
    `Объект: ${esc(p.accommodationName)}`,
    `Даты: ${fmtDate(p.checkInDate)} — ${fmtDate(p.checkOutDate)}`,
    refundLine,
    `Даты снова свободны для продажи.`,
  ].join('\n');

  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (adminChatId) await tgSend(adminChatId, text);
  if (p.ownerTelegramChatId) await tgSend(p.ownerTelegramChatId, text);
}
