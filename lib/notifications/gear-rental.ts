/**
 * Уведомления о заявках на аренду снаряжения.
 * Зеркало lib/notifications/stay-booking.ts: админ платформы + владелец
 * проката. Всё non-fatal — сбой уведомления не должен ломать создание заявки.
 * До этого модуля заявка падала в тишину: партнёр узнавал о ней, только сам
 * зайдя в кабинет.
 *
 * Имя и телефон клиента — ПД, адресованные не ему: идут в MAX через общую
 * дверь sendPdAlert (решение владельца 23.08); в Telegram при недоступности
 * MAX уходит заглушка без контактов.
 */

import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';

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
  /** Telegram chat владельца проката — только заглушка без ПД */
  partnerChatId?: string | null;
  /** Адрес владельца в MAX (partners.max_chat_id) — туда идут контакты клиента */
  partnerMaxChatId?: string | number | null;
}

export async function notifyNewGearRental(p: GearRentalNotifyPayload): Promise<void> {
  const common = [
    '<b>Новая заявка на аренду снаряжения</b>',
    '',
    `${esc(p.gearName)} — ${p.quantity} шт.`,
    `Даты: ${p.startDate} → ${p.endDate}`,
    `Сумма: ${p.totalPrice.toLocaleString('ru-RU')} ₽`,
  ];

  const text = [...common, `Клиент: ${esc(p.customerName)}, ${esc(p.customerPhone)}`].join('\n');
  const stub = [...common, 'Имя и телефон клиента — в MAX и в кабинете.'].join('\n');
  const buttons = [{ text: 'Подтвердить', url: `${getPublicBaseUrl()}/hub/gear/rentals` }];

  const adminRes = await sendPdAlert({ text, stub, buttons });
  if (!adminRes.delivered) {
    console.error(`[notifyNewGearRental] админу ПД не доставлены (${adminRes.channel}) — ${adminRes.reason}`);
  }

  if (p.partnerMaxChatId || p.partnerChatId) {
    const partnerRes = await sendPdAlert({
      text, stub, buttons,
      to: { maxChatId: p.partnerMaxChatId, telegramChatId: p.partnerChatId },
    });
    if (!partnerRes.delivered) {
      console.error(`[notifyNewGearRental] владельцу проката ПД не доставлены (${partnerRes.channel}) — ${partnerRes.reason}`);
    }
  }
}
