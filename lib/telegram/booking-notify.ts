/**
 * Telegram уведомления по бронированиям
 *
 * Все точки ввода:
 *   1. Турист создал бронь → сообщение туристу "принято, ждём оператора"
 *   2. Оператор подтвердил → сообщение туристу "подтверждено!"
 *   3. Бронь отменена → сообщение туристу с деталями возврата
 *
 * Запускаются как fire-and-forget, не блокируют основной поток.
 */

import { telegramService } from '@/lib/notifications/telegram';
import { query } from '@/lib/database';
import { getPublicBaseUrl } from '@/lib/config';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getTouristTelegramId(userId: string): Promise<string | null> {
  try {
    const res = await query<{ telegram_id: string }>(
      `SELECT telegram_id::text FROM users WHERE id = $1 AND telegram_id IS NOT NULL LIMIT 1`,
      [userId]
    );
    return res.rows[0]?.telegram_id ?? null;
  } catch { return null; }
}

/**
 * Турист создал бронирование — подтверждение принятия.
 */
export function notifyTouristBookingCreated(
  userId: string,
  booking: {
    id: string;
    tourTitle: string;
    date: Date;
    participants: number;
    totalAmount: number;
    /**
     * Ключ доступа к брони (`operator_bookings.access_token`, миграция 943).
     *
     * До 14.09 ключ уходил ОДНОЙ веткой — письмом, и только если турист
     * оставил почту. Здесь его не было вовсе: сообщение звало в личный
     * кабинет, а `/booking-success` и PDF с договором открываются только по
     * ключу. У канала, который турист выбрал сам, свой способ доставки есть
     * — этой ссылкой (#1889).
     *
     * Ключ, а не персональные данные: Telegram зарубежный, и телефон с
     * почтой туда по-прежнему не идут (см. notifyTouristDocumentExpiring).
     * Ссылку с тем же ключом бот Кузьмича шлёт в этот же канал с самого
     * начала — контракт канала не меняется.
     */
    accessToken?: string | null;
  }
): void {
  void (async () => {
    try {
      const chatId = await getTouristTelegramId(userId);
      if (!chatId) return;

      const dateStr = booking.date.toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric',
      });

      await telegramService.sendMessage({
        chatId,
        text: [
          '<b>Бронирование принято!</b>',
          '',
          `<b>Тур:</b> ${esc(booking.tourTitle)}`,
          `<b>Дата:</b> ${dateStr}`,
          `<b>Участников:</b> ${booking.participants}`,
          `<b>Сумма:</b> ${booking.totalAmount.toLocaleString('ru-RU')} ₽`,
          '',
          'Оператор рассмотрит заявку в течение нескольких часов.',
          '',
          // Ссылка с ключом — первой: по ней открываются статус, условия и
          // документы. Ссылка на кабинет остаётся второй строкой, но сама по
          // себе заявку не открывает, и звать только туда значило бы обещать
          // доступ, которого у ссылки нет.
          ...(booking.accessToken
            ? [`<a href="${getPublicBaseUrl()}/booking-success/${booking.id}?t=${encodeURIComponent(booking.accessToken)}">Открыть заявку →</a>`,
               'Сохраните это сообщение: по одному номеру заявка не открывается.',
               '']
            : []),
          `<a href="https://vedarai.ru/hub/tourist/bookings">Мои бронирования →</a>`,
        ].join('\n'),
        parseMode: 'HTML',
      });
    } catch {}
  })();
}

/**
 * Оператор подтвердил бронирование — уведомление туристу.
 */
