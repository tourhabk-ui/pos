/**
 * Что показывает страница перевозчика из его данных — чистые правила без
 * базы и сети (стандарт карточки трансфера 13.10, CLAUDE.md §14).
 *
 * Правило одно на все блоки: только то, что записано. Нет машин — нет фактов
 * о машинах; нет прайса — нет «от … ₽»; «что входит в цену» не записано
 * нигде — и страница говорит «уточняется у перевозчика», а не перечисляет
 * догадку (§4.0).
 */

import { carrierPagePath, fleetCapacity, vehicleKindWord, type CharterCarrier } from '@/lib/transfers/charter-format';

export interface InstrumentCell {
  k: string;
  v: string;
}

/** Откуда отправление: пункты из прайса без повторов; пусто — не записано. */
export function carrierOrigins(c: Pick<CharterCarrier, 'destinations'>): string[] {
  return [...new Set(c.destinations.map((d) => d.from))];
}

/** Самая низкая цена прайса за машину; null — прайса нет. */
export function minCharterPrice(c: Pick<CharterCarrier, 'destinations'>): number | null {
  return c.destinations.length > 0 ? Math.min(...c.destinations.map((d) => d.priceRub)) : null;
}

/**
 * Полоса фактов под заголовком: вид машины, места, сколько машин, откуда, за
 * что цена. Ячейка без данных не рисуется вовсе — пустая ячейка «—» читалась
 * бы как «ноль».
 */
export function carrierInstrument(c: Pick<CharterCarrier, 'vehicles' | 'destinations'>): InstrumentCell[] {
  const cells: InstrumentCell[] = [];
  const kinds = [...new Set(c.vehicles.map((v) => v.kind))];
  if (kinds.length === 1) {
    const w = vehicleKindWord(kinds[0]!);
    cells.push({ k: 'Машина', v: w.charAt(0).toUpperCase() + w.slice(1) });
  }
  const cap = fleetCapacity(c.vehicles);
  if (cap) {
    cells.push({ k: 'Мест', v: cap.count > 1 ? `до ${cap.largest} в машине` : `${cap.largest}` });
    if (cap.count > 1) cells.push({ k: 'Машин', v: String(cap.count) });
  }
  const origins = carrierOrigins(c);
  if (origins.length > 0) cells.push({ k: 'Откуда', v: origins.join(', ') });
  if (c.destinations.length > 0) cells.push({ k: 'Цена', v: 'за машину' });
  return cells;
}

/**
 * Разметка для поисковиков: организация-перевозчик и его предложения — строки
 * прайса с ценой за машину. Только записанное: нет прайса — нет предложений,
 * нет реквизитов — нет legalName. Срока действия и наличия машин в разметке
 * нет: система их не знает (тот же урок, что InStock у тура, снятый 01.10).
 */
export function carrierJsonLd(
  c: Pick<CharterCarrier, 'slug' | 'name' | 'shortDescription' | 'destinations' | 'legal'>,
  site: string,
): Record<string, unknown> {
  const url = `${site}${carrierPagePath(c.slug)}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${url}#org`,
    name: c.name,
    url,
    ...(c.shortDescription ? { description: c.shortDescription.slice(0, 500) } : {}),
    ...(c.legal?.name ? { legalName: c.legal.name } : {}),
    ...(c.legal?.inn ? { taxID: c.legal.inn } : {}),
    ...(c.destinations.length > 0
      ? {
        makesOffer: c.destinations.map((d) => ({
          '@type': 'Offer',
          price: d.priceRub,
          priceCurrency: 'RUB',
          itemOffered: { '@type': 'Service', name: `Машина целиком: ${d.from} — ${d.to}` },
        })),
      }
      : {}),
  };
}
