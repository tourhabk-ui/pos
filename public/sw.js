// Kamchatour Hub Service Worker -- cache-first для офлайн-доступа
// Кэш: статика + карточки мест /places/[id] + туры + API /api/places/[id]
// + тайлы OpenStreetMap — ТОЛЬКО те, что реально просмотрены онлайн
// (массовая предзакачка региона/зумов отключена 28.08 — политика OSM
// запрещает bulk download, см. комментарий у TILE_HOST ниже).
// ВАЖНО: Камчатка = плохое покрытие сети. Каждая открытая карточка кэшируется.

const CACHE_NAME = 'kamchatour-v28'; // bumped: /field-check закэширован с повторами и внесён в офлайн-белый список
const MAX_PLACE_PAGES = 30; // последние 30 карточек мест — туристы просматривают маршрут заранее
const MAX_TOUR_PAGES = 30;  // столько же карточек туров — иначе evictOldTourPages сравнивал с undefined и не чистил ничего
const MAX_TRIP_PAGES = 10;  // планы поездок /trip/[token] — свой план + пара чужих по ссылкам
const API_CACHE_NAME = 'kh-api-v1'; // отдельный кэш для API-ответов

// ─── Tile cache constants ──────────────────────────────────────────────────
const TILE_CACHE_PREFIX = 'kh-tiles-';
const TILE_CACHE_VERSION = 6; // bumped: .cz → OSM, старый кеш kh-tiles-5 будет удалён
const TILE_HOST = 'tile.openstreetmap.org';

// Массовая закачка тайлов с tile.openstreetmap.org — УБРАНА (владелец 28.08,
// M0-безопасность по итогам аудита).
//
// Публичная политика OSM прямо запрещает bulk download/prefetch/«скачать
// область офлайн» с tile.openstreetmap.org — сервис работает без SLA именно
// для обычного просмотра, не для построения собственного офлайн-архива.
// Здесь стояли ДВЕ такие закачки разом:
//   1. этот файл — ~525 тайлов (зум 7-9) при установке SW, БЕЗ спроса;
//   2. CACHE_ZOOM10 (было ниже) — ~1600 тайлов при первом заходе на /map.
// Обе — не просто нарушение политики, а нарушение с неверными координатами:
// диапазоны x/y здесь были для Ямала/Карского моря (69.7-74.0°N, 16.9-30.9°E),
// не для Камчатки (51-61°N, 158-165°E) — «офлайн-карта Камчатки» на деле
// качала Арктику за тысячи километров от неё.
//
// Обычное кэширование тайлов ПРИ ПРОСМОТРЕ (handleTileRequest ниже, по
// событию fetch) — не bulk-скачивание и остаётся: это ровно то использование,
// для которого сервис существует.

