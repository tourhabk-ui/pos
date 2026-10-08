/**
 * Телефон объекта жилья для связи (миграция 1179, #2238).
 *
 * В базе — только `+7` и десять цифр (CHECK accommodations_contact_phone_format),
 * поэтому `tel:`-ссылка по построению не получит мусор. Человеку номер
 * показывается с пробелами и дефисами: «+7 962 215-27-77».
 *
 * Номер уходит ТОЛЬКО на страницу карточки и в её API. В ответы AI-инструментов
 * (Кузьмич, MCP) он не идёт: модели зарубежные, номер — контакт человека
 * (pd-guard). Инструменту хватает признака «телефон есть».
 */

const STORED = /^\+7[0-9]{10}$/;

/** Номер в том виде, в каком его хранит база; иначе null («нет номера»). */
export function normalizeContactPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/[^\d+]/g, '');
  const candidate = /^8\d{10}$/.test(digits) ? `+7${digits.slice(1)}` : digits;
  return STORED.test(candidate) ? candidate : null;
}

/** Мессенджеры, ссылку на которые можно построить из номера (миграция 1181). */
export const NUMBER_MESSENGERS = ['telegram', 'whatsapp'] as const;
export type NumberMessenger = (typeof NUMBER_MESSENGERS)[number];

export interface MessengerLink { kind: NumberMessenger; label: string; href: string }

const MESSENGER_LABELS: Record<NumberMessenger, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp' };

/**
 * Ссылки на чат с объектом по его номеру. Нет номера в строгой форме —
 * ссылок нет; неизвестный вид из базы пропускается, а не превращается в
 * догадку. MAX здесь НЕТ: ссылки по номеру в MAX не существует, адрес ведёт
 * на профиль, который знает только его владелец (tests/unit/max-contact).
 */
export function messengerLinks(phone: unknown, messengers: unknown): MessengerLink[] {
  const n = normalizeContactPhone(phone);
  if (!n || !Array.isArray(messengers)) return [];
  const out: MessengerLink[] = [];
  for (const kind of NUMBER_MESSENGERS) {
    if (!messengers.includes(kind)) continue;
    out.push({
      kind,
      label: MESSENGER_LABELS[kind],
      href: kind === 'whatsapp' ? `https://wa.me/${n.slice(1)}` : `https://t.me/${n}`,
    });
  }
  return out;
}

/** Хранимая форма «+7XXXXXXXXXX» → «+7 XXX XXX-XX-XX». Не номер — null. */
export function formatContactPhone(stored: string | null | undefined): string | null {
  const n = normalizeContactPhone(stored);
  if (!n) return null;
  return `+7 ${n.slice(2, 5)} ${n.slice(5, 8)}-${n.slice(8, 10)}-${n.slice(10, 12)}`;
}
