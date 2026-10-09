/**
 * lib/crm/contacts-export.ts — выгрузка клиентов партнёра в CSV (CRM #2325,
 * шаг 1а-2b).
 *
 * Прежний экран оператора собирал CSV в браузере: только текущая страница
 * (20 строк), без защиты от формул (`"${v}"`), и «Потрачено» там была сумма
 * броней, а не оплат. Теперь выгрузку собирает сервер:
 *  - те же клиенты и те же фильтры, что на экране, — «что вижу, то и выгружаю»;
 *  - ячейки — через `csvCell` (lib/operator/csv): имя клиента пишет посторонний
 *    человек, и `=HYPERLINK(...)` в нём не должен стать формулой в таблице;
 *  - в выгрузке только то, что партнёр и так видит на экране (CRM не
 *    расширяет доступ к ПД).
 *
 * Без пула: собирает строки из уже прочитанного — её читает роут и тест.
 */
import { toCSV } from '@/lib/operator/csv';
import type { ContactListItem } from '@/lib/crm/contact-queries';
import type { OperatorClientStats } from '@/lib/crm/operator-clients';
import { OPERATOR_SEGMENT_LABELS } from '@/lib/crm/operator-segments';

/** Больше — не выгрузка, а слепок базы: пусть сузят поиском. */
export const EXPORT_MAX_ROWS = 5000;

const BASE_HEADERS: Record<string, string> = {
  name: 'Имя',
  phone: 'Телефон',
  email: 'Почта',
  tags: 'Метки',
  first_seen: 'Первое обращение',
  last_activity: 'Последнее обращение',
  sources: 'Обращений',
};

const OPERATOR_HEADERS: Record<string, string> = {
  bookings: 'Броней (без отменённых)',
  booked_sum: 'Сумма подтверждённых броней, ₽',
  last_booking: 'Последняя бронь',
  segment: 'Сегмент',
};

/** Дата по Камчатке, ДД.ММ.ГГГГ: в таблице партнёра — его сутки, а не UTC. */
export function exportDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU', { timeZone: 'Asia/Kamchatka' });
}

export type ExportItem = ContactListItem & { stats?: OperatorClientStats };

export function contactsToCsv(items: ExportItem[], withOperatorStats: boolean): string {
  const headers = withOperatorStats ? { ...BASE_HEADERS, ...OPERATOR_HEADERS } : BASE_HEADERS;
  const rows = items.map((c) => ({
    // Имени нет — пустая ячейка, а не выдуманное «Без имени» (§4.0).
    name: c.display_name ?? '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    tags: c.tags.join(', '),
    first_seen: exportDate(c.first_seen_at),
    last_activity: exportDate(c.last_activity_at),
    sources: c.sources_count,
    ...(withOperatorStats && c.stats
      ? {
          bookings: c.stats.bookings,
          booked_sum: c.stats.booked_sum,
          last_booking: exportDate(c.stats.last_booking_at),
          segment: OPERATOR_SEGMENT_LABELS[c.stats.segment],
        }
      : {}),
  }));
  return toCSV(rows, headers);
}