// Прозрачный 1×1 PNG как fallback при отсутствии тайла офлайн
const TRANSPARENT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function makeTransparentPngResponse() {
  return new Response(base64ToUint8Array(TRANSPARENT_PNG_B64), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

// КРИТИЧНЫЕ ресурсы — без них теряется смысл safety-приложения офлайн.
// Кэшируются с ретраем; их успех определяет, поднялся ли offline вообще.
// /emergency, /sos, /safety/offline — не должны зависеть от сети НИКОГДА.
const CRITICAL_URLS = [
  '/emergency',        // нулевые зависимости: GPS + звонок 112 + протоколы
  '/sos',              // экстренная помощь
  '/sos/relay',        // приём QR-эстафеты: попутчик открывает офлайн, SOS ложится в его очередь
  '/safety/offline',   // инструкции выживания
  '/safety/geo-degradation.js', // общая семантика деградации GPS — от неё офлайн зависят оба экрана (#897)
  '/safety/qrcode.js', // офлайн-QR с координатами на SOS-экранах — показать спасателю с рабочим телефоном
  '/safety/jsqr.js',   // офлайн-ДЕКОДЕР: попутчик сканирует чужой SOS там, где нет BarcodeDetector (весь iOS)
  '/leaflet/leaflet.min.js',   // Leaflet для офлайн-карты на /emergency
  '/leaflet/leaflet.min.css',
  '/icons/kamchatka-silhouette.jpg',
];

// ОПЦИОНАЛЬНЫЕ — полезно иметь офлайн, но их отсутствие не ломает СОС.
// Часть из них dynamic/может редиректить — поэтому строго best-effort.
const OPTIONAL_URLS = [
  '/',
  '/map',
  '/offline',
  '/offline/manage',
  '/planning',
  '/ai-assistant',
];

// ПОЛЕВЫЕ — не СОС, но их открывают именно там, где связи нет, и один
// промах прекэша стоит всего выхода.
//
// `/field-check` лежал среди опциональных, то есть клался в кэш ОДНОЙ
// попыткой без повтора: сеть моргнула в момент установки — и на перевале
// человек получает страницу «нет соединения» вместо формы, узнав об этом
// там, где переспросить не у кого. Здесь у них те же повторы, что у СОС.
const FIELD_URLS = [
  '/field-check',
];

// Кэширует один URL, не бросая наверх. Для критичных — с повторами.
// Причина переписывания (07.2026, фидбэк с Халактырского пляжа): раньше был
// один cache.addAll(PRECACHE_URLS) — АТОМАРНЫЙ: один упавший URL (редирект,
// медленный dynamic-роут, 404) ронял ВЕСЬ precache, и offline не поднимался
// целиком, включая /emergency. Теперь каждый URL независим.
async function cacheOne(cache, url, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // cache: 'reload' — не брать из HTTP-кэша, чтобы положить свежую версию
      const res = await fetch(url, { cache: 'reload' });
      if (res && res.ok) {
        await cache.put(url, res.clone());
        return true;
      }
    } catch { /* сеть моргнула — повторим */ }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return false;
}

// Установка: критичные страницы (с ретраем) + опциональные (best-effort) +
// тайлы (фоном). Установка НЕ падает целиком из-за одного ресурса.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Критичные — 2 повтора каждый, независимо друг от друга
    await Promise.allSettled(CRITICAL_URLS.map((u) => cacheOne(cache, u, 2)));
    // Опциональные — без повторов, тихо
    await Promise.allSettled(FIELD_URLS.map((u) => cacheOne(cache, u, 2)));
    await Promise.allSettled(OPTIONAL_URLS.map((u) => cacheOne(cache, u, 0)));
    await self.skipWaiting();
  })());
});

// Активация: удаляем старые кэши кроме тайлового и API кэшей
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME
            && key !== `${TILE_CACHE_PREFIX}${TILE_CACHE_VERSION}`
            && key !== API_CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Проверка: URL страницы тура (/tours/[uuid])
function isTourPage(url) {
  return /^\/tours\/[a-f0-9-]+$/i.test(new URL(url).pathname);
}

function isPlacePage(url) {
  return /^\/places\/[a-f0-9-]+$/i.test(new URL(url).pathname);
}

function isPlaceApiRequest(url) {
  return /^\/api\/places\/[a-f0-9-]+$/i.test(new URL(url).pathname);
}

// План поездки /trip/[token] и его данные (C-6): план смотрят дома по Wi-Fi,
// а идут по нему там, где связи нет. Токен — uuid, 36 символов.
function isTripPage(url) {
  return /^\/trip\/[a-f0-9-]{36}$/i.test(new URL(url).pathname);
}

function isTripApiRequest(url) {
  return /^\/api\/trips\/share\/[a-f0-9-]{36}(\/gpx)?$/i.test(new URL(url).pathname);
}

// Проверка: статический ассет Next.js
function isStaticAsset(url) {
  const pathname = new URL(url).pathname;
  return pathname.startsWith('/_next/static/') ||
         pathname.startsWith('/icons/') ||
         pathname.endsWith('.css') ||
         pathname.endsWith('.js') ||
         pathname.endsWith('.woff2') ||
         pathname.endsWith('.woff');
}

