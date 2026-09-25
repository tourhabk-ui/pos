/**
 * lib/home/device-tree.ts
 *
 * Какое дерево главной отдать по User-Agent: мобильное (v8) или десктопное.
 *
 * Сервер рендерит ОДНО дерево (app/page.tsx): телефону — v8, десктопу и
 * краулерам — десктопное, потому что боты индексируют его SEO-богатую
 * разметку. Неоднозначный UA — десктоп (безопасный дефолт).
 *
 * Аудит 24.09 (#43): маркеры ботов были голыми подстроками — `telegram`,
 * `whatsapp`, `yandex`. Встроенный браузер Telegram на Android пишет о себе
 * «… Mobile Safari/537.36 Telegram-Android/11.1.3 (…)», и живой человек со
 * ссылкой из чата получал десктопную главную без лид-формы и с футером на
 * 2000 пикселей. То же с приложением Яндекса («YandexSearch/…») — это люди.
 * Теперь маркеры называют КРАУЛЕРЫ, а не приложения:
 *   - `telegrambot` — превью ссылок Telegram («TelegramBot (like TwitterBot)»);
 *   - `yandexbot`, `yandexmobilebot` и служебные роботы Яндекса по именам;
 *   - краулер WhatsApp — UA целиком вида «WhatsApp/2.23.20.0 A» (приложение
 *     не открывает ссылки своим движком, так что «WhatsApp/» в начале строки —
 *     это превью, а не человек).
 * Общий маркер `bot` сохранён намеренно: он ловит всех, кто честно называет
 * себя ботом (Googlebot, YandexBot, TelegramBot, bingbot…), и ботам по-прежнему
 * уходит десктопное дерево.
 *
 * Счётчик посещаемости (lib/analytics/bot-detect) решает другой вопрос — «не
 * считать ли просмотр» — и потому шире (headless, curl): здесь его не берём,
 * ошибочно помеченный человек на главной получает не тот сайт.
 *
 * Сторож: tests/unit/home-device-tree.test.ts.
 */

const BOT_RE = new RegExp(
  [
    'bot', 'crawler', 'spider', 'slurp',
    'googlebot', 'bingbot', 'duckduckbot', 'baiduspider', 'petalbot', 'applebot', 'twitterbot',
    'facebookexternalhit',
    'telegrambot',
    'yandexbot', 'yandexmobilebot',
    // Служебные роботы Яндекса, в имени которых нет «bot».
    'yandex(?:images|metrika|direct|webmaster|media|news|video|favicons|pagechecker|turbo|blogs|market|catalog|sitelinks|fordomain|imageresizer|partner|verticals|additional|userproxy|zenrss)',
    // Превью ссылок WhatsApp: весь UA — «WhatsApp/2.23.20.0 A» (или i/W).
    '^whatsapp/[\\d.]+(?:\\s+[a-z])?\\s*$',
  ].join('|'),
  'i',
);

const PHONE_RE = /android|iphone|ipod|opera mini|iemobile|blackberry|webos|mobile safari/i;
const TABLET_RE = /ipad|tablet/i;

export function isCrawlerUA(ua: string): boolean {
  return BOT_RE.test(ua.trim());
}

export function isPhoneUA(ua: string): boolean {
  return PHONE_RE.test(ua) && !TABLET_RE.test(ua);
}

export type HomeTree = 'mobile' | 'desktop';

/** Телефон, который не назвался краулером, — мобильное дерево; всё прочее — десктоп. */
export function homeTreeFor(ua: string | null | undefined): HomeTree {
  const s = ua ?? '';
  return isPhoneUA(s) && !isCrawlerUA(s) ? 'mobile' : 'desktop';
}
