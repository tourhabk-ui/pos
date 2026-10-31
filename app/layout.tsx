import { Metadata, Viewport } from 'next';
import { Inter, Playfair_Display, JetBrains_Mono } from 'next/font/google';
import { defaultOgImages } from '@/lib/seo/og-image';
import { REQUISITES } from '@/lib/legal/requisites';
import { siteVerification } from '@/lib/seo/site-verification';
import { headers } from 'next/headers';
import { htmlLangForPath, ROOT_LANG_HEADER } from '@/lib/i18n/root-lang';
import { partnerSiteOfRequest } from '@/lib/partner-sites/request';

const playfairDisplay = Playfair_Display({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-playfair',
});

/*
 * Шрифты — по §2: Playfair Display (заголовки) и Inter под переменной
 * --font-outfit (текст). JetBrains Mono (--font-jetbrains) — табло радара
 * угроз на /safety. С главной и карточки тура моноширинные метки сняты 31.10:
 * шаблонная обвязка (tests/unit/no-template-chrome.test.tsx).
 *
 * Unbounded и Manrope (редизайны v7/v8) сняты 01.10: переменные
 * --font-unbounded и --font-manrope не читал ни один стиль, а preload
 * скачивал четыре их файла на КАЖДОЙ странице — из 12 предзагрузок треть
 * была мёртвым весом (аудит vedarai.ru 01.10). Сторож:
 * tests/unit/fonts-have-consumers.test.ts.
 *
 * Preload только у шрифтов, которые читает каждая страница. JetBrains Mono
 * нужен одному экрану — без preload браузер скачает его там, где он
 * встретился в стилях, и нигде больше (display: swap — текст не ждёт).
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  weight: ['300', '400', '500'],
  display: 'swap',
  preload: false,
  variable: '--font-jetbrains',
});

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-outfit', // переменная сохранена для обратной совместимости
});

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  /**
   * Цвет строки состояния. Место у него ровно одно — здесь.
   *
   * До 08.09 он был задан ДВАЖДЫ и оба раза мимо: `themeColor` в объекте
   * metadata (Next 15 такое поле там не поддерживает и на каждой загрузке
   * страницы пишет об этом в консоль) и ручной <meta> в <head>. Ручной тег
   * работал, предупреждение шло — и разбирающий консоль видел шум, за
   * которым легко пропустить настоящую ошибку.
   */
  themeColor: '#003580',
};

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'Ведар Камчатка — информационный портал о Камчатке',
    template: '%s | Ведар',
  },
  description: 'Ведар Камчатка — информационный портал о Камчатке, не турагентство и не туроператор: маршруты, карта, AI-помощник Кузьмич и туры местных операторов.',
  keywords: [
    'туры на Камчатку',
    'рыбалка Камчатка',
    'вулканы Камчатки',
    'Долина гейзеров',
    'горячие источники Камчатка',
    'Ключевская сопка',
    'Мутновский вулкан',
    'Курильское озеро',
    'Кальдера Узон',
    'отдых на Камчатке',
    'экскурсии Камчатка',
    'Халактырский пляж',
    'медведи Камчатка',
    'чавыча рыбалка',
    'кижуч нерка',
    'Петропавловск-Камчатский',
    'места силы Камчатка',
    'ительмены шаман',
    'Ксудач кальдера',
    'природные парки Камчатки',
    'Кроноцкий заповедник',
    'ЮНЕСКО вулканы',
    'экотуризм Камчатка',
    'helicopter tour Kamchatka',
    'Kamchatka volcano tour',
    'Kamchatka travel',
  ],
  authors: [{ name: 'Ведар Камчатка' }],
  creator: 'Ведар Камчатка',
  publisher: 'Ведар Камчатка',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  openGraph: {
    type: 'website',
    locale: 'ru_RU',
    // Без url: его наследовала каждая страница без своего openGraph, и 22
    // адреса sitemap (/planner, /safety, /register…) говорили соцсетям и
    // поиску «я — главная» (аудит SEO 29.09, Н14). og:url ставит сама страница.
    siteName: 'Ведар Камчатка',
    title: 'Ведар Камчатка — информационный портал',
    description: 'Информационный портал о Камчатке: маршруты, безопасность и туры местных операторов. Не турагентство.',
    // Та же картинка, что подставляют страницы со своим openGraph: Next
    // заменяет openGraph страницы целиком, и наследования отсюда у них нет.
    images: defaultOgImages(),
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Ведар Камчатка — информационный портал',
    description: 'Информационный портал о Камчатке: маршруты, безопасность и туры местных операторов.',
    images: defaultOgImages().map((i) => i.url),
  },
  // index/follow по умолчанию и так разрешены — явное «index, follow» здесь
  // наследовала каждая страница, и на «не найдено» рядом с noindex от Next
  // выходили ДВА meta robots. Яндекс при таком сочетании выбирает
  // разрешающий и индексирует пустышку (аудит SEO 29.09, Н2). Страница, которой
  // нужно явное разрешение, ставит его сама.
  robots: {
    googleBot: {
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  manifest: '/manifest.json',
  applicationName: 'Ведар Камчатка',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Ведар Камчатка',
  },
  // Google, Яндекс и Bing (тег владельца 15.10) — одним блоком из
  // lib/seo/site-verification: убранный тег стоит подтверждения в вебмастере.
  verification: siteVerification(),
}

