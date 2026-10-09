/**
 * Подписи CRM для экрана (CRM #2325, шаг 1а-2). Одни на все кабинеты: вид
 * источника и статус называются одинаково у оператора, жилья и проката.
 */
import type { SourceKind } from '@/lib/crm/contacts';
import { parseDateOnly, formatDateOnly } from '@/lib/dates/date-only';

export const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  operator_booking: 'Бронь тура',
  accommodation_booking: 'Бронь жилья',
  gear_rental: 'Аренда снаряжения',
  transfer_seat_booking: 'Места в машине',
  lead: 'Заявка',
  agent_client: 'Клиент агента',
};

/**
 * Статусы источников разные у каждой таблицы. Незнакомый статус показывается
 * как есть: подменить его ближайшим знакомым словом значило бы соврать о
 * состоянии брони.
 */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  new: 'новая',
  pending: 'ждёт ответа',
  requested: 'запрошено',
  confirmed: 'подтверждена',
  active: 'идёт',
  completed: 'завершена',
  cancelled: 'отменена',
  declined: 'отказ',
  overdue: 'просрочена',
  ai_processing: 'разбирается',
  ai_qualified: 'разобрана',
  proposal_sent: 'отправлено предложение',
  awaiting_confirm: 'ждёт подтверждения',
  contacted: 'был контакт',
  qualified: 'квалифицирована',
  converted: 'стала бронью',
  lost: 'потеряна',
};

export function statusLabel(status: string | null): string | null {
  if (!status) return null;
  return STATUS_LABELS[status] ?? status;
}

/**
 * Дата источника: у броней — DATE, у заявки — желаемые даты текстом, как их
 * написал человек («вторая половина июля»). Текст показывается как есть, а
 * не прячется за «дата не указана».
 */
export function formatSourceDate(value: string | null): string | null {
  if (!value) return null;
  return parseDateOnly(value) ? formatDateOnly(value) : value;
}

/** Момент (timestamptz) — день по Камчатке. */
export function formatMoment(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kamchatka' });
}
