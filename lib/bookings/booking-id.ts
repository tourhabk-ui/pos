/**
 * Нормализация id брони. Список /api/bookings отдаёт брони оператора с
 * префиксом `op-<bigint>` (чтобы не путать с legacy-бронями), а таблица
 * operator_bookings.id — это BIGINT, не UUID. Роуты по одной брони получают id
 * из URL и должны привести его к чистому bigint-строке для параметра запроса.
 *
 * Возвращаем строку (а не number): bigint может превысить Number.MAX_SAFE_INTEGER,
 * pg принимает bigint строкой без потери точности. null — если id не похож на bigint.
 */
export function normalizeBookingId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.startsWith('op-') ? raw.slice(3) : raw;
  return /^[0-9]{1,19}$/.test(s) ? s : null;
}