// LRU-эвикция: удаляем старые карточки мест, оставляем MAX_PLACE_PAGES
async function evictOldPlacePages(cache) {
  const keys = await cache.keys();
  const placeKeys = keys.filter((req) => isPlacePage(req.url));
  if (placeKeys.length > MAX_PLACE_PAGES) {
    const toDelete = placeKeys.slice(0, placeKeys.length - MAX_PLACE_PAGES);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

// LRU-эвикция: удаляем старые туры, оставляем MAX_TOUR_PAGES
async function evictOldTourPages(cache) {
  const keys = await cache.keys();
  const tourKeys = keys.filter((req) => isTourPage(req.url));
  if (tourKeys.length > MAX_TOUR_PAGES) {
    const toDelete = tourKeys.slice(0, tourKeys.length - MAX_TOUR_PAGES);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

// LRU-эвикция: старые планы поездок, оставляем MAX_TRIP_PAGES
async function evictOldTripPages(cache) {
  const keys = await cache.keys();
  const tripKeys = keys.filter((req) => isTripPage(req.url));
  if (tripKeys.length > MAX_TRIP_PAGES) {
    const toDelete = tripKeys.slice(0, tripKeys.length - MAX_TRIP_PAGES);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}

// ─── Tile cache handler ────────────────────────────────────────────────────

async function handleTileRequest(request) {
  const cacheName = `${TILE_CACHE_PREFIX}${TILE_CACHE_VERSION}`;
  const cache = await caches.open(cacheName);

  // Cache-first: сначала кэш
  const cached = await cache.match(request);
  if (cached) return cached;

  // Онлайн — загружаем и сохраняем в кэш ДЛЯ ТЕКУЩЕГО ПРОСМОТРА (не bulk-
  // закачка — обычное использование, которое политика OSM разрешает).
  try {
    const response = await fetch(request);
    if (response.ok) {
      const clone = response.clone();
      // Сохраняем в кэш (неблокирующая запись)
      cache.put(request, clone);
    }
    return response;
  } catch {
    // Офлайн и тайла нет в кэше (массовая предзакачка отключена, M0) —
    // прозрачный PNG fallback честнее, чем пустой прямоугольник.
    return makeTransparentPngResponse();
  }
}

// ─── postMessage: управление tile cache ───────────────────────────────────

self.addEventListener('message', (event) => {
  if (!event.data) return;

  // Отправитель должен быть нашей же страницей.
  //
  // js/missing-origin-check, 23.08.2026. По спецификации service worker
  // управляет только клиентами своего origin, так что проверка здесь —
  // не столько заслон, сколько ЗАПИСАННЫЙ инвариант: обработчик пишет в
  // кэш тайлов и удаляет из него, и молчаливое допущение «сюда чужой не
  // достучится» лучше держать проверяемым. `event.origin` бывает пустым
  // (не все браузеры его заполняют для Client.postMessage) — пустое не
  // считаем чужим, иначе сломаем офлайн-карту там, где всё в порядке.
  if (event.origin && event.origin !== self.location.origin) return;

  // Массовая закачка региона/коридора маршрута по списку адресов — ОТКЛЮЧЕНА
  // (владелец 28.08, M0-безопасность). Публичная политика OSM запрещает
  // bulk download с tile.openstreetmap.org — а именно им был каждый вызов
  // этого типа (regionId — «сохранить регион офлайн», «скачать для похода»,
  // «сохранить полевой пакет»). Честный отказ, а не тихая пустота или
  // отчёт «готово» без единого скачанного тайла: клиент (useOfflineRegion,
  // route/[id] и planning) слушает TILES_UNAVAILABLE и показывает причину
  // словами. Вернётся, когда появится собственный источник (PMTiles).
  if (event.data.type === 'CACHE_TILES') {
    const { regionId } = event.data;
    if (event.source) {
      event.source.postMessage({
        type: 'TILES_UNAVAILABLE',
        regionId,
        reason: 'Массовая закачка карты временно недоступна — источник тайлов меняется.',
      });
    }
    return;
  }

  // Удаление тайлов ПО СПИСКУ АДРЕСОВ.
  //
  // Раньше здесь стоял обработчик CLEAR_REGION_TILES, который не удалял
  // ничего: он отвечал «готово», и человек видел подтверждение, а 6-22 МБ
  // тайлов оставались навсегда. Оправдание было в комментарии — «удалить
  // конкретный регион нельзя без маппинга». Маппинг не нужен: адреса тайлов
  // вычислимы из bbox региона и из трека полевого пакета, обе функции
  // детерминированы. Считает их клиент (lib/offline/tile-ownership.ts) —
  // он же знает, какие адреса держит кто-то ещё, — а сюда приходит готовый
  // список к удалению.
  if (event.data.type === 'CLEAR_TILES') {
    const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
    deleteTiles(urls, event.data.reason, event.source);
    return;
  }
});

/**
 * Удаляет перечисленные тайлы и докладывает, сколько РЕАЛЬНО удалено.
 *
 * Число берётся из ответов Cache Storage, а не из длины списка: адрес мог
 * никогда не кэшироваться, и выдавать намерение за результат нельзя — на
 * этом обработчик и погорел в прошлый раз.
 */
async function deleteTiles(urls, reason, client) {
  const cacheName = `${TILE_CACHE_PREFIX}${TILE_CACHE_VERSION}`;
  let deleted = 0;
  let failed = 0;
  try {
    const cache = await caches.open(cacheName);
    for (const url of urls) {
      try {
        if (await cache.delete(url)) deleted++;
      } catch (err) {
        failed++;
      }
    }
  } catch (err) {
    // Кэш не открылся — сказать об этом честно, а не отчитаться нулём удалений
    // как об успехе.
    if (client) {
      client.postMessage({ type: 'TILES_CLEARED', reason, ok: false, deleted: 0, requested: urls.length, error: String(err) });
    }
    return;
  }
  if (client) {
    client.postMessage({ type: 'TILES_CLEARED', reason, ok: true, deleted, failed, requested: urls.length });
  }
}

// cacheTilesForRegion (массовая закачка списка тайлов) удалена вместе с
// CACHE_TILES-обработчиком выше — не вызывается больше ниоткуда.

// ─── Whitelist: страницы которые умеют работать офлайн (IndexedDB / клиентское состояние) ───
// Пути, которым офлайн отдаётся КЭШ, а не страница «нет соединения».
//
// Список решает две вещи разом: как отвечать без сети и обновлять ли кэш при
// удачном онлайн-заходе. `/field-check` в нём не значился — форма открывалась
// без сети только тем, что общая ветка тоже смотрит в кэш, а свежую копию не
// получала НИКОГДА: в кэше навсегда оставалась версия с момента установки
// service worker. Для экрана, который правят каждый день, это значит, что в
// поле уходит вчерашняя форма.
const OFFLINE_CAPABLE_ROUTES = [
  '/', '/map', '/offline', '/offline/manage', '/planning', '/ai-assistant',
  '/field-check',
];

function isOfflineCapable(pathname) {
  return OFFLINE_CAPABLE_ROUTES.some(route =>
    pathname === route || pathname.startsWith(route + '/')
  );
}

// ─── Плохая связь ≠ офлайна ───────────────────────────────────────────────────
//
// Полевой прогон 04.08 (EDGE, «одна палка»): работала только главная, любой
// переход выглядел как «ничего не происходит». Причина не в офлайн-логике —
// она как раз в порядке. При обрыве сети fetch ОТКЛОНЯЕТСЯ, и весь код ниже
// ловит это в .catch и отдаёт кэш. При живой, но издыхающей сети fetch не
// отклоняется — он ВИСИТ десятки секунд, .catch не срабатывает никогда, и
// туристу нечего показать. Худший из двух миров: офлайн отработан честно, а
// «почти офлайн» — нет, хотя в горах это и есть обычное состояние связи.
//
// Лечение: гонка с таймером. Кэш есть — отдаём его, не дожидаясь сети. Кэша
// нет — ПРОДОЛЖАЕМ ждать: обрывать медленную, но живую загрузку нечем заменить,
// и белый экран вместо страницы через 4 секунды был бы враньём наоборот.

/** Документ: кэш побеждает висящую сеть. */
const NAV_TIMEOUT_MS = 4000;
/** RSC-пейлоад клиентского перехода: даём сети больше, но не бесконечность. */
const RSC_TIMEOUT_MS = 8000;

function cacheIfOk(request, response) {
  if (!response || !response.ok) return;
  const clone = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
}

/**
 * Навигация с таймаутом. По таймауту отдаём кэш, если он есть; иначе ждём сеть
 * дальше. `shouldCache` — сохранять ли удачный ответ (у разных веток свои
 * правила: whitelist кэширует всё, общая ветка — только главную и /tours).
 */
function navigateWithTimeout(request, shouldCache) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    fetch(request).then((response) => {
      if (shouldCache) cacheIfOk(request, response);
      done(response);
    }).catch(() => {
      done(caches.match(request).then((cached) => cached || caches.match('/offline')));
    });

    setTimeout(() => {
      if (settled) return;
      caches.match(request).then((cached) => { if (cached) done(cached); }).catch(() => {});
    }, NAV_TIMEOUT_MS);
  });
}

// ─── Fetch: cache-first для статики и туров, network-first для остального ──

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Пропускаем не-GET запросы
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Чужие хосты не перехватываем — кроме тайлов OSM, у которых своя ветка
  // ниже. Иначе они проваливались в общую ветку navigateWithTimeout, а та
  // на отказ сети отдаёт РАЗМЕТКУ страницы /offline. Читатель PMTiles
  // (Range-GET к s3.twcstorage.ru) получал бы HTML вместо 206, MapLibre для
  // горизонталей — HTML вместо GeoJSON. Cache API к тому же не хранит
  // частичные ответы (cache.put на 206 отказывает), так что кэшировать
  // здесь всё равно нечего. Офлайн-пакет карты — отдельный слой, не этот.
  if (url.origin !== self.location.origin && url.hostname !== TILE_HOST) return;

  // RSC-запрос Next (клиентский переход по <Link>): просят ПЕЙЛОАД, не документ.
  // У него mode !== 'navigate', поэтому ветка навигации ниже его не ловит, и
  // офлайн он доходил до общей ветки, где в ответ отдавалась РАЗМЕТКА страницы
  // /offline. Роутер ждёт пейлоад, получает HTML и виснет навсегда: полевой
  // тест в авиарежиме 30.07 показал бесконечный скелетон сразу на всех трёх
  // офлайн-ссылках, включая /safety/offline из критичного precache.
  //
  // Здесь отказ становится честным и быстрым — HTML вместо пейлоада не
  // подсовываем никогда. Основное лечение не тут, а в разметке: офлайн-пути
  // ходят жёсткой <a> (app/offline/page.tsx, EmergencyAction), и тогда переход
  // идёт документом и отдаётся из кэша. Эта ветка — страховка для остальных
  // страниц, где <Link> законен.
  //
  // Таймаут здесь — половина лечения полевого прогона 04.08. Висящий (не
  // отклонённый) запрос пейлоада — это ровно «нажал и ничего не происходит»:
  // роутер ждёт ответ молча, старый экран остаётся на месте. Отдав 503, мы
  // заставляем роутер деградировать в обычный переход документом, а документ
  // ниже уже умеет отдаться из кэша.
  if (url.searchParams.has('_rsc') || request.headers.get('RSC') === '1') {
    event.respondWith(
      new Promise((resolve) => {
        let settled = false;
        const offline = () => new Response('', { status: 503, statusText: 'Offline' });
        const done = (value) => { if (!settled) { settled = true; resolve(value); } };
        fetch(request).then(done).catch(() => done(offline()));
        setTimeout(() => done(offline()), RSC_TIMEOUT_MS);
      })
    );
    return;
  }

  // /api/places/[id] — кэшируем отдельно: это критичные данные для офлайна
  if (isPlaceApiRequest(url.href)) {
    event.respondWith(
      caches.open(API_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        try {
          const response = await fetch(request);
          if (response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          // Нет сети — отдаём кэш: турист уже открывал эту карточку
          if (cached) return cached;
          return new Response(JSON.stringify({ success: false, error: 'Нет подключения. Откройте карточку онлайн заранее.' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      })
    );
    return;
  }

  // /api/trips/share/[token] (+ /gpx) — данные и GPX плана поездки (C-6):
  // network-first, офлайн — из кэша. Тот же контракт, что у /api/places.
  if (isTripApiRequest(url.href)) {
    event.respondWith(
      caches.open(API_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        try {
          const response = await fetch(request);
          if (response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          if (cached) return cached;
          return new Response(JSON.stringify({ success: false, error: 'Нет подключения. Откройте план онлайн заранее.' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      })
    );
    return;
  }

  // Остальные API — не кэшируем
  if (url.pathname.startsWith('/api/')) return;

  // Тайлы OpenStreetMap — cache-first c прозрачным PNG fallback
  if (url.hostname === TILE_HOST) {
    event.respondWith(handleTileRequest(request));
    return;
  }

  // Статические ассеты: cache-first
  if (isStaticAsset(request.url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Карточки мест /places/[id]: network-first + кэш офлайн + LRU 30 страниц
  // Критично для Камчатки: турист смотрит карточки дома, идёт без связи
  if (isPlacePage(request.url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(async (cache) => {
              await cache.put(request, clone);
              await evictOldPlacePages(cache);
            });
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached || caches.match('/offline');
        })
    );
    return;
  }

  // Страницы туров: network-first + кэш офлайн + LRU (как /places).
  //
  // Было cache-first (`return cached || fetch`): один раз закэшированная
  // страница тура отдавалась из кэша ВСЕГДА, сеть дёргалась лишь в фоне. После
  // деплоя старый HTML ссылался на чанки старой сборки `/_next/static/<hash>`,
  // Next их удалял → 404 → белый экран и павшая гидратация. Именно это читалось
  // как «PWA плохо работает» и «иконки пропали, нужен хард-рефреш» (07.08).
  // Network-first отдаёт свежее сразу, а офлайн по-прежнему берётся из кэша —
  // тот же контракт, что у карточек мест.
  if (isTourPage(request.url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(async (cache) => {
              await cache.put(request, clone);
              await evictOldTourPages(cache);
            });
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached || caches.match('/offline');
        })
    );
    return;
  }

  // Планы поездок /trip/[token]: network-first + кэш офлайн + LRU (как туры).
  // План смотрят дома, идут по нему без связи — та же полевая логика, что
  // у карточек мест: открыл онлайн один раз — офлайн страница живёт.
  if (isTripPage(request.url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(async (cache) => {
              await cache.put(request, clone);
              await evictOldTripPages(cache);
            });
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached || caches.match('/offline');
        })
    );
    return;
  }

  // Навигация: whitelist страниц которые работают офлайн через IndexedDB
  if (request.mode === 'navigate' || request.destination === 'document') {
    if (isOfflineCapable(url.pathname)) {
      event.respondWith(navigateWithTimeout(request, true));
      return;
    }
    // Не whitelisted — профиль, каталог и т.д. → /offline
  }

  // Остальные страницы: network-first с fallback на кэш и таймаутом.
  // Кэшируем только успешные ответы главной и /tours (скобки — фикс
  // приоритета: раньше && / || без скобок кэшировал даже не-ok /tours)
  event.respondWith(
    navigateWithTimeout(request, url.pathname === '/' || url.pathname === '/tours')
  );
});

// ── Web Push ──────────────────────────────────────────────────────────────────

self.addEventListener('push', function(event) {
  if (!event.data) return;
  var payload;
  try { payload = event.data.json(); } catch(e) { payload = { title: 'Ведар', body: event.data.text() }; }

  var title = payload.title || 'Ведар';
  var options = {
    body:     payload.body  || '',
    icon:     payload.icon  || '/icons/icon-192.png',
    badge:    '/icons/icon-192.png',
    data:     { url: payload.url || '/' },
    vibrate:  [200, 100, 200],
    tag:      payload.tag || undefined,
    renotify: !!payload.tag,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      var found = list.find(function(c) { return c.url === url; });
      if (found && 'focus' in found) return found.focus();
      return clients.openWindow(url);
    })
  );
});

// ── Background Sync ───────────────────────────────────────────────────────────

function openPendingDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('kh-pending-v1', 1);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('pending_sos')) {
        db.createObjectStore('pending_sos', { keyPath: 'id' });
      }
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = function() { reject(req.error); };
  });
}

