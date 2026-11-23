/**
 * lib/stay/inventory-source.ts
 *
 * Класс источника фонда жилья — развилка собственной системы бронирования
 * (research/own-booking-system.md §4, research/laguna-inventory-db.md §6):
 *
 *   vedar_pms    — Ведар сам источник правды: объект → категории → фонд по
 *                  ночам → тарифы → брони живут в БД Ведара;
 *   external_pms — фонд, цены и шахматка живут во внешней PMS партнёра
 *                  (Logus, TL WebPMS, Bnovo, ...), Ведар — канал поверх неё.
 *
 * Миграция 1302 только добавляет колонки accommodations. Этот модуль —
 * единый словарь и резолвер для будущих читателей/писателей; существующие
 * запросы и поведение сайта/MCP здесь не меняются.
 *
 * NULL (все строки до 1302 и объекты, которым класс ещё не проставили при
 * онбординге) трактуется как vedar_pms: именно так система вела себя до
 * появления поля — фонд вёлся в Ведаре.
 */

export const INVENTORY_SOURCES = ['vedar_pms', 'external_pms'] as const;
export type InventorySource = (typeof INVENTORY_SOURCES)[number];

/** Вендоры внешней PMS, известные плану канала поверх PMS. Новое значение — только вместе с миграцией, расширяющей CHECK. */
export const PMS_VENDORS = [
  'logus',
  'travelline_webpms',
  'bnovo',
  'exely',
  'shelter',
  '1c_hotel',
  'other',
] as const;
export type PmsVendor = (typeof PMS_VENDORS)[number];

/** Менеджеры каналов, через которых внешняя PMS раздаёт фонд. */
export const CHANNEL_MANAGERS = ['travelline', 'bnovo', 'exely', 'other', 'none'] as const;
export type ChannelManager = (typeof CHANNEL_MANAGERS)[number];

export function isInventorySource(value: unknown): value is InventorySource {
  return typeof value === 'string' && (INVENTORY_SOURCES as readonly string[]).includes(value);
}

export function isPmsVendor(value: unknown): value is PmsVendor {
  return typeof value === 'string' && (PMS_VENDORS as readonly string[]).includes(value);
}

export function isChannelManager(value: unknown): value is ChannelManager {
  return typeof value === 'string' && (CHANNEL_MANAGERS as readonly string[]).includes(value);
}

/** Класс фонда с учётом наследия: NULL/неизвестное — vedar_pms (прежнее поведение). */
export function resolveInventorySource(value: unknown): InventorySource {
  return value === 'external_pms' ? 'external_pms' : 'vedar_pms';
}

export function isExternalInventory(value: unknown): boolean {
  return resolveInventorySource(value) === 'external_pms';
}
