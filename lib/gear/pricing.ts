/**
 * Единый расчёт цены аренды снаряжения — сервер и форма считают ОДНОЙ функцией.
 *
 * До этого модуля было три несовпадающих расчёта:
 *   - форма: days>=7 → только недельный тариф (10 дней = цена недели),
 *     страховка — выдуманные 10%;
 *   - POST /api/gear/rentals: честные недели+дни, страховка жёстко 0
 *     (при сохранённом флаге insurance=true);
 *   - calculateRentalCost в хелперах: месяцы+недели+дни — и ни одного вызова.
 * Турист видел одну сумму, в заявку записывалась другая, а «страховка»
 * была галкой без денег. На платформе с принципом «не врать цифрами» это
 * недопустимо. Модуль чистый и изоморфный: импортируется и роутом, и клиентом.
 */

export interface GearPriceInput {
  days: number;
  quantity: number;
  pricePerDay: number;
  pricePerWeek?: number | null;
  pricePerMonth?: number | null;
  /** Стоимость страховки за день за единицу; нет тарифа — страховка недоступна. */
  insurancePerDay?: number | null;
  insurance?: boolean;
}

export interface GearPriceBreakdown {
  months: number;
  weeks: number;
  days: number;
}

export interface GearPrice {
  basePrice: number;
  insuranceCost: number;
  totalPrice: number;
  breakdown: GearPriceBreakdown;
  /** Страховка запрошена, но у позиции нет тарифа — галка невыполнима. */
  insuranceUnavailable: boolean;
}

/**
 * Дни аренды по датам ISO (YYYY-MM-DD). null — некорректный ввод
 * (нечитаемые даты или конец не позже начала). Ноль дней не бывает:
 * минимальная аренда — сутки.
 */
export function calcRentalDays(startDate: string, endDate: string): number | null {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const days = Math.ceil((end - start) / 86_400_000);
  return days >= 1 ? days : null;
}

/** Тариф пригоден, если это конечное положительное число. */
function usable(rate: number | null | undefined): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
}

/**
 * Декомпозиция месяцы → недели → дни по доступным тарифам (как в прокатах:
 * длинный срок дешевле, но остаток всегда добивается посуточно, а не
 * округляется в пользу кассы).
 */
export function calcGearPrice(input: GearPriceInput): GearPrice {
  const { days, quantity } = input;
  const monthly = usable(input.pricePerMonth) ? input.pricePerMonth : null;
  const weekly = usable(input.pricePerWeek) ? input.pricePerWeek : null;
  const insuranceRate = usable(input.insurancePerDay) ? input.insurancePerDay : null;

  let remaining = days;
  const months = monthly ? Math.floor(remaining / 30) : 0;
  remaining -= months * 30;
  const weeks = weekly ? Math.floor(remaining / 7) : 0;
  remaining -= weeks * 7;

  const perUnit =
    months * (monthly ?? 0) + weeks * (weekly ?? 0) + remaining * input.pricePerDay;
  const basePrice = Math.round(perUnit * quantity * 100) / 100;

  const wantsInsurance = Boolean(input.insurance);
  const insuranceCost = wantsInsurance && insuranceRate
    ? Math.round(insuranceRate * days * quantity * 100) / 100
    : 0;

  return {
    basePrice,
    insuranceCost,
    totalPrice: Math.round((basePrice + insuranceCost) * 100) / 100,
    breakdown: { months, weeks, days: remaining },
    insuranceUnavailable: wantsInsurance && !insuranceRate,
  };
}
