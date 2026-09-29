import { Metadata, Viewport } from 'next';
import { Inter, Playfair_Display, Manrope, JetBrains_Mono, Unbounded } from 'next/font/google';

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
    images: [
      {
        url: '/images/hero/hero-light.jpeg',
        width: 1200,
        height: 630,
        alt: 'Ведар — Туры на Камчатку',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Ведар — помощник по Камчатке',
    description: 'Помогаем спланировать маршрут и выйти на реальный тур без обманов и серых схем.',
    images: ['/images/hero/hero-light.jpeg'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
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
                "potentialAction": {
                  "@type": "SearchAction",
                  "target": {
                    "@type": "EntryPoint",
                    "urlTemplate": `${BASE_URL}/routes?q={search_term_string}`
                  },
                  "query-input": "required name=search_term_string"
                }
              },
              {
                "@context": "https://schema.org",
                "@type": "TouristInformationCenter",
                "name": "Ведар",
                "description": "Помощник, планировщик и путеводитель по Камчатке с доступом к реальным турам проверенных операторов.",
                "url": BASE_URL,
                "logo": `${BASE_URL}/logo-kamchatka.svg`,
                "address": {
                  "@type": "PostalAddress",
                  "addressCountry": "RU",
                  "addressRegion": "Камчатский край",
                  "addressLocality": "Петропавловск-Камчатский"
                },
                "geo": {
                  "@type": "GeoCoordinates",
                  "latitude": 53.0444,
                  "longitude": 158.6483
                },
                "telephone": "+7 (914) 782-22-22",
                "speakable": {
                  "@type": "SpeakableSpecification",
                  "cssSelector": ["h1", "h2", ".ds-h1", ".ds-h2", "article p:first-of-type", "[data-speakable]"]
                },
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
                  "https://t.me/kamchatourhub",
                  "https://vk.com/kamchatourhub"
                ]
              },
              {
                "@context": "https://schema.org",
                "@type": "LocalBusiness",
                "@id": `${BASE_URL}/#localbusiness`,
                "name": "Ведар",
                "description": "Туристический сервис Камчатки: маршруты, планирование поездки, поддержка и честные предложения реальных туров.",
                "url": BASE_URL,
                "logo": `${BASE_URL}/logo-kamchatka.svg`,
                "telephone": "+7 (914) 782-22-22",
                "email": "info@vedarai.ru",
                "address": {
                  "@type": "PostalAddress",
                  "addressCountry": "RU",
                  "addressRegion": "Камчатский край",
                  "addressLocality": "Петропавловск-Камчатский"
                },
                "geo": {
                  "@type": "GeoCoordinates",
                  "latitude": 53.0444,
                  "longitude": 158.6483
                },
                "priceRange": "$$",
                "openingHoursSpecification": {
                  "@type": "OpeningHoursSpecification",
                  "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],
                  "opens": "00:00",
                  "closes": "23:59"
                },
                "sameAs": [
                  "https://t.me/kamchatourhub",
                  "https://vk.com/kamchatourhub"
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

