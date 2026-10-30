/**
 * Даты своего тура гида — одна функция для раздела «Свои туры» на сайте
 * (`POST /api/guide/own/dates`) и для кнопок «Мои туры» → «Даты» в чате
 * кабинета (lib/guides/tour-edit, 30.10). Правила — общие `openTourDates`
 * (lib/tours/availability-open): места не ниже уже записанных, прошедшие и
 * дальше горизонта не открываются, вне сезона тура — тоже, закрытая дата
 * открывается снова. Цену на дату гид не ставит: цена тура одна, из карточки.
 *
 * Закрыть дату — общее `closeTourDates` (lib/tours/availability-close), то
 * же, что у календаря оператора: брони на эту дату это не отменяет.
 */
import { openTourDates, type OpenDatesResult } from '@/lib/tours/availability-open';
import { closeTourDates, type CloseDatesResult } from '@/lib/tours/availability-close';
import { pool } from '@/lib/db-pool';

export async function openGuideTourDates(input: {
  /** `partners.id` карточки гида — владелец тура. */
  partnerId: string;
  tourId: string;
  dates: string[];
  slots: number;
  /** Сегодня по Камчатке. */
  today: string;
}): Promise<OpenDatesResult> {
  return openTourDates({
    operatorId: input.partnerId,
    tourId: input.tourId,
    rows: input.dates.map((date) => ({ date, slots: input.slots, price: null })),
    mayPrice: false,
    inactiveTour: 'refuse',
    skipExisting: false,
    closedDates: 'reopen',
    // Прошедшие и дальше горизонта не открываются, вне сезона тура — тоже:
    // заявку вне сезона форма туриста всё равно не примет.
    today: input.today,
    enforceSeason: true,
  });
}

/** Причина закрытия, которую видит календарь: кто закрыл. */
export const GUIDE_CLOSE_REASON = 'Закрыто гидом';

export async function closeGuideTourDates(input: {
  partnerId: string;
  tourId: string;
  dates: string[];
}): Promise<CloseDatesResult> {
  return closeTourDates(pool, { operatorId: input.partnerId, tourId: input.tourId, dates: input.dates, reason: GUIDE_CLOSE_REASON });
}
