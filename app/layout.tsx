import { Metadata, Viewport } from 'next';
import { Inter, Playfair_Display, Manrope, JetBrains_Mono, Unbounded } from 'next/font/google';
import { defaultOgImages } from '@/lib/seo/og-image';

const playfairDisplay = Playfair_Display({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-playfair',
});

// Редизайн v8: Unbounded — смелые заголовки главной (жирный геометрический дисплей).
// Само-хостинг через next/font (не Google-CDN <link>), правило §2 соблюдено.
const unbounded = Unbounded({
  subsets: ['latin', 'cyrillic'],
  weight: ['500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-unbounded',
});

// Редизайн v7 «Воронка»: Manrope — текст, JetBrains Mono — метки/цифры/координаты.
// Само-хостинг на билде через next/font (не Google-CDN <link>), правило §2 соблюдено.
const manrope = Manrope({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-manrope',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin', 'cyrillic'],
  weight: ['300', '400', '500'],
  display: 'swap',
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
  themeColor: '#0f172a',
};

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'Ведар — помощник и планировщик путешествия по Камчатке',
    template: '%s | Ведар',
  },
  description: 'Ведар помогает честно и безопасно спланировать поездку по Камчатке: маршруты, карта, AI-помощник Кузьмич, поддержка и реальные туры от проверенных операторов.',
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
  authors: [{ name: 'Ведар' }],
  creator: 'Ведар',
  publisher: 'Ведар',
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
    siteName: 'Ведар',
    title: 'Ведар — помощник по Камчатке',
    description: 'Помощник, планировщик и безопасный проводник к реальным турам по Камчатке.',
    // Та же картинка, что подставляют страницы со своим openGraph: Next
    // заменяет openGraph страницы целиком, и наследования отсюда у них нет.
    images: defaultOgImages(),
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Ведар — помощник по Камчатке',
    description: 'Помогаем спланировать маршрут и выйти на реальный тур без обманов и серых схем.',
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
  applicationName: 'Ведар',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Ведар',
  },
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION,
    yandex: process.env.YANDEX_VERIFICATION,
    other: {
      'travelpayouts-verification': '2aafzv6xt87m06rb',
    },
  },
}

import './globals.css'
import React from 'react'
import { Providers } from '@/components/Providers'
// Метрика, Clarity и TP Drive больше не монтируются поштучно и безусловно:
// состав и право на загрузку решает lib/legal/third-party-registry, а данные
// не уходят раньше согласия посетителя (разбор права 11.09, docs/LEGAL.md).
import ThirdPartyScripts from '@/components/legal/ThirdPartyScripts'
import StickyLeadButton from '@/components/shared/StickyLeadButton'
import KuzmichWidget from '@/components/kuzmich/KuzmichWidget'
import { InstallPrompt } from '@/components/PWA/InstallPrompt'
import { themeBootScript } from '@/lib/theme'
import { InstallTracker } from '@/components/PWA/InstallTracker'
import { ServiceWorkerRegistrar } from '@/components/PWA/ServiceWorkerRegistrar'
import { OfflineBanner } from '@/components/PWA/OfflineBanner'
import { GlobalSearchModal } from '@/components/search/GlobalSearchModal'
import { LastPositionTracker } from '@/components/tracking/LastPositionTracker'
import { ReferralCapture } from '@/components/shared/ReferralCapture'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
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
        <link rel="dns-prefetch" href="//www.clarity.ms" />
        <link rel="dns-prefetch" href="//emrldco.com" />
        <link rel="dns-prefetch" href="//tile.openstreetmap.org" />
        <link rel="preconnect" href="https://mc.yandex.ru" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://www.clarity.ms" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://tile.openstreetmap.org" crossOrigin="anonymous" />
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <link rel="shortcut icon" href="/favicon.ico" />
      </head>
      <body className={`min-h-screen transition-colors duration-300 ${inter.className} ${playfairDisplay.variable} ${inter.variable} ${manrope.variable} ${jetbrainsMono.variable} ${unbounded.variable}`}>
        <Providers>
          <OfflineBanner />
          {children}
          <GlobalSearchModal />
          <LastPositionTracker />
          {/* Приглашение приземляется на любую страницу, не только на главную. */}
          <ReferralCapture />
        </Providers>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([
              {
                "@context": "https://schema.org",
                "@type": "WebSite",
                "name": "Ведар — помощник по Камчатке",
                "url": BASE_URL,
                "description": "Сервис планирования путешествий по Камчатке: маршруты, карта, безопасность, AI-помощник и реальные туры от проверенных операторов.",
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
              // Реквизиты — те же, что на /about. sameAs — живой канал
              // платформы; vk.com/kamchatourhub отвечал 404, а
              // t.me/kamchatourhub — канал старого имени с одним подписчиком.
              {
                "@context": "https://schema.org",
                "@type": "Organization",
                "@id": `${BASE_URL}/#organization`,
                "name": "Ведар",
                "legalName": "ООО «ПОС-СЕРВИС»",
                "taxID": "4101147649",
                "description": "Туристическая платформа Камчатки: места и маршруты, офлайн-карта, сводка обстановки, помощник Кузьмич и туры местных операторов.",
                "url": BASE_URL,
                "logo": `${BASE_URL}/icons/icon-512.png`,
                "email": "info@vedarai.ru",
                "telephone": "+7 (914) 782-22-22",
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
                  "https://t.me/kamchatka_real"
                ]
              }
            ])
          }}
        />
        <ThirdPartyScripts />
        <StickyLeadButton />
        <KuzmichWidget />
        <InstallPrompt />
        <InstallTracker />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  )
}