export function notifyTouristBookingConfirmed(
  userId: string,
  booking: {
    id: string;
    tourTitle: string;
    date: Date;
    participants: number;
  }
): void {
  void (async () => {
    try {
      const chatId = await getTouristTelegramId(userId);
      if (!chatId) return;

      const dateStr = booking.date.toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric',
      });

      await telegramService.sendMessage({
        chatId,
        text: [
          '<b>Оператор подтвердил бронирование!</b>',
          '',
          `<b>Тур:</b> ${esc(booking.tourTitle)}`,
          `<b>Дата:</b> ${dateStr}`,
          `<b>Участников:</b> ${booking.participants}`,
          '',
          'Подготовьтесь к поездке — оператор свяжется с вами ближе к дате.',
          '',
          `<a href="https://vedarai.ru/hub/tourist/bookings">Детали брони →</a>`,
        ].join('\n'),
        parseMode: 'HTML',
      });
    } catch {}
  })();
}

/**
 * Бронирование отменено — уведомление туристу с деталями возврата.
 */
export function notifyTouristBookingCancelled(
  userId: string,
  booking: {
    id: string;
    tourTitle: string;
    cancelledBy: 'tourist' | 'operator' | 'admin';
    refundPercent: number;
    refundAmount: number;
    refundReason: string;
  }
): void {
  void (async () => {
    try {
      const chatId = await getTouristTelegramId(userId);
      if (!chatId) return;

      const byLabel = booking.cancelledBy === 'operator'
        ? 'Оператор отменил бронирование'
        : booking.cancelledBy === 'admin'
          ? 'Бронирование отменено администратором'
          : 'Бронирование отменено';

      const refundLine = booking.refundAmount > 0
        ? `\n<b>Возврат:</b> ${booking.refundAmount.toLocaleString('ru-RU')} ₽ (${booking.refundPercent}%)`
        : '\n<b>Возврат:</b> не предусмотрен';

      await telegramService.sendMessage({
        chatId,
        text: [
          `<b>${byLabel}</b>`,
          '',
          `<b>Тур:</b> ${esc(booking.tourTitle)}`,
          refundLine,
          booking.refundReason ? `<i>${esc(booking.refundReason)}</i>` : '',
          '',
          'Если есть вопросы — напиши прямо здесь или обратись в поддержку.',
        ].filter(s => s !== '').join('\n'),
        parseMode: 'HTML',
      });
    } catch {}
  })();
}

/**
 * Срок документа подходит к концу.
 *
 * Отправляется один раз на документ — отметку ставит вызывающий
 * (`markDocumentReminderSent`), иначе напоминание придёт каждый день до
 * самого истечения.
 *
 * Номер документа В СООБЩЕНИЕ НЕ ИДЁТ: это персональные данные, а Telegram —
 * зарубежный канал. Человеку хватает вида документа и даты, чтобы понять, о
 * чём речь.
 */
export function notifyTouristDocumentExpiring(
  userId: string,
  doc: { documentType: string; expiryDate: string; daysLeft: number },
): void {
  void (async () => {
    try {
      const chatId = await getTouristTelegramId(userId);
      if (!chatId) return;
      const when = doc.daysLeft <= 0
        ? 'срок уже истёк'
        : `осталось дней: ${doc.daysLeft}`;
      await telegramService.sendMessage({
        chatId,
        text: [
          '<b>Документ скоро станет недействителен</b>',
          '',
          `${DOCUMENT_LABELS[doc.documentType] ?? doc.documentType} — до ${doc.expiryDate} (${when}).`,
          '',
          'Проверьте перед поездкой: без действующего документа не пустят на маршрут и не оформят страховку.',
        ].join('\n'),
      });
    } catch (err) {
      // Молчать нельзя: непришедшее напоминание неотличимо от «напоминать было не о чем».
      console.error('[booking-notify] напоминание о документе не ушло:',
        err instanceof Error ? err.message : err);
    }
  })();
}

/** Как называется вид документа для человека. Неизвестный вид показывается как есть. */
const DOCUMENT_LABELS: Record<string, string> = {
  passport: 'Паспорт',
  international_passport: 'Загранпаспорт',
  insurance: 'Страховка',
  visa: 'Виза',
  driver_license: 'Водительское удостоверение',
  medical: 'Медицинская справка',
};
