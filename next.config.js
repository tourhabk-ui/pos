/** @type {import('next').NextConfig} */
// ТОЛЬКО dev: вебпак в next dev собирает чанки через eval (eval-source-map),
// и CSP без 'unsafe-eval' молча роняла клиентский чанк с PageViewTracker —
// локально page_views не писались вовсе, разработка была «слепа» (находка
// сквозного прогона 14.08, задача #59). В production строка пустая: прод-CSP
// не ослабляется ни на символ.
const DEV_EVAL = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';

/**
 * Штампа сборки здесь НЕТ — и это результат замера, а не забывчивость.
 *
 * 04.09 (#1582) сюда поставили `env: { BUILD_TIME }`, чтобы /api/health
 * отвечал «тот ли код на проде». 05.09 prod-check run 8 показал на проде
 * `build_time: null` при uptime 464 с: в standalone-сборке значение из `env`
 * до обработчика маршрута не доходит, и три ожидания деплоя подряд честно
 * отсидели по 25 минут впустую. Маркер деплоя один — public/version.json
 * (scripts/write-version.js, commit + built_at); его читает и /api/health,
 * и scripts/wait-for-deploy.sh. Второй штамп заводить не нужно.
 */
/**
 * Сайты партнёров, которые Ведар отдаёт со своего приложения (слово владельца
 * 22.10: fishingkam.ru «под нашим управлением», DNS на REG.RU). Тот же список —
 * lib/partner-sites/registry.ts; CommonJS отсюда TypeScript не читает, и что
 * списки совпадают, держит tests/unit/partner-site-routing.test.ts.
 *
 * Пока DNS домена смотрит на старый хостинг, правила ниже не срабатывают ни
 * разу: запросов с этим Host к приложению нет.
 */
const PARTNER_SITE_HOSTS = [
  { host: 'fishingkam.ru', key: 'fishingkam' },
];

/** Условия «запрос пришёл на домен»: по Host и по X-Forwarded-Host (за прокси Timeweb Host подменяется — см. tourhab.ru в redirects). */
function hostConditions(hostPattern) {
  return [
    [{ type: 'host', value: hostPattern }],
    [{ type: 'header', key: 'x-forwarded-host', value: hostPattern }],
  ];
}

const escapeHost = (host) => host.replace(/\./g, '\\.');

/**
 * Домен партнёра → его страница: главная, robots.txt и sitemap.xml. Это
 * beforeFiles: afterFiles не перекрыл бы app/page.tsx, и на fishingkam.ru
 * открылась бы главная Ведара. Каждое правило — только с условием домена:
 * без него оно подменило бы главную самого Ведара.
 */
function partnerSiteRewrites() {
  return PARTNER_SITE_HOSTS.flatMap(({ host, key }) =>
    hostConditions(`(www\\.)?${escapeHost(host)}`).flatMap((has) => [
      { source: '/', has, destination: `/partner-site/${key}` },
      { source: '/robots.txt', has, destination: `/partner-site/${key}/robots.txt` },
      { source: '/sitemap.xml', has, destination: `/partner-site/${key}/sitemap.xml` },
    ]));
}

/**
 * Адреса домена партнёра, которые должны вести не туда, где их найдёт
 * приложение:
 *  - www → голый домен, одним хопом (как www.vedarai.ru);
 *  - страницы документов прежнего сайта на Tilda (/pol, /soglasie, /reklama,
 *    /cookie — перепись ссылок 22.10, проба 987) — на политику Ведара: заявки
 *    на новом сайте собирает Ведар, и документ о них — наш;
 *  - /legal/* (ссылка «политика» в согласии формы относительная) — на
 *    vedarai.ru, а не страница Ведара под адресом партнёра;
 *  - /tproduct/* (карточки магазина Tilda) — на главную, где туры.
 * /api исключён, как в правилах tourhab.ru: заявка с формы — POST /api/leads.
 */
