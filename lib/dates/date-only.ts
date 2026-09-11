/**
 * Дата без времени (DATE в PostgreSQL) на границе API и в UI.
 *
 * node-pg отдаёт DATE как JS Date, и в JSON она уезжает строкой
 * `2026-09-20T00:00:00.000Z`; клиенты, писавшие `value + 'T00:00'` в
 * расчёте на `2026-09-20`, получали `Invalid Date` на трёх экранах
 * оператора (#1795). Одно поле — две формы; здесь принимаются обе,
 * а на выходе — либо дата, либо честное «не указана».
 *
 * Правило (§4.0): у разбора три исхода — дата / нет значения / мусор.
 * Второй и третий не рисуются как первый.
 */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** `2026-09-20` или `2026-09-20T00:00:00.000Z` → локальная дата в полдень (без сдвига суток). */
export function parseDateOnly(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== 'string') return null;
  const m = DATE_ONLY_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, 0);
  // 2026-02-31 «проходит» регулярку, но JS переносит её в март — это мусор.
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) {
    return null;
  }
  return date;
}

/** Каноническая строка `YYYY-MM-DD` или null. */
export function toDateOnlyString(value: unknown): string | null {
  const d = parseDateOnly(value);
  if (!d) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export const DATE_MISSING_LABEL = 'дата не указана';

/** Читаемая дата по-русски; при отсутствии или мусоре — подпись, а не `Invalid Date`. */
export function formatDateOnly(
  value: unknown,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' },
  fallback: string = DATE_MISSING_LABEL,
): string {
  const d = parseDateOnly(value);
  return d ? d.toLocaleDateString('ru-RU', options) : fallback;
}
