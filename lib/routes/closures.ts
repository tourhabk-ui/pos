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
/**
 * Ключевская Сопка (Сыщик 21.11): маршрут не закрыт приказом, но вулкан
 * извергался этим летом, и к нему советуют не подходить. Плашка — о статусе
 * вулкана, а не о запрете: факты KVERT и сводки минтуризма края, с датой.
 */
export const KLYUCHEVSKOY_NOTICE: RouteClosure = {
  title: 'Ключевская Сопка: статус вулкана',
  text:
    'По данным KVERT, последнее извержение Ключевского вулкана шло с 15 по 30 августа 2026 года; ' +
    '13.11.2026 авиационный код снижен до зелёного. По сводке Минтуризма края от 19.11.2026 туристам ' +
    'по-прежнему советуют не приближаться к вулканам Мутновский, Безымянный, Ключевской и Крашенинникова, ' +
    'а маршруты природного парка «Ключевской» закрыты на осенний период. ' +
    'Перед поездкой сверяйте активность вулкана на сайте KVERT и свежую сводку Минтуризма.',
  asOf: '21.11.2026',
  sources: [
    { label: 'KVERT, ИВиС ДВО РАН: Ключевской', url: 'http://kvert.febras.net/volc?lang=ru&name=Klyuchevskoy' },
    { label: 'Минтуризм Камчатского края, сводка 19.11.2026', url: 'https://visitkamchatka.ru/news/ezhenedelnaya-svodka-o-dostupnosti-turisticheskikh-obektov-19-11/' },
  ],
};

const BY_ROUTE: Readonly<Record<string, RouteClosure>> = {
  'vulkan-mutnovskiy-874283be': MUTNOVSKY_CLOSURE,
  'vulkan-klyuchevskaya-sopka-413a7499': KLYUCHEVSKOY_NOTICE,
};

const BY_PLACE: Readonly<Record<string, RouteClosure>> = {
  'vulkan-klyuchevskaya-sopka': KLYUCHEVSKOY_NOTICE,
};

const BY_TOUR: Readonly<Record<string, RouteClosure>> = {
  'volcanoesland-voskhozhdenie-klyuchevskaya-sopka': KLYUCHEVSKOY_NOTICE,
  'volcanoesland-treking-podnozhie-klyuchevskoy': KLYUCHEVSKOY_NOTICE,
};

/** По ключу посадочной lib/seo/query-landings. */
const BY_LANDING: Readonly<Record<string, RouteClosure>> = {
  'ru-mutnovsky': MUTNOVSKY_CLOSURE,
};

export function routeClosure(slug: string | null | undefined): RouteClosure | null {
  return slug ? BY_ROUTE[slug] ?? null : null;
}

export function placeClosure(slug: string | null | undefined): RouteClosure | null {
  return slug ? BY_PLACE[slug] ?? null : null;
}

export function tourClosure(slug: string | null | undefined): RouteClosure | null {
  return slug ? BY_TOUR[slug] ?? null : null;
}

export function landingClosure(key: string): RouteClosure | null {
  return BY_LANDING[key] ?? null;
}
