/**
 * Уведомления о бронях жилья: владельцу и админу — о новой брони и отмене,
 * ГОСТЮ — о подтверждении и отмене владельцем (до 26.09 гость не узнавал ни
 * о том, ни о другом: PATCH уведомлял только владельца и админа).
 *
 * Оплата жилья — на месте, владельцу при заселении (решение владельца 26.09).
 * Платформа денег за проживание не принимает, значит и возвращать ей нечего:
 * тексты ниже не поручают владельцу «перевести возврат».
 *
 * Имя и телефон гостя — ПД, адресованные не гостю: идут в MAX через общую
 * дверь sendPdAlert (решение владельца 23.08). В Telegram при недоступности
 * MAX уходит заглушка без имени и телефона.
 * Всё non-fatal — сбой уведомления не должен ломать создание/отмену брони,
 * но и не глушится: шаг и SQLSTATE пишутся в лог (logStayFailure), без ПД.
 */

import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';
import { query } from '@/lib/database';
import { emailService } from '@/lib/notifications/email-service';
import { sendPushToUser } from '@/lib/notifications/web-push';
import { escapeHtml, safeSubject } from '@/lib/text/escape-html';

import { STAY_PAY_ON_SITE } from '@/lib/stay/pay-on-site';
export { STAY_PAY_ON_SITE };

/**
 * След отказа без ПД: имя шага и SQLSTATE/сообщение, но не тело строки
 * (§4.0: пустой catch превращает поломку в «ничего не было»).
 */
import { logStayFailure } from '@/lib/stay/db-failure';
export { logStayFailure };

