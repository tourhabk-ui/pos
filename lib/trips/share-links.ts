/**
 * Ссылки «поделиться планом» в мессенджерах — одна сборка на все экраны.
 *
 * До 14.11 (#3347) кнопка «MAX» в панели «Поделиться» планера и страницы
 * поездки открывала чат Кузьмича: ссылка на маршрут в неё не попадала, а
 * кнопка стояла рядом с настоящим «Telegram». Страница сохранённой поездки
 * (components/trips/TripActions) при этом делилась в MAX по-настоящему.
 * Теперь адрес один на три экрана.
 */

/** Окно «переслать» Telegram: ссылка и подпись к ней. */
export function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

/** Окно «переслать» MAX: у него одно поле текста — подпись и ссылка строкой ниже. */
export function maxShareUrl(url: string, text: string): string {
  return `https://max.ru/:share?text=${encodeURIComponent(`${text}\n${url}`)}`;
}
