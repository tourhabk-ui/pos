/**
 * lib/crm/labels.ts — подписи CRM словами, одни для сервера и экрана
 * (CRM #2325). Заголовки событий ленты строит сервер, экран показывает те же
 * слова — два словаря разошлись бы на первой же правке.
 */
import type { SourceKind } from '@/lib/crm/contacts';

export const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  operator_booking: 'Бронь тура',
  accommodation_booking: 'Бронь жилья',
  gear_rental: 'Аренда снаряжения',
  transfer_seat_booking: 'Места в машине',
  lead: 'Заявка',
  agent_client: 'Клиент агента',
};

/** Роль партнёра словами — для экрана администратора. */
export const PARTNER_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  operator: 'Оператор',
  guide: 'Гид',
  transfer: 'Перевозчик',
  agent: 'Агент',
  stay: 'Жильё',
  gear: 'Прокат',
};

export function partnerCategoryLabel(category: string): string {
  return PARTNER_CATEGORY_LABELS[category] ?? category;
}

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

/** Где одно слово значит разное: `active` у брони — «идёт», у клиента агента — «в работе». */
const STATUS_LABELS_BY_KIND: Partial<Record<SourceKind, Readonly<Record<string, string>>>> = {
  agent_client: { prospect: 'потенциальный', active: 'в работе', inactive: 'неактивный' },
};

export function statusLabel(status: string | null | undefined, kind?: SourceKind): string | null {
  if (!status) return null;
  return (kind && STATUS_LABELS_BY_KIND[kind]?.[status]) ?? STATUS_LABELS[status] ?? status;
}
