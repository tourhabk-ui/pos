/**
 * Что показывает страница перевозчика из его данных — чистые правила без
 * базы и сети (стандарт карточки трансфера 13.10, CLAUDE.md §14).
 *
 * Правило одно на все блоки: только то, что записано. Нет машин — нет фактов
 * о машинах; нет прайса — нет «от … ₽»; «что входит в цену» не записано
 * нигде — и страница говорит «уточняется у перевозчика», а не перечисляет
 * догадку (§4.0).
 */

import {
  carrierPagePath, fleetCapacity, formatRub, rateLabelOf, rateOnScreen, sortRates, vehicleKindWord,
  type CharterCarrier, type CharterRate,
} from '@/lib/transfers/charter-format';
import { absolutePhotoUrls } from '@/lib/notifications/photo-urls';

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
 * О чём говорит блок «Что входит в цену» у цены за час и за день: тема и
 * основа слова, по которой видно, что перевозчик (или миграция с его сайта)
 * эту тему уже назвал в условиях строки. Названная тема в «не записано» не
 * идёт: строка «топливо — за счёт арендатора» и рядом «входит ли топливо —
 * уточняется» спорили бы (#3487, п.27). Что именно сказано — печатаются сами
 * условия, без пересказа.
 */
const RATE_TOPICS = {
  minimum: { stem: 'минимальн', ask: 'есть ли минимальный заказ' },
  hours: { stem: 'час', ask: 'сколько часов в полном дне' },
  fuel: { stem: 'топлив', ask: 'входит ли топливо' },
  delivery: { stem: 'подач', ask: 'входит ли подача машины' },
} as const;

function mentions(conditions: string | null, stem: string): boolean {
  return !!conditions && conditions.toLowerCase().includes(stem);
}

/** Чего не записано у тарифов одного вида машины — в том порядке, что и раньше. */
function rateUnknowns(rates: readonly CharterRate[], conditions: string | null): string[] {
  const parts: string[] = [];
  if (rates.some((r) => r.unit === 'hour') && !mentions(conditions, RATE_TOPICS.minimum.stem)) parts.push(RATE_TOPICS.minimum.ask);
  if (rates.some((r) => r.unit === 'day') && !mentions(conditions, RATE_TOPICS.hours.stem)) parts.push(RATE_TOPICS.hours.ask);
  const fuel = !mentions(conditions, RATE_TOPICS.fuel.stem);
  const delivery = !mentions(conditions, RATE_TOPICS.delivery.stem);
  if (fuel && delivery) parts.push('входят ли топливо и подача машины');
  else if (fuel) parts.push(RATE_TOPICS.fuel.ask);
  else if (delivery) parts.push(RATE_TOPICS.delivery.ask);
  return parts;
}

/**
 * Условия по одной машине (или одному виду машин) для блока «Что входит в
 * цену». recorded — условия строк прайса этого вида дословно (те же, что в
 * сноске прайса), null — о том, что входит в цену, в них ничего нет;
 * unknown — темы, которых условия не называют.
 */
export interface VehicleTerms {
  /** Машина словами: названия машин этого вида из парка, иначе вид машины. */
  label: string;
  recorded: string | null;
  unknown: string[];
}

/** Говорят ли условия о том, что входит в цену: водитель, топливо, подача, часы, минимальный заказ. */
function speaksOfPrice(conditions: string): boolean {
  return ['водител', ...Object.values(RATE_TOPICS).map((t) => t.stem)].some((stem) => mentions(conditions, stem));
}

/**
 * Условия тарифов за час и за день ПО МАШИНЕ — одно правило на блок «Что
 * входит в цену» (#3487, п.26). У «Лагуна Прокат» (1318) водитель Ford
 * Transit входит в стоимость по сайту, а про «Урал» сайт этого не говорит:
 * сложить два условия в одну фразу для всего парка — значит дать одному
 * чужое. Вид машины один — одна запись без подписи. Прайс по направлениям
 * или прайса нет — пусто: там правило прежнее (includedUnknowns).
 */
export function vehicleTerms(c: Pick<CharterCarrier, 'destinations' | 'rates' | 'vehicles'>): VehicleTerms[] {
  if (c.destinations.length > 0 || c.rates.length === 0) return [];
  const kinds = [...new Set(sortRates(c.rates).map((r) => r.vehicleKind))];
  return kinds.map((kind) => {
    const rates = c.rates.filter((r) => r.vehicleKind === kind);
    const conds = [...new Set(rates.map((r) => r.conditions).filter((x): x is string => !!x && speaksOfPrice(x)))];
    const recorded = conds.length > 0 ? conds.join('; ') : null;
    const titles = c.vehicles.filter((v) => v.kind === kind).map((v) => v.title);
    const word = vehicleKindWord(kind);
    const label = titles.length > 0 ? titles.join(', ') : word.charAt(0).toUpperCase() + word.slice(1);
    return { label, recorded, unknown: rateUnknowns(rates, recorded) };
  });
}

/**
 * Что перевозчик не записал о цене — для блока «Что входит в цену». У прайса
 * по направлениям — дни, водитель и топливо; у цены за час и за день (1292) —
 * минимальный заказ, часы в полном дне, топливо и подача машины, кроме тем,
 * которые условия строк уже называют (#3487). Догадки нет.
 */
export function includedUnknowns(c: Pick<CharterCarrier, 'destinations' | 'rates'>): string {
  if (c.destinations.length > 0 || c.rates.length === 0) {
    return 'сколько дней входит в цену, есть ли водитель на месте и топливо';
  }
  const conds = [...new Set(c.rates.map((r) => r.conditions).filter((x): x is string => !!x && speaksOfPrice(x)))];
  return rateUnknowns(c.rates, conds.length > 0 ? conds.join('; ') : null).join(', ');
}

/**
 * Полоса фактов под заголовком: вид машины, места, сколько машин, откуда, за
 * что цена. Ячейка без данных не рисуется вовсе — пустая ячейка «—» читалась
 * бы как «ноль». Число мест не записано хоть у одной машины — «Мест» берётся
 * из вместимостей парка («12 или 24 в машине», 1292), а нет и их — ячейки нет;
 * «Машин» остаётся: машины записаны, их число известно.
 */
export function carrierInstrument(c: Pick<CharterCarrier, 'vehicles' | 'destinations' | 'rates' | 'seatClasses'>): InstrumentCell[] {
  const cells: InstrumentCell[] = [];
  const kinds = [...new Set(c.vehicles.map((v) => v.kind))];
  if (kinds.length === 1) {
    const w = vehicleKindWord(kinds[0]!);
    cells.push({ k: 'Машина', v: w.charAt(0).toUpperCase() + w.slice(1) });
  }
  const cap = fleetCapacity(c.vehicles);
  if (cap) cells.push({ k: 'Мест', v: cap.count > 1 ? `до ${cap.largest} в машине` : `${cap.largest}` });
  else if (c.seatClasses.length > 0) cells.push({ k: 'Мест', v: `${orWords(c.seatClasses)} в машине` });
  if (c.vehicles.length > 1) cells.push({ k: 'Машин', v: String(c.vehicles.length) });
  const origins = carrierOrigins(c);
  if (origins.length > 0) cells.push({ k: 'Откуда', v: origins.join(', ') });
  // Цена — числом, как у проката («от 7 000 ₽ в сутки»): «Цена: за день» без
  // числа ничего не говорило (разбор витрины 23.10). Самая низкая строка
  // прайса; у тарифов разной единицы (час и день) числа не сравнимы — словами.
  const min = minCharterPrice(c);
  if (min !== null) cells.push({ k: 'Цена', v: `от ${formatRub(min)} за машину` });
  else if (c.rates.length > 0) cells.push({ k: 'Цена', v: rateCellWords(c.rates) });
  return cells;
}

/** «12 или 24», «8, 12 или 24» — вместимости без привязки к машине. */
function orWords(ns: readonly number[]): string {
  return ns.length > 1 ? `${ns.slice(0, -1).join(', ')} или ${ns[ns.length - 1]}` : String(ns[0]);
}

/**
 * Цена перевозчика без направлений: у тарифов одной единицы — от самой низкой
 * («от 25 000 ₽ за день»), у часа и дня вместе — словами («за час или за
 * день»): 4 500 в час и 45 000 за день на одной шкале не сравнить.
 */
function rateCellWords(rates: CharterCarrier['rates']): string {
  const units = new Set(rates.map((r) => r.unit));
  if (units.size > 1) return 'за час или за день';
  const cheapest = rates.reduce((a, b) => (b.priceRub < a.priceRub ? b : a));
  return `от ${rateOnScreen(cheapest)}`;
}

/**
 * Разметка для поисковиков: организация-перевозчик и его предложения — строки
 * прайса с ценой за машину. Только записанное: нет прайса — нет предложений,
 * нет реквизитов — нет legalName. Срока действия и наличия машин в разметке
 * нет: система их не знает (тот же урок, что InStock у тура, снятый 01.10).
 */
export function carrierJsonLd(
  c: Pick<CharterCarrier, 'slug' | 'name' | 'shortDescription' | 'destinations' | 'rates' | 'legal' | 'logo'>,
  site: string,
): Record<string, unknown> {
  const url = `${site}${carrierPagePath(c.slug)}`;
  const offers = [
    ...c.destinations.map((d) => ({
      '@type': 'Offer',
      price: d.priceRub,
      priceCurrency: 'RUB',
      itemOffered: { '@type': 'Service', name: `Машина целиком: ${d.from} — ${d.to}` },
    })),
    // Цена за время работы — с единицей (UN/CEFACT: HUR — час, DAY — сутки),
    // иначе 4 500 читалось бы как цена поездки.
    ...c.rates.map((r) => ({
      '@type': 'Offer',
      priceCurrency: 'RUB',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: r.priceRub,
        priceCurrency: 'RUB',
        unitCode: r.unit === 'hour' ? 'HUR' : 'DAY',
      },
      itemOffered: { '@type': 'Service', name: `Машина целиком: ${rateLabelOf(r, c.rates).toLowerCase()}` },
    })),
  ];
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${url}#org`,
    name: c.name,
    url,
    ...(c.shortDescription ? { description: c.shortDescription.slice(0, 500) } : {}),
    // Логотип — полным адресом: разметка читается не только с нашего домена.
    // Из админки в logo_image ложится полный адрес хранилища — его к сайту не
    // клеят (то же правило, что у снимков тура: absolutePhotoUrls).
    ...(c.logo ? { logo: absolutePhotoUrls([c.logo], site)[0] } : {}),
    ...(c.legal?.name ? { legalName: c.legal.name } : {}),
    ...(c.legal?.inn ? { taxID: c.legal.inn } : {}),
    ...(offers.length > 0 ? { makesOffer: offers } : {}),
  };
}
