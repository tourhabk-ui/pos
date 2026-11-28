/**
 * Постоянный текст под табло /flights (Сыщик 28.11, GSC 18–24.11: «табло
 * елизово» и ещё 15 запросов — 121 показ на позициях 8,8–10,2, страница
 * 245 показов, 0 кликов). Когда табло пусто или не прочиталось, на странице
 * почти не было слов; этот блок виден всегда и стоит НИЖЕ табло, погоды и
 * источника — табло не сдвигает.
 *
 * Факты — из открытых источников ниже, своими словами; расписания, цен и
 * времени в пути здесь нет. Разметка Airport повторяет видимый текст.
 */
export const FLIGHTS_ABOUT_TITLE = 'Про аэропорт и табло';

export const FLIGHTS_AIRPORT_NAME = 'Аэропорт Елизово (Петропавловск-Камчатский)';
export const FLIGHTS_AIRPORT_IATA = 'PKC';
export const FLIGHTS_AIRPORT_ICAO = 'UHPP';
export const FLIGHTS_AIRPORT_KM_TO_CITY = 29;

export const FLIGHTS_ABOUT_SOURCES: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Википедия, «Елизово (аэропорт)»', href: 'https://ru.wikipedia.org/wiki/%D0%95%D0%BB%D0%B8%D0%B7%D0%BE%D0%B2%D0%BE_(%D0%B0%D1%8D%D1%80%D0%BE%D0%BF%D0%BE%D1%80%D1%82)' },
  { label: 'Паспорт региона «Камчатский край» (Минтранс края)', href: 'https://rlw.gov.ru/storage/document/document_file/2026-01/28/kamcatskij-kraj.pdf' },
  { label: 'Официальный сайт аэропорта', href: 'https://pkc.aero/' },
];

/** Schema.org Airport: только то, что напечатано в видимом блоке. */
export function flightsAirportJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Airport',
    name: FLIGHTS_AIRPORT_NAME,
    iataCode: FLIGHTS_AIRPORT_IATA,
    icaoCode: FLIGHTS_AIRPORT_ICAO,
    url: 'https://pkc.aero/',
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Елизово',
      addressRegion: 'Камчатский край',
      addressCountry: 'RU',
    },
  };
}
