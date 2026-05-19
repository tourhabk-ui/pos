import type { Metadata } from 'next'
import dynamic from 'next/dynamic'
import { Header } from '@/components/layout/Header'
import { HeroBoard } from '@/components/homepage/HeroBoard'
import { StatsBand } from '@/components/homepage/StatsBand'
import { EditorialSection } from '@/components/homepage/EditorialSection'
import { BentoSection } from '@/components/homepage/BentoSection'
import { MessengerAgentsSection } from '@/components/homepage/MessengerAgentsSection'
import { Footer } from '@/components/layout/Footer'
import { OnSiteBanner } from '@/components/geo/OnSiteBanner'

const HomeBottomNav = dynamic(
  () => import('@/components/homepage/HomeBottomNav').then(m => ({ default: m.HomeBottomNav }))
);
const HomeMapPreview = dynamic(
  () => import('@/components/homepage/HomeMapPreview').then(m => ({ default: m.HomeMapPreview }))
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

export default async function Page() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <OnSiteBanner />
      <main className="flex-1">

        {/* Full-bleed hero */}
        <HeroBoard />

        {/* Stats — static grid, no animation overhead */}
        <StatsBand />

        {/* Editorial strip: "Штурман, а не тур-агент" */}
        <EditorialSection />

        {/* Category photo bento */}
        <BentoSection />

        {/* Kuzmich — full-width editorial split */}
        <MessengerAgentsSection />

        {/* Map preview — lazy, full-width */}
        <div className="border-t border-[var(--border)] h-[380px] md:h-[440px]">
          <HomeMapPreview />
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
