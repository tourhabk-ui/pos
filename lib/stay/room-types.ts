/**
 * Словарь типов номеров — из CHECK-ограничения accommodation_rooms
 * (migration 716). Единственный источник для Zod-схем и UI.
 */

export const ROOM_TYPES = ['single', 'double', 'twin', 'triple', 'suite', 'family', 'dormitory'] as const;

export type RoomType = (typeof ROOM_TYPES)[number];

export const ROOM_TYPE_LABELS: Record<RoomType, string> = {
  single: 'Одноместный',
  double: 'Двухместный (одна кровать)',
  twin: 'Двухместный (две кровати)',
  triple: 'Трёхместный',
  suite: 'Люкс',
  family: 'Семейный',
  dormitory: 'Общий (дормиторий)',
};
