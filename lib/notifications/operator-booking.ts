/**
 * Уведомления о событиях брони оператора.
 *
 * Имя, телефон и почта туриста — ПД, и адресованы они не туристу, а нам и
 * оператору. Значит идут в MAX через общую дверь sendPdAlert (решение
 * владельца 23.08); в Telegram при недоступности MAX уходит заглушка без ПД.
 * Раньше здесь было три отправки подряд — админу в Telegram, оператору в
 * Telegram и оператору в MAX, — и первые две несли ПД полностью.
 *
 * notifyWeatherAlert ПД не содержит и остаётся в Telegram как было.
 */

import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';

async function tgSend(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch {
    // Non-fatal: telegram failure must not break booking flow
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface BookingNotifyPayload {
  booking_id: bigint | string;
  tour_title: string;
  tourist_name?: string;
  tourist_phone?: string;
  tourist_email?: string;
  booking_date: string;
  participants: number;
  final_price?: number;
  operator_name: string;
  operator_telegram_chat_id?: string;
  operator_max_chat_id?: string | number | null;
  /**
   * Телефон и почта оператора из `partners.contacts` — на случай, когда
   * канала у него нет вовсе. Тогда заявку до него доносит человек, и ему
   * нужно, ЧЕМ доносить (см. notifyNewBooking ниже).
   */
  operator_phone?: string | null;
  operator_email?: string | null;
  via?: string; // 'website' | 'direct_contact' | 'api'
}

/** Чем кончилась доставка заявки оператору — три исхода, не два (§4.0). */
export type OperatorDeliveryOutcome =
  /** Ушло в канал оператора. */
  | { state: 'delivered'; channel: string }
  /** Канал есть, но доставка не удалась — оператор не виноват, чинить связь. */
  | { state: 'failed'; channel: string; reason: string }
  /** Канала нет вовсе: заявка не дойдёт никогда, пока не появится адрес. */
  | { state: 'no_channel' };

/**
 * Заявка оператору. Возвращает ИСХОД доставки, а не void.
 *
 * Находка эволюции 08.09 (issue #1719): у обоих операторов с живыми турами не
 * было ни MAX, ни Telegram — 12 живых туров, и заявка по любому из них
 * создавалась в базе и никуда не уезжала. Через 48 часов Watchdog записывал
 * это как «оператор игнорирует бронь»: наш пробел уезжал в вину оператору.
 *
 * Лог о таком случае здесь уже стоял. Лога мало: строка в консоли не создаёт
 * ни задачи, ни адресата. Поэтому «канала нет» — теперь ОТДЕЛЬНЫЙ исход,
 * который: уходит админу платформы как работа для человека (с телефоном и
 * почтой оператора из профиля — чтобы было чем звонить), и возвращается
 * вызывающему, чтобы тот не выдавал недоставленное за доставленное.
 */
export async function notifyNewBooking(payload: BookingNotifyPayload): Promise<OperatorDeliveryOutcome> {
  const priceStr = payload.final_price
    ? `${payload.final_price.toLocaleString('ru-RU')} ₽`
    : 'не указана';

  const viaLabel: Record<string, string> = {
    website: 'Сайт',
    direct_contact: 'Телефон/мессенджер',
    api: 'API',
  };

  // Общая часть — без ПД: её видно в обоих каналах.
  const common = [
    `<b>Новая бронь #${payload.booking_id}</b>`,
    `Тур: ${esc(payload.tour_title)}`,
    `Оператор: ${esc(payload.operator_name)}`,
    `Дата: ${payload.booking_date}`,
    `Участников: ${payload.participants}`,
    `Цена: ${priceStr}`,
    payload.via ? `Источник: ${viaLabel[payload.via] ?? payload.via}` : null,
  ].filter(Boolean) as string[];

  const contacts = [
    payload.tourist_name ? `Турист: ${esc(payload.tourist_name)}` : null,
    payload.tourist_phone ? `Телефон: ${esc(payload.tourist_phone)}` : null,
    payload.tourist_email ? `Email: ${esc(payload.tourist_email)}` : null,
  ].filter(Boolean) as string[];

  const text = [...common, ...contacts].join('\n');
  const stub = [
    ...common,
    contacts.length > 0 ? 'Контакты туриста — в MAX и в кабинете.' : 'Контактов туриста в брони нет.',
  ].join('\n');

  const link = {
    text: 'Открыть бронь',
    url: `${getPublicBaseUrl()}/hub/operator/bookings/${payload.booking_id}`,
  };

  // Админ платформы.
  const adminRes = await sendPdAlert({ text, stub, buttons: [link] });
  if (!adminRes.delivered) {
    console.error(`[notifyNewBooking] админу ПД не доставлены (${adminRes.channel}) — ${adminRes.reason}`);
  }

  // Оператор — только если у него есть хоть один адрес.
  if (payload.operator_max_chat_id || payload.operator_telegram_chat_id) {
    const opRes = await sendPdAlert({
      text,
      stub,
      buttons: [link],
      to: {
        maxChatId: payload.operator_max_chat_id,
        telegramChatId: payload.operator_telegram_chat_id,
      },
    });
    if (!opRes.delivered) {
      console.error(`[notifyNewBooking] оператору ПД не доставлены (${opRes.channel}) — ${opRes.reason}`);
      return { state: 'failed', channel: opRes.channel, reason: opRes.reason ?? 'причина не названа' };
    }
    return { state: 'delivered', channel: opRes.channel };
  }

  // Канала нет. Это не сбой доставки, а её отсутствие: заявка не дойдёт ни
  // сейчас, ни завтра. Значит её доносит человек — и ему отправляется задача,
  // а не запись в лог.
  const opContacts = [
    payload.operator_phone ? `Телефон: ${esc(payload.operator_phone)}` : null,
    payload.operator_email ? `Почта: ${esc(payload.operator_email)}` : null,
  ].filter(Boolean) as string[];
  const handoff = [
    `<b>Заявка не дойдёт до оператора — нет канала</b>`,
    `Оператор: ${esc(payload.operator_name)}`,
    `Бронь #${payload.booking_id}, тур: ${esc(payload.tour_title)}`,
    `Дата: ${payload.booking_date}, участников: ${payload.participants}`,
    '',
    opContacts.length > 0
      ? 'Свяжитесь с оператором сами:'
      : 'Контактов оператора в профиле тоже нет — заявку донести нечем, нужен разбор.',
    ...opContacts,
    '',
    'Чтобы это перестало повторяться: оператор пишет боту Кузьмича в MAX слово',
    '«партнер» и почту из профиля — бот запишет его чат сам.',
  ].join('\n');
  const handoffRes = await sendPdAlert({ text: handoff, stub: handoff, buttons: [link] });
  console.error(
    `[notifyNewBooking] у оператора «${payload.operator_name}» нет ни MAX, ни Telegram — заявка #${payload.booking_id} до него не дойдёт` +
    (handoffRes.delivered ? '; задача передана админу' : `; АДМИНУ ТОЖЕ НЕ УШЛО (${handoffRes.channel}) — ${handoffRes.reason}`),
  );
  return { state: 'no_channel' };
}

export async function notifyBookingPaid(
  bookingId: bigint | string,
  tourTitle: string,
  amount: number,
  operatorTelegramChatId?: string,
  touristName?: string,
  touristPhone?: string,
  operatorMaxChatId?: string | number | null,
): Promise<void> {
  const common = [
    `<b>Оплата получена — бронь #${bookingId}</b>`,
    `Тур: ${esc(tourTitle)}`,
    `Сумма: ${amount.toLocaleString('ru-RU')} ₽`,
  ];
  const contacts = [
    touristName ? `Турист: ${esc(touristName)}` : null,
    touristPhone ? `Телефон: ${esc(touristPhone)}` : null,
  ].filter(Boolean) as string[];

  const text = [...common, ...contacts].join('\n');
  const stub = [
    ...common,
    contacts.length > 0 ? 'Контакты туриста — в MAX и в кабинете.' : 'Контактов туриста в брони нет.',
  ].join('\n');

  const link = {
    text: 'Открыть бронь',
    url: `${getPublicBaseUrl()}/hub/operator/bookings/${bookingId}`,
  };

  // Владелец платформы. Адрес в MAX у него один — общий рабочий чат.
  const ownerRes = await sendPdAlert({ text, stub, buttons: [link] });
  if (!ownerRes.delivered) {
    console.error(`[notifyBookingPaid] владельцу ПД не доставлены (${ownerRes.channel}) — ${ownerRes.reason}`);
  }

  if (operatorMaxChatId || operatorTelegramChatId) {
    const opRes = await sendPdAlert({
      text,
      stub,
      buttons: [link],
      to: { maxChatId: operatorMaxChatId, telegramChatId: operatorTelegramChatId },
    });
    if (!opRes.delivered) {
      console.error(`[notifyBookingPaid] оператору ПД не доставлены (${opRes.channel}) — ${opRes.reason}`);
    }
  }
}

export async function notifyWeatherAlert(
  tourId: bigint | string,
  tourTitle: string,
  issues: string[],
  bookingsCount: number,
  operatorTelegramChatId?: string
): Promise<void> {
  const text = [
    `<b>Погодный алерт — тур #${tourId}</b>`,
    `${esc(tourTitle)}`,
    `Проблемы:`,
    ...issues.map(i => `- ${esc(i)}`),
    `Бронь на дату: ${bookingsCount} чел.`,
    `Требуется решение: отмена / замена маршрута`,
  ].join('\n');

  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (adminChatId) await tgSend(adminChatId, text);
  if (operatorTelegramChatId) await tgSend(operatorTelegramChatId, text);
}
