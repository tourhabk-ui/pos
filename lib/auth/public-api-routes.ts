/**
 * Реестр публичных API-маршрутов — ЕДИНЫЙ источник правды.
 *
 * Читают двое:
 *  1. `middleware.ts` — Edge-гвард: маршрута нет в реестре, значит нужен JWT.
 *  2. `lib/agents/evo/static-checks.ts` — объектив эволюции: отсутствие
 *     auth-хелпера ВНУТРИ файла опасно только там, где Edge пропускает
 *     анонима. Пока реестр жил только в middleware, объектив о нём не знал
 *     и клеймил «дырами» 37 маршрутов, закрытых на Edge (аудит 25.07).
 *
 * Ключ — префикс пути; сегментный `*` подставляет ровно один сегмент
 * (см. `isPublicApiPath`). Значение — 'ALL' либо список разрешённых методов.
 */

export type PublicApiMethods = 'ALL' | ReadonlyArray<string>;

export const PUBLIC_API_ROUTES: Record<string, PublicApiMethods> = {
  '/api/auth': 'ALL',
  '/api/admin': 'ALL',  // All admin endpoints have internal auth/CRON_SECRET checks
  '/api/weather': 'ALL',
  '/api/tours': ['GET'],
  '/api/routes': ['GET'],          // публичный каталог маршрутов + поиск
  '/api/leads': ['POST'],          // форма заявки без регистрации
  '/api/reviews': ['GET'],         // отзывы (LiveFeed на главной)
  '/api/public': 'ALL',            // публичная статистика
  '/api/discovery': ['GET', 'POST'], // поиск
  '/api/partners': ['GET'],
  '/api/eco-points': ['GET'],
  '/api/ai/chat': ['POST', 'GET'],
  '/api/ai/debug-waterfall': ['GET'],  // protected by CRON_SECRET inside handler
  '/api/ai/crew-plan': ['POST'],
  '/api/ai/health': ['GET'],
  '/api/agents/health': ['GET'],       // agent system health (lightly protected via HEALTH_SECRET)
  '/api/safety/sos': 'ALL',         // SOS distress signal — must remain public
  '/api/safety/register': ['POST'], // Route registration before hike — must remain public (safety feature)
  '/api/safety/rescue-chat': ['POST'], // AI Спасатель (requires auth inside handler)
  '/api/safety/seismic':    ['GET'],  // публичные сейсмические данные (КБГС РАН / USGS)
  '/api/safety/volcanic':   ['GET'],  // публичные вулканические алерты
  '/api/safety/weather':    ['GET'],  // публичная погода (wttr.in)
  '/api/safety/routes':     ['GET'],  // радар безопасности на главной — гость без токена получал 401
  '/api/safety/reports':    ['GET', 'POST'], // наблюдения туристов — анонимно по дизайну (rate-limit внутри)
  '/api/p':                 'ALL',   // публичные подборки туров + трекинг
  '/api/mcp': 'ALL',
  '/api/telegram': 'ALL',          // Telegram webhook
  '/api/max': 'ALL',               // MAX bot webhook
  '/api/operators': ['GET'],        // публичный каталог партнёров
  '/api/assistant': ['GET', 'POST'],  // «АI-помощник Камчатки» — история + чат
  '/api/loyalty/levels': ['GET'],   // уровни программы лояльности (публичный каталог)
  '/api/planner/recommend':      ['POST'], // AI trip recommender
  '/api/planner/partners':       ['GET'],  // операторы для дня маршрута
  '/api/planner/chat':           ['POST'], // NL → plan fill
  '/api/planner/tours-for-day':  ['GET'],  // marketplace tours per activity
  '/api/planner/validate':       ['POST'], // AI route sequence validation
  '/api/planner/companion':      ['POST'], // AI trip companion chat
  '/api/routing/path':           ['GET'],  // роутер по OSM-дорогам — гость планирует подъезд
  '/api/support/knowledge-base': ['GET'], // База знаний (публичная)
  '/api/faq': ['GET'],              // FAQ (публичная)
  '/api/photos': ['GET'],            // загруженные фото из /tmp (Timeweb production)
  '/api/analytics/hit': ['POST'],    // трекинг просмотров страниц (без авторизации)
  '/api/payments/webhook': ['POST'],                    // CloudPayments webhook — HMAC validated inside
  '/api/payments/tochka/webhook': ['POST'],             // СБП-вебхук Точки — факт оплаты подтверждается обратным запросом в банк
  '/api/hub/operator/payments/webhook': ['POST'],       // CloudPayments webhook for operator tours — HMAC validated inside
  '/api/cron': ['GET', 'POST'],      // cron jobs — дополнительная защита через CRON_SECRET внутри
  '/api/octo': 'ALL',               // OCTO API — авторизация через Bearer token внутри
  '/api/hub/marketplace/tours': ['GET'], // публичный каталог туров маршрутплейса
  '/api/hub/bookings': ['GET'],           // booking-success страница (без персональных данных, ФЗ-152 ок)
  '/api/places': ['GET'],                 // карточка точки/локации (публичная)
  '/api/places/*/safety-report': ['GET', 'POST'], // UGC safety report (анонимный POST)
  '/api/trips/share': ['GET'],            // публичный просмотр маршрута по share_token
  '/api/collections': ['GET'],            // публичные подборки мест и маршрутов
  '/api/trending': ['GET'],               // популярные места и маршруты
  '/api/channels/avito/feed':  ['GET'], // Avito Autoload XML feed — публичный
  '/api/widget': ['POST', 'GET', 'OPTIONS'],    // Partner widget API — CORS-enabled
  '/api/health': ['GET'],              // health checks — monitoring/infra
  '/api/agent-market': ['GET'],        // HTTP 402 платный API для внешних AI-агентов
};

/**
 * Сверка пути с записью реестра. Поддержан сегментный `*` — без него
 * объявленное правило молча не работает: запись safety-report со звёздочкой
 * вместо id места сравнивалась буквально и не совпадала ни с чем, а анонимный
 * POST наблюдения о месте (заявленный публичным) получал 401 на Edge.
 */
export function isPathMatch(pathname: string, route: string): boolean {
  if (!route.includes('*')) {
    return pathname === route || pathname.startsWith(`${route}/`);
  }
  const routeSegments = route.split('/');
  const pathSegments = pathname.split('/');
  if (pathSegments.length < routeSegments.length) return false;
  return routeSegments.every((seg, i) => seg === '*' || seg === pathSegments[i]);
}

/** Пропускает ли Edge анонима на этот путь с этим методом. */
export function isPublicApiPath(pathname: string, method: string): boolean {
  if (!pathname.startsWith('/api')) return false;
  const normalizedMethod = method.toUpperCase();
  return Object.entries(PUBLIC_API_ROUTES).some(([route, allowedMethods]) => {
    if (!isPathMatch(pathname, route)) return false;
    if (allowedMethods === 'ALL') return true;
    return allowedMethods.includes(normalizedMethod);
  });
}
