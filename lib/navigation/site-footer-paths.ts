/**
 * Где корневой layout рисует общий подвал (components/layout/Footer).
 *
 * 21.11 (Сыщик): у карточек мест, посадочных, /prepare, /routes, /park, /fish
 * подвала в HTML не было вовсе — его ставили по одной странице. Теперь подвал
 * в корневом layout и уходит в серверный HTML; здесь — только исключения.
 */

/** Страницы, которые ставят <Footer /> сами (свой порядок блоков или вариант
 *  для телефона): общий подвал на них не дублируется. Сторож
 *  site-footer-ssr сверяет список с импортами Footer в app/. */
export const OWN_FOOTER_PATHS = [
  '/',        // главная: подвал внутри своей сетки
  '/catalog', // CatalogFooter: на телефоне — строка реквизитов вместо меню
  '/catalog/tours/[id]', // карточка тура: подвал только на md+, на телефоне — панель брони
  '/planner', // экран входа планера — с подвалом в серверном HTML; сам планер — полноэкранный, без подвала (22.11)
] as const;

/** Маршрут Next ('/blog/[slug]') — проверка пути ('/blog/x'). */
function routeMatches(route: string, p: string): boolean {
  const re = new RegExp('^' + route.split('/').map((s) => (/^\[.+\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|\\]/g, '\\$&'))).join('/') + '$');
  return re.test(p);
}

/** Разделы-приложения: карта, кабинеты, чат, SOS, офлайн, виджеты. Подвал
 *  с меню сайта им мешает (полноэкранная вёрстка) и поиску не нужен. */
export const NO_FOOTER_PREFIXES = [
  // /ai-assistant — тоже чат Кузьмича: в чатах подвалов нет (владелец 28.11).
  '/map', '/auth', '/oauth', '/admin', '/profile', '/kuzmich', '/ai-assistant', '/sos', '/offline',
  '/widget', '/p/', '/r/', '/trip', '/field-check', '/watch', '/team',
  '/checkin-ok', '/partner-site', '/en', '/zh', '/video', '/menu',
  '/booking-success', '/confirm', '/request-status', '/request-resume', '/return',
  '/seat-request', '/tp-verify', '/wishlist',
] as const;

/** Разделы /hub — кабинеты, кроме публичной посадочной «Рыбалка». */
const HUB_PUBLIC = ['/hub/fishing'];

export function showSiteFooter(pathname: string | null | undefined): boolean {
  const p = (pathname || '/').replace(/\/+$/, '') || '/';
  if (OWN_FOOTER_PATHS.some((r) => routeMatches(r, p))) return false;
  if (p === '/hub' || p.startsWith('/hub/')) return HUB_PUBLIC.some((h) => p === h || p.startsWith(`${h}/`));
  return !NO_FOOTER_PREFIXES.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x || p.startsWith(`${x}/`)));
}