import './globals.css'
import React from 'react'
import { Providers } from '@/components/Providers'
// Метрика, Clarity и TP Drive больше не монтируются поштучно и безусловно:
// состав и право на загрузку решает lib/legal/third-party-registry, а данные
// не уходят раньше согласия посетителя (разбор права 11.09, docs/LEGAL.md).
import ThirdPartyScripts from '@/components/legal/ThirdPartyScripts'
import HubKuzmich from '@/components/kuzmich/HubKuzmich'
import { InstallPrompt } from '@/components/PWA/InstallPrompt'
import { themeBootScript } from '@/lib/theme'
import { InstallTracker } from '@/components/PWA/InstallTracker'
import { ServiceWorkerRegistrar } from '@/components/PWA/ServiceWorkerRegistrar'
import { OfflineBanner } from '@/components/PWA/OfflineBanner'
import { GlobalSearchModal } from '@/components/search/GlobalSearchModal'
import { LastPositionTracker } from '@/components/tracking/LastPositionTracker'
import { ReferralCapture } from '@/components/shared/ReferralCapture'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Язык документа — по первому сегменту пути (lib/i18n/root-lang): /en/* —
  // английский, /zh/* — китайский, всё остальное — русский. Путь сообщает
  // middleware заголовком; нет заголовка — русский, прежнее поведение.
  // Цена решения известна и принята (вариант А, 19.10): чтение заголовков в
  // корневом layout делает страницы рендером-на-запрос; HTML у нас и так
  // отдаётся с no-store, а публичные страницы в массе force-dynamic или ISR
  // по запросу. Прежде (аудит 15.10) ради статики держали lang="ru" везде и
  // объявляли язык раздела только заголовком Content-Language — теперь
  // корректный <html lang> важнее, заголовки разделов при этом сохранены.
  const requestHeaders = await headers();
  const lang = htmlLangForPath(requestHeaders.get(ROOT_LANG_HEADER));
  // Сайт партнёра на его домене (fishingkam.ru, 22.10): разметка «Ведар —
  // организация, сайт vedarai.ru» на чужом домене приписала бы сайт партнёра
  // Ведару. Свою разметку организации ставит сама страница партнёра.
  const onPartnerSite = partnerSiteOfRequest(requestHeaders) !== null;
  return (
    <html lang={lang} suppressHydrationWarning>
      <head>
        {/* Анти-вспышка темы: красим <html> до отрисовки. Умолчание и ключ —
            lib/theme.ts, те же, что у ThemeProvider (решение владельца 24.09:
            светлая); сохранённый выбор пользователя (kh-theme) имеет приоритет. */}
        <script
          dangerouslySetInnerHTML={{
            __html: themeBootScript(),
          }}
        />
        <link rel="dns-prefetch" href="//mc.yandex.ru" />
        <link rel="dns-prefetch" href="//tile.openstreetmap.org" />
        <link rel="preconnect" href="https://mc.yandex.ru" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://tile.openstreetmap.org" crossOrigin="anonymous" />
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <link rel="shortcut icon" href="/favicon.ico" />
      </head>
      <body className={`min-h-screen transition-colors duration-300 ${inter.className} ${playfairDisplay.variable} ${inter.variable} ${jetbrainsMono.variable}`}>
        <Providers>
          <OfflineBanner />
          {children}
          <GlobalSearchModal />
          <LastPositionTracker />
          {/* Приглашение приземляется на любую страницу, не только на главную. */}
          <ReferralCapture />
        </Providers>
        {!onPartnerSite && <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([
              {
                "@context": "https://schema.org",
                "@type": "WebSite",
                "name": "Ведар Камчатка",
                "url": BASE_URL,
                "description": "Информационный портал о Камчатке: маршруты, карта, безопасность, AI-помощник и туры местных операторов. Не турагентство и не туроператор.",
                "inLanguage": "ru",
                "publisher": { "@id": `${BASE_URL}/#organization` },
                "potentialAction": {
                  "@type": "SearchAction",
                  "target": {
                    "@type": "EntryPoint",
                    "urlTemplate": `${BASE_URL}/routes?q={search_term_string}`
                  },
                  "query-input": "required name=search_term_string"
                }
              },
              // Организация, а не «местное заведение» (аудит 01.10). Прежде здесь
              // стояли TouristInformationCenter и LocalBusiness с часами
              // 00:00–23:59 семь дней в неделю и priceRange «$$»: офиса с
              // часами приёма у платформы нет, а цены — у туров операторов.
              // Реквизиты — те же, что в оферте и на /about. sameAs — живой канал
              // платформы; vk.com/kamchatourhub отвечал 404, а
              // t.me/kamchatourhub — канал старого имени с одним подписчиком.
              {
                "@context": "https://schema.org",
                "@type": "Organization",
                "@id": `${BASE_URL}/#organization`,
                "name": "Ведар Камчатка",
                // Полное имя, а не голое «Ведар»: короткое написание сталкивается
                // с чужими сущностями в поиске. Те же формы, что в шапке, MCP,
                // A2A и на /zh. Транслитерация 维达尔 оставлена, чтобы уже известное
                // написание вело сюда (владелец 14.10).
                "alternateName": ["Vedar Kamchatka", "Vedar 堪察加", "维达尔"],
                // Реквизиты — из единого источника lib/legal/requisites.
                "legalName": REQUISITES.shortName,
                "taxID": REQUISITES.inn,
                "description": "Информационный портал о Камчатке: места и маршруты, офлайн-карта, сводка обстановки, помощник Кузьмич и туры местных операторов. Не турагентство и не туроператор.",
                "url": BASE_URL,
                "logo": `${BASE_URL}/icons/icon-512.png`,
                "email": REQUISITES.emailSupport,
                "telephone": REQUISITES.phone,
                "address": {
                  "@type": "PostalAddress",
                  "addressCountry": "RU",
                  "addressRegion": "Камчатский край",
                  "addressLocality": "Петропавловск-Камчатский",
                  "postalCode": "683024"
                },
                "areaServed": "Камчатский край",
                "knowsAbout": [
                  "туры на Камчатку",
                  "вулканы Камчатки",
                  "рыбалка на Камчатке",
                  "Долина гейзеров",
                  "горячие источники",
                  "медведи Курильского озера",
                  "Ключевская сопка",
                  "Халактырский пляж",
                  "экотуризм Камчатки"
                ],
                "sameAs": [
                  "https://t.me/kamchatka_real",
                  "https://github.com/tourhabk-ui/pos",
                  "https://registry.modelcontextprotocol.io/v0.1/servers?search=ru.vedarai%2Fmcp",
                  "https://smithery.ai/servers/tourhabk/vedar",
                  // Владелец 24.10: «карт-бланш на продвижение» — открытые
                  // примеры подключения MCP и боты Кузьмича в Telegram и MAX.
                  "https://github.com/tourhabk-ui/vedar-mcp-examples",
                  "https://t.me/kuzmichai_bot",
                  "https://max.ru/id4101147649_bot"
                ]
              }
            ])
          }}
        />}
        <ThirdPartyScripts />
        <HubKuzmich />
        <InstallPrompt />
        <InstallTracker />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  )
}

