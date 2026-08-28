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

export interface ReviewRequestParams {
  touristName: string | null;
  tourTitle: string;
  tourId: number;
  appUrl: string;
}

export function buildReviewRequestMessage(params: ReviewRequestParams): string {
  const { touristName, tourTitle, tourId, appUrl } = params;
  const greeting = touristName?.trim() ? `${touristName.trim()}, привет!` : 'Привет!';
  const link = `${appUrl}/marketplace/tours/${tourId}#reviews`;

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
