/**
 * lib/booking/stay-price.ts
 *
 * Клиентский расчёт стоимости проживания — ЗЕРКАЛО серверной логики
 * book-роута (app/api/accommodations/[id]/book): сумма цен по ночам
 * [checkIn, checkOut), цена ночи приходит из /prices?roomId=
 * (override номера > override объекта > базовая цена номера).
 * НИКАКИХ множителей на гостей и выдуманных сборов — сервер их не берёт.
 */

export interface NightPrice {
  date: string; // YYYY-MM-DD
  price: number;
  isBlocked: boolean;
}

export interface StayTotal {
  nights: number;
  total: number;
  /** Первая закрытая владельцем дата в диапазоне, если есть */
  blockedDate: string | null;
  /** Ночей, на которые не нашлось цены в прайс-карте (данные не загрузились) */
  missingNights: number;
}

/** Список ночей диапазона [checkIn, checkOut) в формате YYYY-MM-DD */
export function listNights(checkIn: string, checkOut: string): string[] {
  const nights: string[] = [];
  const start = new Date(`${checkIn}T00:00:00Z`).getTime();
  const end = new Date(`${checkOut}T00:00:00Z`).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  for (let t = start; t < end; t += dayMs) {
    nights.push(new Date(t).toISOString().slice(0, 10));
  }
  return nights;
}

export function computeStayTotal(
  prices: NightPrice[],
  checkIn: string,
  checkOut: string
): StayTotal {
  const byDate = new Map(prices.map(p => [p.date, p]));
  const nights = listNights(checkIn, checkOut);

  let total = 0;
  let blockedDate: string | null = null;
  let missingNights = 0;

  for (const night of nights) {
    const p = byDate.get(night);
    if (!p) {
      missingNights++;
      continue;
    }
    if (p.isBlocked && blockedDate === null) blockedDate = night;
    total += p.price;
  }

  return { nights: nights.length, total, blockedDate, missingNights };
}
