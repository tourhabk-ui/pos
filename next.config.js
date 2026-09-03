/** @type {import('next').NextConfig} */
// ТОЛЬКО dev: вебпак в next dev собирает чанки через eval (eval-source-map),
// и CSP без 'unsafe-eval' молча роняла клиентский чанк с PageViewTracker —
// локально page_views не писались вовсе, разработка была «слепа» (находка
// сквозного прогона 14.08, задача #59). В production строка пустая: прод-CSP
// не ослабляется ни на символ.
const DEV_EVAL = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,

  experimental: {
    serverActions: {
      bodySizeLimit: '60mb',
    },
  },

  // outputFileTracingRoot removed — may prevent standalone output

  // pdfkit читает AFM-шрифты своего пакета при создании документа —
  // без include standalone-трассировка может их потерять, и любой PDF
  // падает с ENOENT (~1 МБ данных, лимит 50 МБ не задевает)
  outputFileTracingIncludes: {
    '/api/**': ['./node_modules/pdfkit/js/data/**'],
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
      { source: '/emergency.html',      destination: '/emergency',                       permanent: true },
      { source: '/fishingkam',          destination: '/operators/kamchatskaya-rybalka',  permanent: true },
      // Листинг операторов канонический на /operators: после SSR (шаг 3, #460)
      // дубли отдавали идентичный контент и каннибалили бы друг друга в индексе.
      // marketplace-вариант — до общего :path*-правила, чтобы редирект был одним хопом.
      { source: '/marketplace/operators', destination: '/operators',                    permanent: true },
      { source: '/catalog/operators',  destination: '/operators',                      permanent: true },
      { source: '/marketplace/:path*', destination: '/catalog/:path*',                 permanent: true },
      { source: '/marketplace',        destination: '/catalog',                        permanent: true },
      { source: '/tours',              destination: '/catalog',                        permanent: true },
      { source: '/terms',              destination: '/legal/terms',                    permanent: true },
      { source: '/auth/register',      destination: '/operators/join',                 permanent: false },
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
      // /home-v7 — dev-превью новой главной (noindex, без ссылок). Реорг Этап 2:
      // код переехал в app/_home/ (приватная папка, не роут), роут /home-v7 убран.
      // 301 на / — страховка от старых закладок на превью.
      { source: '/home-v7',            destination: '/',                               permanent: true },
      // /dashboard — осиротевший «командный центр», перекрыт Главной v8 (реорг
      // Этап 9). Раньше страница делала runtime redirect('/') (307); постоянный
      // 301 здесь — SEO-корректно и убирает stub-роут. _DashboardClient сохранён.
      { source: '/dashboard',          destination: '/',                               permanent: true },
    ];
  },

  async headers() {
    return [
      // HTML-страницы не должны кэшироваться на CDN/прокси —
      // «статус дня» и персональные данные не должны отдаваться из edge-кэша
      {
        source: '/((?!_next/static|_next/image|icons|images|favicon).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, proxy-revalidate' },
          { key: 'Surrogate-Control', value: 'no-store' },
        ],
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
          { key: 'Content-Security-Policy', value: `default-src 'self'; script-src 'self' 'unsafe-inline'${DEV_EVAL} https://api-maps.yandex.ru https://*.yandex.ru https://mc.yandex.ru https://unpkg.com https://emrldco.com; style-src 'self' 'unsafe-inline' https://*.yandex.ru https://unpkg.com; img-src 'self' data: https: blob:; connect-src 'self' https://*.yandex.ru https://*.yandex.net https://mc.yandex.ru https://mc.yandex.md wss://mc.yandex.ru https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://tile.opentopomap.org https://*.tile.opentopomap.org https://s3.twcstorage.ru https://emrldco.com; font-src 'self' data: https://*.yandex.ru; worker-src 'self' blob:; child-src 'self' blob:;` },
          // worker-src (01.09): MapLibre GL поднимает воркеры из blob:-URL
          // собственного бандла. Без явного worker-src браузер берёт
          // default-src 'self' и запрещает blob: — воркера нет, тайлы не
          // парсятся, событие load не наступает, а error MapLibre при этом не
          // стреляет: на телефоне владельца карта молчала чёрным полем. В
          // middleware.ts worker-src уже был, но его matcher не покрывает
          // /planning — на этой странице заголовок ставит именно этот файл.
          // child-src — тот же смысл для Safari до 15.5.
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
      {
        source: '/hub/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
}

module.exports = nextConfig