async function tgSend(chatId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (res && res.ok === false) {
      logStayFailure('telegram: сообщение не принято', `HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Non-fatal, но не молча
    logStayFailure('telegram: сеть', err);
    return false;
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
  /** Telegram chat владельца объекта (partners.telegram_chat_id) — только заглушка */
  ownerTelegramChatId?: string | null;
  /** Адрес владельца в MAX (partners.max_chat_id) — туда идут ПД гостя */
  ownerMaxChatId?: string | number | null;
}

function fmtDate(d: string): string {
  // 'YYYY-MM-DD' → 'DD.MM.YYYY'
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('.') : d;
}

export async function notifyNewStayBooking(p: StayBookingNotifyPayload): Promise<void> {
  const common = [
    `<b>Новая бронь жилья #${p.bookingId}</b>`,
    `Объект: ${esc(p.accommodationName)}`,
    p.roomName ? `Номер: ${esc(p.roomName)}` : null,
    `Заезд: ${fmtDate(p.checkInDate)} · Выезд: ${fmtDate(p.checkOutDate)}`,
    `Гостей: ${p.guests}`,
    `Сумма: ${money(p.totalPrice)} — гость платит вам при заселении`,
  ].filter(Boolean) as string[];

  const contacts = [
    p.guestName ? `Гость: ${esc(p.guestName)}` : null,
    p.guestPhone ? `Телефон: ${esc(p.guestPhone)}` : null,
  ].filter(Boolean) as string[];

  const text = [...common, ...contacts].join('\n');
  const stub = [
    ...common,
    contacts.length > 0 ? 'Имя и телефон гостя — в MAX и в кабинете.' : 'Контактов гостя в брони нет.',
  ].join('\n');
  const buttons = [{ text: 'Открыть брони', url: `${getPublicBaseUrl()}/hub/stay/bookings` }];

  const adminRes = await sendPdAlert({ text, stub, buttons });
  if (!adminRes.delivered) {
    console.error(`[notifyNewStayBooking] админу ПД не доставлены (${adminRes.channel}) — ${adminRes.reason}`);
  }

  if (p.ownerMaxChatId || p.ownerTelegramChatId) {
    const ownerRes = await sendPdAlert({
      text, stub, buttons,
      to: { maxChatId: p.ownerMaxChatId, telegramChatId: p.ownerTelegramChatId },
    });
    if (!ownerRes.delivered) {
      console.error(`[notifyNewStayBooking] владельцу ПД не доставлены (${ownerRes.channel}) — ${ownerRes.reason}`);
    }
  }
}

export interface StayBookingCancelPayload {
  bookingId: string;
  accommodationName: string;
  checkInDate: string;
  checkOutDate: string;
  ownerTelegramChatId?: string | null;
  /** Кто отменил — влияет только на формулировку заголовка */
  byOwner?: boolean;
  /**
   * Была ли бронь оплачена ЧЕРЕЗ ПЛАТФОРМУ. Бывает только у старых броней —
   * до перехода на оплату на месте (26.09). Такой возврат оформляет
   * администрация платформы, не владелец.
   */
  wasPaid?: boolean;
  /** Сумма к возврату, если бронь была оплачена через платформу */
  refundAmount?: number | null;
  /** Процент возврата по политике */
  refundPercent?: number | null;
  /** Причина/итог по политике (точная формулировка тира) */
  refundReason?: string | null;
}

/**
 * Строка о деньгах в уведомлении об отмене. Владельцу переводить ничего не
 * нужно никогда: при оплате на месте денег не было, а старую оплату через
 * платформу возвращает администрация платформы (§7). До 26.09 здесь стояло
 * «Переведите вручную по CloudPayments» — владельцу, у которого этих денег
 * не было.
 */
export function stayCancelMoneyLine(
  p: Pick<StayBookingCancelPayload, 'wasPaid' | 'refundAmount' | 'refundPercent'>,
): string {
  if (p.wasPaid) {
    return p.refundAmount && p.refundAmount > 0
      ? `Бронь была оплачена через платформу: возврат гостю ${money(p.refundAmount)}${p.refundPercent != null ? ` (${p.refundPercent}%)` : ''} оформляет администрация платформы. От владельца действий не требуется.`
      : 'Бронь была оплачена через платформу — вопрос возврата у администрации платформы.';
  }
  return 'Оплата — на месте при заселении; предоплаты не было, возвращать нечего.';
}

export async function notifyStayBookingCancelled(p: StayBookingCancelPayload): Promise<void> {
  const text = [
    `<b>Бронь жилья #${p.bookingId} отменена ${p.byOwner ? 'объектом' : 'гостем'}</b>`,
    `Объект: ${esc(p.accommodationName)}`,
    `Даты: ${fmtDate(p.checkInDate)} — ${fmtDate(p.checkOutDate)}`,
    stayCancelMoneyLine(p),
    `Даты снова свободны для продажи.`,
  ].join('\n');

  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (adminChatId) await tgSend(adminChatId, text);
  if (p.ownerTelegramChatId) await tgSend(p.ownerTelegramChatId, text);
}

// ── Гостю: владелец подтвердил / отменил ─────────────────────────────────────

export interface StayGuestStatusPayload {
  /** users.id гостя; нет — уведомлять некого */
  guestUserId: string | null;
  bookingId: string;
  status: 'confirmed' | 'cancelled';
  accommodationName: string;
  roomName?: string | null;
  checkInDate: string;
  checkOutDate: string;
  totalPrice?: number | null;
  /** Причина отмены, введённая владельцем, — свободный текст человека */
  cancellationReason?: string | null;
  /** Бронь была оплачена через платформу (только старые) */
  wasPaid?: boolean;
  refundAmount?: number | null;
}

export interface StayGuestNotifyResult {
  email: 'sent' | 'failed' | 'no_address';
  /** push уходит через шлюз настроек и VAPID — «передано шлюзу», не «доставлено» */
  push: 'handed_off' | 'failed';
  telegram: 'sent' | 'failed' | 'no_address';
}

function guestMoneyText(p: StayGuestStatusPayload): string {
  if (p.status === 'confirmed') return `${STAY_PAY_ON_SITE}.`;
  if (p.wasPaid) {
    return p.refundAmount && p.refundAmount > 0
      ? `Бронь была оплачена через платформу — возврат ${money(p.refundAmount)} оформит администрация платформы.`
      : 'Бронь была оплачена через платформу — по возврату с вами свяжется администрация платформы.';
  }
  return 'Предоплаты не было — платить и возвращать ничего не нужно.';
}

/**
 * Гостю — о решении владельца по брони: письмо, push и Telegram (если
 * привязан). Всё, что ввёл человек (причина отмены, название объекта и
 * номера), экранируется. Сбой любого канала бронь не ломает, но пишется в
 * лог именем канала — без адреса и имени гостя.
 */
export async function notifyStayGuestStatus(p: StayGuestStatusPayload): Promise<StayGuestNotifyResult> {
  const result: StayGuestNotifyResult = { email: 'no_address', push: 'failed', telegram: 'no_address' };
  if (!p.guestUserId) return result;

  const confirmed = p.status === 'confirmed';
  const title = confirmed ? 'Бронь жилья подтверждена' : 'Бронь жилья отменена владельцем';
  const dates = `${fmtDate(p.checkInDate)} — ${fmtDate(p.checkOutDate)}`;
  const reason = !confirmed && p.cancellationReason && p.cancellationReason.trim()
    ? p.cancellationReason.trim().slice(0, 500)
    : null;
  const moneyText = guestMoneyText(p);
  const staysUrl = `${getPublicBaseUrl()}/hub/tourist/stays`;

  let contact: { email: string | null; telegram_id: string | null } | null = null;
  try {
    const r = await query<{ email: string | null; telegram_id: string | null }>(
      `SELECT email, telegram_id::text AS telegram_id FROM users WHERE id = $1`,
      [p.guestUserId],
    );
    contact = r.rows[0] ?? null;
  } catch (err) {
    logStayFailure('гостю: контакты не прочитаны', err);
  }

  if (contact?.email) {
    try {
      const html = `
        <h2>${title}</h2>
        <p><strong>Объект:</strong> ${escapeHtml(p.accommodationName)}</p>
        ${p.roomName ? `<p><strong>Номер:</strong> ${escapeHtml(p.roomName)}</p>` : ''}
        <p><strong>Даты:</strong> ${dates}</p>
        ${p.totalPrice != null ? `<p><strong>Стоимость:</strong> ${money(p.totalPrice)}</p>` : ''}
        ${reason ? `<p><strong>Причина:</strong> ${escapeHtml(reason)}</p>` : ''}
        <p>${escapeHtml(moneyText)}</p>
        <p>Брони — в личном кабинете: <a href="${escapeHtml(staysUrl)}">Мои проживания</a>.</p>`;
      const sent = await emailService.sendEmail({
        to: contact.email,
        subject: safeSubject(`${title}: ${p.accommodationName}`),
        html,
      });
      result.email = sent.success ? 'sent' : 'failed';
      if (!sent.success) logStayFailure(`гостю: письмо (${p.status}) не отправлено`, sent.error);
    } catch (err) {
      result.email = 'failed';
      logStayFailure(`гостю: письмо (${p.status})`, err);
    }
  }

  try {
    await sendPushToUser(p.guestUserId, {
      title,
      body: `${p.accommodationName}, ${dates}. ${moneyText}`,
      url: '/hub/tourist/stays',
      tag: `stay-${p.bookingId}`,
    }, {
      // Следствие действия владельца, не рассылка.
      kind: 'transactional',
      type: confirmed ? 'stay_booking_confirmed' : 'stay_booking_cancelled',
    });
    result.push = 'handed_off';
  } catch (err) {
    logStayFailure(`гостю: push (${p.status})`, err);
  }

  if (contact?.telegram_id) {
    const text = [
      `<b>${title}</b>`,
      `Объект: ${esc(p.accommodationName)}`,
      p.roomName ? `Номер: ${esc(p.roomName)}` : null,
      `Даты: ${dates}`,
      reason ? `Причина: ${esc(reason)}` : null,
      esc(moneyText),
      `<a href="${escapeHtml(staysUrl)}">Мои проживания</a>`,
    ].filter(Boolean).join('\n');
    result.telegram = (await tgSend(contact.telegram_id, text)) ? 'sent' : 'failed';
  }

  return result;
}
