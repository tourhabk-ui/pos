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

/** Хранимая форма «+7XXXXXXXXXX» → «+7 XXX XXX-XX-XX». Не номер — null. */
export function formatContactPhone(stored: string | null | undefined): string | null {
  const n = normalizeContactPhone(stored);
  if (!n) return null;
  return `+7 ${n.slice(2, 5)} ${n.slice(5, 8)}-${n.slice(8, 10)}-${n.slice(10, 12)}`;
}
