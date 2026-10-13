/**
 * lib/notifications/guest-experience-copy.ts
 *
 * Текст просьбы оставить отзыв после завершённой брони (issue #1422,
 * «гостевой опыт в брони»). Шаблон, не AI: сам запрос отзыва не зависит от
 * погоды или контекста тура, как утреннее напоминание в tour-reminder —
 * шаблон надёжнее и не добавляет точку отказа AI-провайдера в путь, который
 * и так уже прошёл через оплату и завершение поездки.
 *
 * Чистая функция: тестируется без сети и без БД.
 */

import { TOUR_REVIEWS_ANCHOR } from '@/lib/tours/tour-anchors';
import { escapeHtml } from '@/lib/text/escape-html';

/**
 * Просьба об отзыве — не позже стольких дней после последнего дня тура (13.10):
 * «как прошла поездка?» про поездку многомесячной давности — шум, а не вопрос.
 */
export const REVIEW_REQUEST_MAX_AGE_DAYS = 14;

export interface ReviewRequestParams {
  touristName: string | null;
  tourTitle: string;
  tourId: number;
  appUrl: string;
}

export function buildReviewRequestMessage(params: ReviewRequestParams): string {
  const { touristName, tourId, appUrl } = params;
  // Сообщение уходит с parse_mode HTML: имя ввёл турист, название — оператор.
  // Сырой «<» или «&» там — 400 «can't parse entities», и просьба не уходит.
  const tourTitle = escapeHtml(params.tourTitle);
  const greeting = touristName?.trim() ? `${escapeHtml(touristName.trim())}, привет!` : 'Привет!';
  const link = `${appUrl}/catalog/tours/${tourId}#${TOUR_REVIEWS_ANCHOR}`;

  return [
    `<b>${greeting}</b>`,
    '',
    `Как прошла поездка «${tourTitle}»? Если найдётся пара минут — расскажите, как всё было.`,
    '',
    `Отзыв помогает другим туристам выбрать тур и оператору — понять, что стоит улучшить.`,
    '',
    `Оставить отзыв: <a href="${link}">${tourTitle}</a>`,
  ].join('\n');
}
