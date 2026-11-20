/**
 * Закрытые маршруты (Сыщик 21.11, сверено по первоисточникам): плашка на
 * карточке маршрута и на посадочной туров. Источник и дата — рядом с текстом:
 * человек видит, на что опирается запрет, и может проверить сам.
 */
export interface RouteClosure {
  title: string;
  text: string;
  /** На какую дату проверено (ДД.ММ.ГГГГ). */
  asOf: string;
  sources: ReadonlyArray<{ label: string; url: string }>;
}

export const MUTNOVSKY_CLOSURE: RouteClosure = {
  title: 'Маршрут на Мутновский закрыт',
  text:
    'Спускаться в кратер Мутновского запрещено: знаки о запрете стоят на маршруте с 2022 года. ' +
    '11.08.2026 сеть природных парков открыла летние маршруты Южно-Камчатского парка — все, ' +
    'кроме вулкана Мутновский. 12.11.2026 туристам советовали не приближаться к вулкану: в его ' +
    'районе высокая сейсмическая активность, возможны оползни и обвалы.',
  asOf: '21.11.2026',
  sources: [
    { label: 'Кам 24, 28.07.2022', url: 'https://kam24.ru/news/main/20220728/90732.html' },
    {
      label: 'Природный парк «Вулканы Камчатки», 11.08.2026',
      url: 'https://www.vulcanikamchatki.ru/novosti/otkrytie_letnih_marshrutov_v_prirodnyh_parkah_vilyuchinskij_i_yuzhnokamchatskij/',
    },
    { label: 'Кам 24, 12.11.2026', url: 'https://kam24.ru/news/main/20261112/134130.html' },
  ],
};

/** По slug маршрута. */
const BY_ROUTE: Readonly<Record<string, RouteClosure>> = {
  'vulkan-mutnovskiy-874283be': MUTNOVSKY_CLOSURE,
};

/** По ключу посадочной lib/seo/query-landings. */
const BY_LANDING: Readonly<Record<string, RouteClosure>> = {
  'ru-mutnovsky': MUTNOVSKY_CLOSURE,
};

export function routeClosure(slug: string | null | undefined): RouteClosure | null {
  return slug ? BY_ROUTE[slug] ?? null : null;
}

export function landingClosure(key: string): RouteClosure | null {
  return BY_LANDING[key] ?? null;
}
