/**
 * lib/planner/day-tour-link.ts
 *
 * Ссылка «оставить заявку» из дня плана на форму тура.
 *
 * Путь человека 07.11: план на двоих, день 11 июля. Ссылка вела на голую
 * карточку тура, и форма заявки открывалась с одним участником и пустой
 * датой. Форма умеет принимать `?date=…&guests=…#booking` (предзаполнение,
 * lib/booking/request-prefill), но план этих параметров не передавал.
 */

import { tourRequestHref } from '@/lib/booking/request-prefill';
import { tourPath, type TourRef } from '@/lib/tours/tour-url';

/** Дата дня плана: прилёт + номер дня (0 — день прилёта). Прилёт не задан — пусто. */
export function planDayDate(arrival: string, idx: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival) || !Number.isInteger(idx) || idx < 0) return '';
  const d = new Date(`${arrival}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + idx);
  return d.toISOString().slice(0, 10);
}

/** Форма тура с датой этого дня и всей группой; чего не знаем — не подставляем. */
export function planDayTourHref(tour: TourRef, arrival: string, idx: number, groupSize: number): string {
  const date = planDayDate(arrival, idx);
  return tourRequestHref(tourPath(tour), {
    date: date || undefined,
    guests: Number.isInteger(groupSize) && groupSize >= 1 ? groupSize : undefined,
  });
}
