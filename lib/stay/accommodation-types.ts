/**
 * Словарь типов размещения — из CHECK-ограничения accommodations
 * (migration 716). Единственный источник для Zod-схем и UI
 * (раньше — три независимые копии).
 */

export const ACCOMMODATION_TYPES = ['hotel', 'hostel', 'apartment', 'guesthouse', 'resort', 'camping', 'glamping', 'cottage'] as const;

export type AccommodationType = (typeof ACCOMMODATION_TYPES)[number];

export const ACCOMMODATION_TYPE_LABELS: Record<AccommodationType, string> = {
  hotel: 'Отель',
  hostel: 'Хостел',
  apartment: 'Апартаменты',
  guesthouse: 'Гостевой дом',
  resort: 'Курорт',
  camping: 'Кемпинг',
  glamping: 'Глэмпинг',
  cottage: 'Коттедж',
};