async function sendPendingSOS() {
  var db = await openPendingDB();
  var items = await new Promise(function(resolve, reject) {
    var tx = db.transaction('pending_sos', 'readonly');
    var req = tx.objectStore('pending_sos').getAll();
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    try {
      // Чужой SOS (QR-эстафета / офлайн-ретранслятор меша) идёт через
      // /api/mesh/sos-relay: там дедуп по sos_id — несколько попутчиков
      // могли отсканировать один и тот же QR. Свой — в канонический роут.
      // Зеркало requestFor() из lib/offline/pending-queue.ts.
      var url = item.relay ? '/api/mesh/sos-relay' : '/api/safety/sos';
      var body = item.relay
        ? JSON.stringify({
            sos_id: item.relay.sos_id,
            relayed_by: item.relay.relayed_by,
            origin_device: item.relay.origin_device,
            sos: {
              lat: item.lat,
              lng: item.lng,
              accuracy: item.accuracy,
              message: item.message || null,
              tourist_name: item.tourist_name,
              tourist_phone: item.tourist_phone,
            },
          })
        : JSON.stringify({
            lat: item.lat,
            lng: item.lng,
            accuracy: item.accuracy,
            message: item.message || undefined,
            tourist_name: item.tourist_name,
            tourist_phone: item.tourist_phone,
          });
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      });
      if (res.ok || res.status === 429) {
        // 429 = rate-limited = already received, delete anyway
        await new Promise(function(resolve, reject) {
          var tx2 = db.transaction('pending_sos', 'readwrite');
          var del = tx2.objectStore('pending_sos').delete(item.id);
          tx2.oncomplete = resolve;
          del.onerror = reject;
        });
      }
    } catch { /* network still down, will retry on next sync */ }
  }
}

self.addEventListener('sync', function(event) {
  if (event.tag === 'sos-sync') {
    event.waitUntil(sendPendingSOS());
  }
});
