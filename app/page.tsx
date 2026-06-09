import type { Metadata } from 'next'
import loadDynamic from 'next/dynamic'
import { Header } from '@/components/layout/Header'
import { HeroPersonalized } from '@/components/homepage/HeroPersonalized'
import { StoriesRail } from '@/components/homepage/StoriesRail'
import { TravelerCard } from '@/components/homepage/TravelerCard'
import { LiveOnTrails } from '@/components/homepage/LiveOnTrails'
import { StatsBand } from '@/components/homepage/StatsBand'
import { KuzmichBriefing } from '@/components/homepage/KuzmichBriefing'
import { BentoSection } from '@/components/homepage/BentoSection'
import { EditorialSection } from '@/components/homepage/EditorialSection'
import { MessengerAgentsSection } from '@/components/homepage/MessengerAgentsSection'
import { Footer } from '@/components/layout/Footer'
import { OnSiteBanner } from '@/components/geo/OnSiteBanner'
import { HomeMapPreviewLazy } from '@/components/homepage/HomeMapPreviewLazy'
import { SectionErrorBoundary } from '@/components/shared/SectionErrorBoundary'

export const dynamic = 'force-dynamic'

const BottomNav = loadDynamic(() => import('@/components/shared/BottomNav'));
const SOSButton = loadDynamic(() => import('@/components/shared/SOSButton'));

export const metadata: Metadata = {
  title: 'Ведар — помощник и планировщик путешествия по Камчатке',
  description: 'Ведар помогает спланировать честное и безопасное путешествие по Камчатке.',
  openGraph: {
    title: 'Ведар — Туры на Камчатку',
    description: 'Маршруты, советы, Кузьмич, проверенные операторы.',
    images: [{ url: '/images/hero/hero-light.jpeg', width: 1200, height: 630, alt: 'Камчатка' }],
    type: 'website', locale: 'ru_RU', siteName: 'Ведар',
  },
  twitter: { card: 'summary_large_image', title: 'Ведар', images: ['/images/hero/hero-light.jpeg'] },
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
}

export default async function Page() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <OnSiteBanner />
      <main className="flex-1 pt-[56px]">

        {/* Personalized hero — greeting + weather + CTA */}
        <HeroPersonalized />

        {/* Stories rail */}
        <StoriesRail />

        {/* Featured traveler story */}
        <TravelerCard />

        {/* Social proof + style badge */}
        <LiveOnTrails />

        {/* Kuzmich live briefing — weather + alerts + route picks */}
        <SectionErrorBoundary>
          <KuzmichBriefing />
        </SectionErrorBoundary>

        {/* Stats marquee */}
        <StatsBand />

        {/* Explore by element — 6 categories */}
        <BentoSection />

        {/* Editorial strip */}
        <EditorialSection />

        {/* Kuzmich channels */}
        <MessengerAgentsSection />

        {/* Map preview — lazy, full-width */}
        <SectionErrorBoundary>
          <div className="border-t border-[var(--border)] h-[380px] md:h-[440px]">
            <HomeMapPreviewLazy />
          </div>
        </SectionErrorBoundary>

      </main>
      <div className="lg:block pb-[80px] lg:pb-0">
        <Footer />
      </div>
      <BottomNav activePath="/" />
      <div className="hidden md:block">
        <SOSButton />
      </div>
    </div>
  );
}
