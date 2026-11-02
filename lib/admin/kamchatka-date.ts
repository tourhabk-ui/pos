/** Дата для показа — всегда по Камчатке, как живут операторы. */
export const KAMCHATKA_TZ = 'Asia/Kamchatka';

export function formatKamchatkaDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  // Голая дата (YYYY-MM-DD) — календарный день тура, без пояса: не сдвигаем.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}.${m}.${y}`;
  }
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('ru-RU', { timeZone: KAMCHATKA_TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
}
