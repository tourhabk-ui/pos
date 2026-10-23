/**
 * Что показывает страница прокатчика из его данных — чистые правила без базы
 * и сети (витрина проката 23.10, по образцу страницы перевозчика §14).
 *
 * Правило одно на все блоки: только то, что записано. Нет машин — нет фактов
 * о машинах; залог не записан — нет «залог от»; что входит в цену не записано
 * нигде — страница говорит «уточняется у прокатчика» (§4.0).
 */

import { formatRub, type CharterLegal } from '@/lib/transfers/charter-format';
import {
  bodyKindWord, driverWord, minRentalDeposit, minRentalPrice, rentalPagePath, type RentalCompany, type RentalOffer,
} from '@/lib/rental/rental-format';

export interface InstrumentCell {
  k: string;
  v: string;
}

/**
 * Полоса фактов под заголовком: сколько машин, цена от, залог от. Ячейка без
 * данных не рисуется вовсе — пустая ячейка «—» читалась бы как «ноль». Цена
 * «от» — самая низкая строка прайса, и если хоть у одной строки прокатчик сам
 * написал «от», слово остаётся: точную назовёт он.
 */
export function rentalInstrument(c: Pick<RentalCompany, 'offers'>): InstrumentCell[] {
  const cells: InstrumentCell[] = [];
  if (c.offers.length > 0) cells.push({ k: 'Машин', v: String(c.offers.length) });
  const kinds = [...new Set(c.offers.map((o) => o.bodyKind))];
  if (kinds.length === 1) {
    const w = bodyKindWord(kinds[0]!);
    cells.push({ k: 'Кузов', v: w.charAt(0).toUpperCase() + w.slice(1) });
  }
  const min = minRentalPrice(c);
  if (min !== null) cells.push({ k: 'Цена', v: `от ${formatRub(min)} в сутки` });
  const deposit = minRentalDeposit(c);
  if (deposit !== null) cells.push({ k: 'Залог', v: `от ${formatRub(deposit)}` });
  if (c.offers.length > 0) {
    const drivers = new Set(c.offers.map((o) => o.driver));
    cells.push({ k: 'Водитель', v: drivers.size === 1 && drivers.has('self') ? 'без водителя' : 'без водителя или по желанию' });
  }
  return cells;
}

/** Предложение для разметки: машина за сутки, цена «от» — через minPrice. */
function offerJsonLd(o: RentalOffer): Record<string, unknown> {
  return {
    '@type': 'Offer',
    priceCurrency: 'RUB',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      ...(o.priceIsFrom ? { minPrice: o.priceRubPerDay } : { price: o.priceRubPerDay }),
      priceCurrency: 'RUB',
      // UN/CEFACT: DAY — сутки. Без единицы 7 000 читалось бы как цена аренды целиком.
      unitCode: 'DAY',
    },
    itemOffered: { '@type': 'Product', name: `${o.title} — аренда без водителя`, description: driverWord(o.driver) },
  };
}

/**
 * Разметка для поисковиков: прокат автомобилей (AutoRental) и его предложения
 * — строки прайса с ценой за сутки. Только записанное: нет реквизитов — нет
 * legalName; наличия машин и срока действия в разметке нет — система их не
 * знает (тот же урок, что InStock у тура, снятый 01.10).
 */
export function rentalJsonLd(
  c: Pick<RentalCompany, 'slug' | 'name' | 'shortDescription' | 'offers' | 'logo'> & { legal: CharterLegal | null },
  site: string,
): Record<string, unknown> {
  const url = `${site}${rentalPagePath(c.slug)}`;
  const offers = c.offers.map(offerJsonLd);
  return {
    '@context': 'https://schema.org',
    '@type': 'AutoRental',
    '@id': `${url}#org`,
    name: c.name,
    url,
    ...(c.shortDescription ? { description: c.shortDescription.slice(0, 500) } : {}),
    // Логотип — полным адресом: разметка читается не только с нашего домена.
    ...(c.logo ? { logo: `${site}${c.logo}` } : {}),
    ...(c.legal?.name ? { legalName: c.legal.name } : {}),
    ...(c.legal?.inn ? { taxID: c.legal.inn } : {}),
    ...(offers.length > 0 ? { makesOffer: offers } : {}),
  };
}
