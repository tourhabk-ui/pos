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

export const ROUTES_VOLCANO_SOURCES: readonly { label: string; href?: string }[] = [
  {
    label: 'KVERT, ИВиС ДВО РАН, «Авачинский»',
  },
  {
    label: 'KVERT, ИВиС ДВО РАН, «Горелый»',
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
