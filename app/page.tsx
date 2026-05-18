import type { Metadata } from 'next'
import dynamic from 'next/dynamic'
import { Bot, Map, BadgeCheck, ShieldCheck } from 'lucide-react'
import { Header } from '@/components/layout/Header'
import { HeroBoard } from '@/components/homepage/HeroBoard'
import { StatsBand } from '@/components/homepage/StatsBand'
import { HomeMapPreview } from '@/components/homepage/HomeMapPreview'
import { MessengerAgentsSection } from '@/components/homepage/MessengerAgentsSection'
import { Footer } from '@/components/layout/Footer'
import { OnSiteBanner } from '@/components/geo/OnSiteBanner'

const HomeBottomNav = dynamic(
  () => import('@/components/homepage/HomeBottomNav').then(m => ({ default: m.HomeBottomNav }))
);
const SOSButton = dynamic(() => import('@/components/shared/SOSButton'));

export const metadata: Metadata = {
  title: 'TourHab — помощник и планировщик путешествия по Камчатке',
  description: 'TourHab помогает спланировать честное и безопасное путешествие по Камчатке.',
  openGraph: {
    title: 'TourHab — Туры на Камчатку',
    description: 'Маршруты, советы, Кузьмич, проверенные операторы.',
    images: [{ url: '/images/hero/hero-light.jpeg', width: 1200, height: 630, alt: 'Камчатка' }],
    type: 'website', locale: 'ru_RU', siteName: 'TourHab',
  },
  twitter: { card: 'summary_large_image', title: 'TourHab', images: ['/images/hero/hero-light.jpeg'] },
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
}

const FEATURES = [
  {
    icon: Bot,
    title: 'AI-планировщик',
    desc: 'Подберёт маршрут по вашим интересам и бюджету за минуты',
  },
  {
    icon: Map,
    title: 'Живая карта',
    desc: '778 мест и 294 маршрута с реальными координатами',
  },
  {
    icon: BadgeCheck,
    title: 'Проверенные операторы',
    desc: 'Только партнёры с реальными лицензиями и отзывами',
  },
  {
    icon: ShieldCheck,
    title: 'Безопасность',
    desc: 'SOS, статус вулканов KVERT, погода и актуальные предупреждения',
  },
];

export default async function Page() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <OnSiteBanner />
      <main className="flex-1">

        {/* Full-bleed hero */}
        <HeroBoard />

        {/* Stats marquee */}
        <StatsBand />

        {/* AI-консьерж + карта */}
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch px-4 md:px-8 py-12">
          <MessengerAgentsSection />
          <div className="min-h-[380px] rounded-lg overflow-hidden border border-[var(--border)]">
            <HomeMapPreview />
          </div>
        </div>

        {/* Почему TourHab */}
        <div className="max-w-7xl mx-auto px-4 md:px-8 pb-20">
          <h2 className="font-playfair text-3xl md:text-4xl font-bold text-center text-[var(--text-primary)] mb-2">
            Почему TourHab
          </h2>
          <p className="text-center text-[var(--text-secondary)] text-sm mb-10">
            Инструмент для путешественника, а не витрина туров
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="ds-card p-6 flex flex-col items-center text-center group hover:-translate-y-1 transition-all duration-200"
              >
                <div className="w-12 h-12 mb-4 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center group-hover:bg-[var(--accent)]/20 transition-colors duration-200">
                  <Icon size={22} className="text-[var(--accent)]" />
                </div>
                <p className="text-sm font-bold text-[var(--text-primary)] mb-1.5">{title}</p>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>

      </main>
      <Footer />
      <div className="md:hidden">
        <HomeBottomNav />
      </div>
      <SOSButton />
    </div>
  );
}
