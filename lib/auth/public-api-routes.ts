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
  // '/api/admin' здесь НЕТ с 01.09 (периметр, часть 2; слово владельца по §7).
  // Пока префикс стоял тут как 'ALL' «с проверкой внутри», правило
  // '/api/admin': 'admin' в middleware не достигалось никогда: аноним уходил
  // на публичном пропуске раньше RBAC, и дверью были 155 хендлеров по
  // отдельности. Теперь Edge пускает на /api/admin/* только admin-JWT либо
  // CRON_SECRET в заголовке Authorization: Bearer (так зовут workflow).
  // Сторож: tests/unit/edge-admin-gate.test.ts.
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
  // Меш и QR-эстафета SOS — анонимные by design: попутчик, доставляющий
  // чужой сигнал, аккаунта может не иметь, а пострадавший — не быть
  // залогиненным. До 28.08 префикса тут не было ВООБЩЕ: Edge отдавал 401
  // на SSE-сигналинг и ретрансляцию всем гостям — меш для анонимов был
  // мёртв молча. Внутри роутов rate-limit и дедуп по sos_id.
  '/api/mesh': ['GET', 'POST'],
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
  '/api/funnel': ['POST'],           // маяк воронки — публичный by design (rate-limit + bot-detect внутри); Edge молча резал его 401, и funnel_events был пуст для всех гостей (сквозной прогон 14.08)
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
  // Брифинг похода: контакт вне маршрута читает план и время возврата по
  // ссылке, не заводя аккаунт. POST создаёт ссылку анонимно (подготовка не
  // требует регистрации) — внутри Zod и rate-limit. Координат и контактных
  // ПД в снимке нет по устройству схемы (миграция 870).
  '/api/preparation/share': ['GET', 'POST'],
  '/api/collections': ['GET'],            // публичные подборки мест и маршрутов
  '/api/trending': ['GET'],               // популярные места и маршруты
  '/api/channels/avito/feed':  ['GET'], // Avito Autoload XML feed — публичный
  '/api/widget': ['POST', 'GET', 'OPTIONS'],    // Partner widget API — CORS-enabled
  '/api/health': ['GET'],              // health checks — monitoring/infra
  '/api/agent-market': ['GET'],        // HTTP 402 платный API для внешних AI-агентов
  // Полевая проверка маршрутов (владелец 21.08). Форма по устройству
  // анонимная: человек в поле стоит без аккаунта, в перчатке и на одной
  // палке связи — регистрация тут отняла бы саму возможность сверки.
  // Внутри роутов Zod, лимит размера фото и потолок заметки; запись
  // ложится в очередь со статусом pending и сама ничего не меняет.
  // Реестр забыли при выкладке — Edge отдавал 401 на всё, и форма была
  // мертва молча (проба 136): страница открывалась, данные не приходили.
  '/api/field-check': ['GET', 'POST'],
  // ── Витрина для гостя (перепись 22.08) ──────────────────────────────────
  // Перепись клиентских fetch показала: 75 вызовов с публичных страниц Edge
  // резал молча. Гость без куки видел мёртвыми поиск, каталоги, календарь,
  // предупреждения безопасности — а залогиненный владелец не видел этого
  // никогда. Ниже открыто только проверенное по хендлеру: читалки каталогов
  // без ПД, анонимные маяки с Zod и rate-limit, и потоки, где гость — часть
  // замысла (гостевая бронь, оплата по QR). Персональное (trips, wishlist,
  // push-подписки) осталось за входом — там чинится клиент, не реестр.
  // Сторож: tests/unit/public-fetch-edge.test.ts (список может только
  // сокращаться).
  '/api/search': ['GET'],               // глобальный поиск — каталог, без ПД
  '/api/live-feed': ['GET'],            // лента главной
  '/api/home/metrics': ['GET'],         // счётчики главной
  '/api/parks': ['GET'],                // природные парки + [slug]
  '/api/gear': ['GET'],                 // каталог снаряжения
  '/api/accommodations': ['GET'],       // жильё: каталог, карточка, цены
  '/api/availability': ['GET'],         // календарь занятости туров
  '/api/transfers/search': ['GET'],     // поиск трансферов; ПД водителя вырезаны из ответа
  // Витрина мест в поездках перевозчиков (схема 926, 02.09): гость смотрит,
  // что едет и сколько мест. Запрос мест (POST …/[id]/request) остаётся за
  // входом — схема требует заказчика. Новый путь, не адрес мёртвого модуля.
  '/api/carrier-trips': ['GET'],
  '/api/tools': ['GET', 'POST'],        // каталог AI-инструментов; POST — счётчик кликов;
                                        // equipment/safety зовут AI — на них rate-limit внутри
  '/api/safety/warnings': ['GET'],      // предупреждения: официальные телефоны, не ПД
  '/api/safety/geofence-zones': ['GET'],// геозоны безопасности
  '/api/safety/return': ['GET', 'POST'],// отметка о возвращении — проверка внутри хендлера
  '/api/safety/checkin': ['POST'],      // «я в порядке» — анонимно, как safety/reports (issue #1420)
  '/api/analytics/dwell': ['POST'],     // маяк времени на странице (Zod + rate-limit)
  '/api/analytics/affiliate-clicks': ['POST'], // маяк партнёрских кликов (Zod + rate-limit)
  '/api/pwa/install': ['POST'],         // учёт установок PWA (client_id, не ПД, rate-limit)
  // Push-подписка на предупреждения безопасности — анонимная by design
  // (#1485, 02.09). Хендлер открыли гостю ещё 02.08 (его шапка это и говорит),
  // а реестр — нет: гость на /safety жал «Включить», браузер подписывался,
  // POST получал 401 на Edge, в БД не ложилось ничего, а кнопка при следующем
  // заходе показывала «Уведомления включены» по подписке браузера. Отсюда
  // «подписчиков 0» в Watchdog при целой механике. Внутри Zod и rate-limit;
  // endpoint — capability-ссылка, чужой не подобрать.
  '/api/push/subscribe': ['POST', 'DELETE'],
  '/api/payments/tochka/qr': ['GET', 'POST'],  // QR СБП из чата Кузьмича — гостевая оплата by design
  '/api/hub/bookings/create': ['POST'], // гостевая бронь by design (auth опционален, rate-limit)
  // Построение пути Origin → Destination (владелец 28.08, PR 5B-1) — тот же
  // класс, что /api/routes/search выше: планирует поездку кто угодно, без
  // входа. '/api/routes': ['GET'] сюда не дотягивается — метод другой.
  '/api/routes/build': ['POST'],
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
