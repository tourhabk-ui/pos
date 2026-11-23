/**
 * Прямой ответ в начале /routes: какие вулканы выбрать для первой поездки.
 * Факты те же, что на /voshozhdeniya-na-vulkany-kamchatki; новый адрес не
 * заводим. Высоты — KVERT. «Лучшие» не пишем: это не рейтинг.
 */

export const ROUTES_VOLCANO_LEAD =
  'Для первой поездки обычно выбирают Авачинский вулкан (2751 м по KVERT) или Горелый (1828 м): оба близко к Петропавловску-Камчатскому. Летний сезон восхождений — июль–сентябрь. К Мутновскому, по сводке минтуризма на 12 ноября 2026 года, подходить не рекомендуют.';

export const ROUTES_VOLCANO_MORE = {
  href: '/voshozhdeniya-na-vulkany-kamchatki',
  label: 'Подробнее о восхождениях',
} as const;

export const ROUTES_VOLCANO_SOURCES = [
  {
    label: 'KVERT, ИВиС ДВО РАН, «Авачинский»',
    href: 'http://kvert.febras.net/volc?lang=ru&name=Avachinsky',
  },
  {
    label: 'KVERT, ИВиС ДВО РАН, «Горелый»',
    href: 'http://kvert.febras.net/volc?lang=ru&name=Gorely',
  },
  {
    label: 'Visit Kamchatka, «Восхождения»',
    href: 'https://visitkamchatka.ru/activities/voskhozhdeniya/',
  },
  {
    label: 'ИА «Кам 24», сводка ограничений для туристов (12.11.2026)',
    href: 'https://kam24.ru/news/main/20261112/134130.html',
  },
] as const;
