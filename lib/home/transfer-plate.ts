/**
 * lib/home/transfer-plate.ts — карточка трансфера в ленте туров главной
 * (решение владельца 09.10: «между турами в ленту — карточку трансфера»).
 *
 * Тур отвечает «что посмотреть», трансфер — «как туда добраться». Перевозчик
 * под заказ («Шатун», миграция 1185) жил только на /transfers и своей
 * карточке, и турист, листающий туры на главной, о нём не узнавал.
 *
 * Карточка честная тем же правилом, что прайс перевозчика: цена — за МАШИНУ,
 * а не за место (делить на число мест значило бы придумать цифру), и только
 * «от» наименьшей строки прайса. Нет цен — нет и карточки: перевозчик без
 * прайса в ленту не попадает (его и loadCharterCarriers не отдаёт).
 *
 * Модуль без базы — его читают и сервер, и клиент главной.
 * Сторож: tests/unit/home-transfer-plate.test.ts.
 */

import type { CharterCarrier } from '@/lib/transfers/charter-format';
import { describeFleet, formatRub } from '@/lib/transfers/charter-format';

export interface TransferPlate {
  kind: 'transfer';
  id: string;
  title: string;
  /** Парк одной строкой: «2 × вахтовка, 26 мест»; null — машины не записаны. */
  fleet: string | null;
  /** «от 65 000 ₽ за машину»; null — цен нет (такая карточка не строится). */
  price: string | null;
  /** Куда возит — первые направления прайса. */
  destinations: string[];
  imageUrl: string | null;
  href: string;
}

/** Сколько направлений называть на карточке — остальное на странице перевозчика. */
const DESTINATIONS_SHOWN = 3;

export function toTransferPlate(c: CharterCarrier): TransferPlate | null {
  if (c.destinations.length === 0) return null;
  const min = Math.min(...c.destinations.map((d) => d.priceRub));
  return {
    kind: 'transfer',
    id: `transfer-${c.partnerId}`,
    title: c.name,
    fleet: describeFleet(c.vehicles),
    price: Number.isFinite(min) ? `от ${formatRub(min)} за машину` : null,
    destinations: [...new Set(c.destinations.map((d) => d.to))].slice(0, DESTINATIONS_SHOWN),
    imageUrl: c.photos[0]?.url ?? null,
    href: `/operators/${c.slug}`,
  };
}

/**
 * Встать МЕЖДУ турами: после второго тура, а если туров меньше двух — после
 * первого. Без туров карточке трансфера в ленте туров не место.
 */
export function withTransferPlate<T>(tours: readonly T[], transfer: TransferPlate | null): Array<T | TransferPlate> {
  if (!transfer || tours.length === 0) return [...tours];
  const at = Math.min(2, tours.length === 1 ? 1 : 2);
  return [...tours.slice(0, at), transfer, ...tours.slice(at)];
}

export function isTransferPlate(x: unknown): x is TransferPlate {
  return typeof x === 'object' && x !== null && (x as { kind?: unknown }).kind === 'transfer';
}
