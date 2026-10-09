/**
 * Подписи CRM для экрана (CRM #2325). Словарь один с сервером
 * (`lib/crm/labels.ts`, `lib/crm/event-kinds.ts`) — здесь только форматы дат.
 */
import { parseDateOnly, formatDateOnly } from '@/lib/dates/date-only';

export { SOURCE_KIND_LABELS, PARTNER_CATEGORY_LABELS, partnerCategoryLabel, statusLabel } from '@/lib/crm/labels';
export { EVENT_KIND_LABELS, ACTOR_KIND_LABELS } from '@/lib/crm/event-kinds';

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

/** Момент с временем — для ленты: «9 окт., 14:05» по Камчатке. */
export function formatMomentTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kamchatka' });
}