function partnerSiteRedirects() {
  return PARTNER_SITE_HOSTS.flatMap(({ host }) => [
    ...hostConditions(`www\\.${escapeHost(host)}`).flatMap((has) => [
      { source: '/', has, destination: `https://${host}/`, permanent: true },
      { source: '/:path((?!api/).*)', has, destination: `https://${host}/:path`, permanent: true },
    ]),
    ...hostConditions(escapeHost(host)).flatMap((has) => [
      ...['/pol', '/soglasie', '/reklama', '/cookie'].map((source) => (
        { source, has, destination: 'https://vedarai.ru/legal/privacy', permanent: true }
      )),
      { source: '/legal/:path*', has, destination: 'https://vedarai.ru/legal/:path*', permanent: true },
      { source: '/tproduct/:path*', has, destination: '/', permanent: true },
    ]),
  ]);
}

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,

  // Метаданные — в <head> и для Googlebot. Next 15.5 отдаёт title/canonical/
  // robots стримингом в <body> всем, кроме списка htmlLimitedBots, а в
  // списке по умолчанию есть yandex и Bingbot, но НЕТ Googlebot. Google
  // принимает rel=canonical только из <head>: по замеру аудита SEO 29.09 (Н4)
  // около 790 из 880 адресов были для него без действующего canonical.
  // Строка ниже — список Next по умолчанию (next/dist/shared/lib/router/utils/
  // html-bots.js) плюс Googlebot, плюс китайские обходчики Bytespider, PetalBot,
  // YisouSpider и 360Spider (12.10; baiduspider и sogou в списке Next уже были).
  // Цена — блокирующий рендер для этих ботов.
  htmlLimitedBots: /Googlebot|[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|Bytespider|PetalBot|YisouSpider|360Spider|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i,
  compress: true,

  // Здесь стоял experimental.serverActions.bodySizeLimit = '60mb'. Убрано
  // 07.09 по внешнему аудиту, и не потому, что вектор был, а потому что его
  // не было: Server Actions в кодовой базе нет ни одного файла ('use server'
  // не встречается нигде), то есть настройка не действовала ни на что.
  //
  // Мёртвая настройка опаснее живой ошибки. Первый, кто однажды напишет
  // 'use server', молча унаследовал бы приём тела в шестьдесят мегабайт —
  // и решение об этом принял бы не он, а строка, забытая год назад.
  // Понадобится большой приём — ставить осознанно, вместе с ограничением
  // частоты и проверкой типа, а не заранее «на всякий случай».

  // outputFileTracingRoot removed — may prevent standalone output

  // pdfkit читает AFM-шрифты своего пакета при создании документа —
  // без include standalone-трассировка может их потерять, и любой PDF
  // падает с ENOENT (~1 МБ данных, лимит 50 МБ не задевает).
  //
  // С pdfkit 0.20 стандартные шрифты грузятся НЕ файлами из js/data, а
  // модулями через подпутевой импорт пакета: require('#standard-fonts/Helvetica')
  // → js/standard-fonts/Helvetica.cjs (поле "imports" в его package.json).
  // Трассировка standalone такие require по шаблону не видит, каталог в
  // образ не попадал, и PDF предложения на проде падал «Cannot find module
  // '#standard-fonts/Helvetica'» (скрин владельца 11.10). ~200 КБ. Сторож
  // tests/unit/pdfkit-standalone-fonts.test.ts сверяет список с полем
  // "imports" установленного pdfkit — обновят пакет, сменится путь, и он
  // покраснеет до деплоя, а не на телефоне.
  outputFileTracingIncludes: {
    '/api/**': [
      './node_modules/pdfkit/js/data/**',
      './node_modules/pdfkit/js/standard-fonts/**',
    ],
  },

  // ESLint: skip during build (saves ~500MB RAM) — checks run locally via CI
  // TypeScript: keep strict — fast and catches real errors
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,  // Keep true to avoid blocking deploys on minor TS issues
  },

  // unoptimized: убирает sharp/@img (~33MB) из standalone — критично для Timeweb лимита 50MB
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },

  // outputFileTracingExcludes DISABLED — was causing pages to be excluded from build
  // (broken syntax: strings without keys in object)

  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || '',
  },

  webpack: (config, { isServer }) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        'onnxruntime-node',
      ];
    }
    return config;
  },

  async redirects() {
    return [
      // Домен партнёра — первым: его адреса не должны дойти до общих правил.
      ...partnerSiteRedirects(),
      // ── Канон домена ────────────────────────────────────────────────────
      // tourhab.ru и vedarai.ru отдавали один и тот же сайт. Для поисковика и
      // для ИИ-агента это два разных сайта с одинаковым содержимым: ссылки,
      // цитирования и вес делятся пополам, а партнёр ставит ссылку наугад.
      // Канонические теги уже указывают на vedarai.ru — но тег это лишь
      // просьба, а 308 это ответ.
      //
      // /api ИСКЛЮЧЁН намеренно. Вебхуки (Telegram, MAX, приёмники оплат)
      // редиректов не ходят: они увидят 308 и посчитают доставку неудачной.
      // Канон нужен странице, которую читают люди и агенты; интеграции,
      // прописанные на старый хост, продолжают работать как работали.
      //
      // Правило продублировано по ДВУМ заголовкам, и это не перестраховка.
      // Оно лежит здесь с 14.08, было выложено — а 17.08 владелец открыл
      // tourhab.ru с телефона и увидел сайт, не перенаправление; ночная сверка
      // каналов повторяла то же пятые сутки (#1155). Значит `host` до Next не
      // доезжает: прокси провайдера подменяет Host собственным, а исходное имя
      // кладёт в X-Forwarded-Host — обычное поведение ingress'а. Какой из двух
      // приходит на самом деле, отсюда не проверить (прод закрыт для среды
      // сборки), поэтому ловим оба: лишнее правило не сработает ни разу и
      // ничего не стоит, а пропущенное держит раздвоение сайта.
      {
        source: '/',
        has: [{ type: 'host', value: '(www\\.)?tourhab\\.ru' }],
        destination: 'https://vedarai.ru/',
        permanent: true,
      },
      {
        source: '/:path((?!api/).*)',
        has: [{ type: 'host', value: '(www\\.)?tourhab\\.ru' }],
        destination: 'https://vedarai.ru/:path',
        permanent: true,
      },
      {
        source: '/',
        has: [{ type: 'header', key: 'x-forwarded-host', value: '(www\\.)?tourhab\\.ru' }],
        destination: 'https://vedarai.ru/',
        permanent: true,
      },
      {
        source: '/:path((?!api/).*)',
        has: [{ type: 'header', key: 'x-forwarded-host', value: '(www\\.)?tourhab\\.ru' }],
        destination: 'https://vedarai.ru/:path',
        permanent: true,
      },
      // www.vedarai.ru (02.10): перепись Timeweb показала, что имя резолвится
      // на приложение, но в его доменах не числилось — сертификата не было, и
      // адрес с www не открывался вовсе. Маркер timeweb-configure.json
      // добавляет поддомен к приложению; дальше та же пара правил, что у
      // tourhab.ru, сводит www к канону одним хопом. /api исключён по той же
      // причине, что выше.
      {
        source: '/',
        has: [{ type: 'host', value: 'www\\.vedarai\\.ru' }],
        destination: 'https://vedarai.ru/',
        permanent: true,
      },
      {
        source: '/:path((?!api/).*)',
        has: [{ type: 'host', value: 'www\\.vedarai\\.ru' }],
        destination: 'https://vedarai.ru/:path',
        permanent: true,
      },
      {
        source: '/',
        has: [{ type: 'header', key: 'x-forwarded-host', value: 'www\\.vedarai\\.ru' }],
        destination: 'https://vedarai.ru/',
        permanent: true,
      },
      {
        source: '/:path((?!api/).*)',
        has: [{ type: 'header', key: 'x-forwarded-host', value: 'www\\.vedarai\\.ru' }],
        destination: 'https://vedarai.ru/:path',
        permanent: true,
      },
      { source: '/emergency.html',      destination: '/emergency',                       permanent: true },
      { source: '/fishingkam',          destination: '/operators/kamchatskaya-rybalka',  permanent: true },
      // Листинг операторов канонический на /operators: после SSR (шаг 3, #460)
      // дубли отдавали идентичный контент и каннибалили бы друг друга в индексе.
      // marketplace-вариант — до общего :path*-правила, чтобы редирект был одним хопом.
      { source: '/marketplace/operators', destination: '/operators',                    permanent: true },
      { source: '/catalog/operators',  destination: '/operators',                      permanent: true },
      // Список туров живёт на /catalog; /catalog/tours без id — 404. Ссылка
      // vedarai.ru/marketplace/tours ушла в соцсети 30.10 — один хоп сразу в каталог.
      { source: '/marketplace/tours',  destination: '/catalog',                        permanent: true },
      { source: '/catalog/tours',      destination: '/catalog',                        permanent: true },
      { source: '/tury-na-kamchatku',  destination: '/catalog',                        permanent: true },
      { source: '/marketplace/:path*', destination: '/catalog/:path*',                 permanent: true },
      { source: '/marketplace',        destination: '/catalog',                        permanent: true },
      { source: '/tours',              destination: '/catalog',                        permanent: true },
      // ЧПУ туров (30.09): /tours/{адрес или число} — короткая форма карточки.
      { source: '/tours/:slug',        destination: '/catalog/tours/:slug',            permanent: true },
      { source: '/terms',              destination: '/legal/terms',                    permanent: true },
      { source: '/auth/register',      destination: '/operators/join',                 permanent: false },
      // Перепись страниц 01.10: девять папок в app/ держали по одной строке
      // redirect() — старые адреса из закладок, писем и уведомлений. Папка ради
      // редиректа — это роут, сборка и место в переписи; строка здесь делает
      // то же одним ответом 308 и до роутера. Сторож: tests/unit/legacy-redirects.
      { source: '/auth/register-operator', destination: '/operators/join',            permanent: true },
      { source: '/hub/operator/register',  destination: '/operators/join',            permanent: true },
      { source: '/cart',                   destination: '/hub/tourist/cart',          permanent: true },
      { source: '/hub/tourist/eco-points', destination: '/hub/tourist/loyalty',       permanent: true },
      // Заявки платформы агентам закрыты 26.09 — ссылки ведут в «Клиенты».
      { source: '/hub/agent/leads',        destination: '/hub/agent/clients',         permanent: true },
      // «Открыть в CRM» из Telegram-уведомлений — карточка лида у оператора.
      { source: '/hub/admin/leads/:id',    destination: '/hub/operator/leads/:id',    permanent: true },
      { source: '/kuzmich/hub',            destination: '/',                          permanent: true },
      // Один полевой экран на платформу (field-cockpit): /on-route упразднён.
      { source: '/on-route',               destination: '/planning?mode=trail',       permanent: true },
      { source: '/routes/detail/:id',      destination: '/routes/:id',                permanent: true },
      // Перепись админ-панели 03.09: «AI Кузьмич» и «Расходы AI» читали одну
      // таблицу ai_actions_log с двух страниц в разных разделах меню. Теперь
      // одна страница с вкладками; старый адрес живёт в закладках и в
      // отчётах агентов — редирект, а не 404.
      { source: '/hub/admin/ai-analytics', destination: '/hub/admin/ai-usage?tab=kuzmich', permanent: false },
      // Та же перепись: «Разведка» и Volcano Brain читали одну agent_memory
      // (intelligence_* ключи) с двух страниц. Теперь разведка — вкладка Brain.
      { source: '/hub/admin/intelligence', destination: '/hub/admin/brain?tab=intel', permanent: false },
      // Та же перепись, третья пара: «AI и автоматизации» (живость кронов) и
      // «Работа Volcano OS» (ядро) отвечали на один вопрос «жив ли агент» с
      // двух плиток. Теперь агенты — вкладка кокпита.
      { source: '/hub/admin/agents', destination: '/hub/admin/volcano?tab=agents', permanent: false },
      // Четвёртая пара: «Модели эволюции» (/v1/models у провайдеров) и проба
      // провайдеров на Health-метриках отвечали на один вопрос «кто сейчас
      // отвечает». Теперь модели — вкладка Health-метрик.
      { source: '/hub/admin/evo/models', destination: '/hub/admin/health?tab=models', permanent: false },
      // /home-v7 — dev-превью новой главной (noindex, без ссылок). Реорг Этап 2:
      // код переехал в app/_home/ (приватная папка, не роут), роут /home-v7 убран.
      // 301 на / — страховка от старых закладок на превью.
      { source: '/home-v7',            destination: '/',                               permanent: true },
      // /dashboard — осиротевший «командный центр», перекрыт Главной v8 (реорг
      // Этап 9). Раньше страница делала runtime redirect('/') (307); постоянный
      // 301 здесь — SEO-корректно и убирает stub-роут. _DashboardClient удалён
      // 02.10 (внутренний аудит): не рендерился нигде и держал выдуманные
      // статусы («Вулканы: норма», «Связь: 3G», прилив по часам).
      { source: '/dashboard',          destination: '/',                               permanent: true },
      // Дизайн-аудит 18.10 (вариант А): /en и /booking попадали в rewrite
      // короткого адреса оператора и отдавали 404. Ведар — информационный
      // портал: /booking ведёт на страницу заявок операторам, а не на оплату.
      { source: '/en',                 destination: '/en/kamchatka-tours',             permanent: true },
      { source: '/booking',            destination: '/bronirovanie-turov-kamchatka',   permanent: true },
    ];
  },

  // ── Короткий адрес партнёра: vedarai.ru/<slug> ──────────────────────────
  // Решение владельца 13.10: «адрес vedarai.ru/<slug>». Это та же страница
  // оператора /operators/<slug>: rewrite держит короткий адрес в строке
  // браузера, а canonical страницы остаётся /operators/<slug> — в поиске
  // страница одна. Именно rewrite, а не маршрут app/[slug]: верхний
  // динамический сегмент делает «страницей» любой односегментный адрес, и
  // правило Next no-html-link-for-pages краснит все жёсткие <a href="/…">
  // проекта, включая намеренные (field-nav-hard) — 17 ошибок lint на #2414.
  // Rewrite из массива — afterFiles: статические страницы и файлы public
  // старше него, /catalog, /about и /robots.txt он не перехватывает.
  // Форма slug — латиница, цифры, дефис, от двух знаков, без точек: опечатки
  // и /favicon.ico в базу не ходят; неизвестный slug — notFound самой
  // страницы оператора. Сторож: tests/unit/partner-short-address.
  // Сайт партнёра на его домене — beforeFiles (см. partnerSiteRewrites выше);
  // короткий адрес по-прежнему afterFiles.
  async rewrites() {
    return {
      beforeFiles: partnerSiteRewrites(),
      afterFiles: [
        { source: '/:slug([a-z0-9][a-z0-9-]+)', destination: '/operators/:slug' },
      ],
    };
  },

  async headers() {
    return [
      // HTML-страницы не должны кэшироваться на CDN/прокси —
      // «статус дня» и персональные данные не должны отдаваться из edge-кэша.
      //
      // Машинные файлы для обходчиков исключены (аудит SEO 29.09, вечер):
      // sitemap, robots, llms.txt и две ленты объявлений ставят свой
      // Cache-Control, но это правило перебивало его — прод отвечал no-store,
      // а код обещал «кэш на час». Ни статуса дня, ни личных данных в них нет.
      // Сторож: tests/unit/seo-audit-2909-evening.test.ts.
      //
      // Документы для агентов (12.10) — манифест MCP, визитки A2A, карточка
      // сервера, AI Catalog, OpenAPI и каталог API — ставят «час кэша» в самих
      // роутах и тоже исключены: иначе прод отвечал бы no-store, а код обещал
      // кэш (та же болезнь, что у sitemap 29.09). Личных данных в них нет.
      // Сторож: tests/unit/openapi-agents.test.ts.
      {
        source: '/((?!_next/static|_next/image|icons|images|favicon|sitemap\\.xml$|robots\\.txt$|llms(?:-zh)?\\.txt$|api/channels/(?:avito|yandex)/feed$|openapi\\.json$|\\.well-known/(?:mcp\\.json|agent-card\\.json|agent\\.json|ai-catalog\\.json|api-catalog)$|api/mcp/server-card$).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, proxy-revalidate' },
          { key: 'Surrogate-Control', value: 'no-store' },
        ],
      },
      // Каталог API по RFC 9727 (ступень 3, 12.10): заголовок Link на главной
      // ведёт агента к /.well-known/api-catalog — там описание OpenAPI, карточка
      // MCP и визитки A2A одним linkset. Относительная ссылка — по RFC 8288
      // разрешается относительно запроса. Сторож: tests/unit/openapi-agents.test.ts.
      {
        source: '/',
        headers: [{ key: 'Link', value: '</.well-known/api-catalog>; rel="api-catalog"' }],
      },
      // Китайский раздел (аудит 15.10, CN-quick): корневой <html lang="ru">
      // общий для всех страниц и не трогается (читать язык из запроса в корне
      // сделало бы динамическими все страницы), поэтому язык /zh объявлен
      // заголовком и meta http-equiv в app/zh/layout.tsx. Значение — то же, что
      // ZH_CONTENT_LANGUAGE в lib/zh/pages. Одно правило на /zh и /zh/<…>:
      // `:path*` — ноль и больше сегментов, сам /zh оно тоже покрывает (второе
      // правило на /zh поставило бы тот же заголовок дважды), а /zhuk — нет.
      // Сторож — сопоставлением путей матчером Next: tests/unit/china-quick.test.ts.
      {
        source: '/zh/:path*',
        headers: [{ key: 'Content-Language', value: 'zh-CN' }],
      },
      // Английский раздел — тот же сигнал, что у /zh (19.10): вдобавок к
      // <html lang="en">, который теперь ставит корневой layout по первому
      // сегменту (lib/i18n/root-lang, заголовок пути от middleware).
      {
        source: '/en/:path*',
        headers: [{ key: 'Content-Language', value: 'en' }],
      },
      {
        source: '/widget/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: `default-src 'self'; script-src 'self' 'unsafe-inline'${DEV_EVAL}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.yandex.ru; font-src 'self' data:; frame-ancestors *;` },
        ],
      },
      {
        source: '/:path((?!widget/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // ЗАФИКСИРОВАННЫЙ КОМПРОМИСС (аудит 11.07, P2): 'unsafe-inline' в
          // script-src/style-src оставлен сознательно. Next.js App Router
          // инлайнит бутстрап-скрипты и RSC-payload, Tailwind/next/font — инлайн
          // стили; убрать 'unsafe-inline' без nonce-конвейера = сломать гидрацию.
          // Честный апгрейд — nonce через middleware (next docs: CSP with nonces),
          // но middleware у нас Edge JWT + rate-limit (§7 CLAUDE.md, не трогать
          // без отдельного решения). Ужесточать только вместе с этим решением.
          { key: 'Content-Security-Policy', value: `default-src 'self'; script-src 'self' 'unsafe-inline'${DEV_EVAL} https://api-maps.yandex.ru https://*.yandex.ru https://mc.yandex.ru https://unpkg.com https://telegram.org; style-src 'self' 'unsafe-inline' https://*.yandex.ru https://unpkg.com; frame-src 'self' https://oauth.telegram.org https://web.telegram.org https://t.me; img-src 'self' data: https: blob:; connect-src 'self' https://*.yandex.ru https://*.yandex.net https://mc.yandex.ru https://mc.yandex.md wss://mc.yandex.ru https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://tile.opentopomap.org https://*.tile.opentopomap.org https://s3.twcstorage.ru https://web.telegram.org https://oauth.telegram.org; font-src 'self' data: https://*.yandex.ru; worker-src 'self' blob:; child-src 'self' blob:; media-src 'self' https://s3.twcstorage.ru;` },
          // worker-src (01.09): MapLibre GL поднимает воркеры из blob:-URL
          // собственного бандла. Без явного worker-src браузер берёт
          // default-src 'self' и запрещает blob: — воркера нет, тайлы не
          // парсятся, событие load не наступает, а error MapLibre при этом не
          // стреляет: на телефоне владельца карта молчала чёрным полем. В
          // middleware.ts worker-src уже был, но его matcher не покрывает
          // /planning — на этой странице заголовок ставит именно этот файл.
          // child-src — тот же смысл для Safari до 15.5.
          // media-src (09.10): ролики перевозчиков живут в хранилище
          // (lib/media/video-manifest). Без явного media-src браузер берёт
          // default-src 'self' и не играет ролик с чужого хоста — тихо,
          // чёрным кадром. Обложки — картинки, им хватает img-src https:.
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      },
      // Контентные фото меняются только новым файлом (нарезка — коммитом),
      // поэтому кэшируем надолго: повторный визит с поля не должен тянуть
      // те же мегабайты. По умолчанию Next отдаёт public/ вообще без
      // Cache-Control — каждый заход платил полную цену.
      {
        source: '/images/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, stale-while-revalidate=86400' },
        ],
      },
      // Кабинет закрыт от индекса целиком, кроме посадочной «Рыбалка»
      // (/hub/fishing, пункт шапки, в sitemap с 29.09). Раньше правило стояло
      // на '/hub/:path*': страница несла meta «index, follow» и заголовок
      // «noindex, nofollow» одновременно, а Google из двух берёт запрет —
      // лучшая коммерческая страница выпадала из его индекса (замер с раннера
      // 29.09, и Googlebot, и YandexBot получали заголовок). robots.txt тут ни
      // при чём: более длинное Allow: /hub/fishing перебивает Disallow: /hub/.
      // Сторож: tests/unit/seo-audit-2909-evening.test.ts.
      {
        source: '/hub',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      {
        source: '/hub/:path((?!fishing(?:/|$)).*)',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      // Публичный MCP (/api/mcp и его server-card) — витрина для ИИ-каталогов
      // и поисковиков, noindex с него снят. Остальное /api, включая
      // /api/mcp/partner, по-прежнему закрыто.
      {
        source: '/api/:path((?!mcp(?:/server-card)?$).*)',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
}

module.exports = nextConfig