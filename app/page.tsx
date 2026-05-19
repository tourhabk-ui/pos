import type { Metadata } from 'next'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Header } from '@/components/layout/Header'
import { HeroBoard } from '@/components/homepage/HeroBoard'
import { StatsBand } from '@/components/homepage/StatsBand'
import { BentoSection } from '@/components/homepage/BentoSection'
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

const ACTIVITIES = [
  { img: '/images/activities/volcanoes.jpg', label: 'Вулканы', href: '/routes?type=volcano' },
  { img: '/images/activities/helicopter.jpg', label: 'Вертолёт', href: '/routes?type=helicopter' },
  { img: '/images/activities/hotsprings.jpg', label: 'Источники', href: '/routes?type=hot_spring' },
  { img: '/images/activities/fishing.jpg', label: 'Рыбалка', href: '/routes?type=fishing' },
  { img: '/images/activities/rafting.jpg', label: 'Рафтинг', href: '/routes?type=water' },
  { img: '/images/activities/jeep.jpg', label: 'Джип-туры', href: '/routes?type=jeep' },
  { img: '/images/activities/dogsled.jpg', label: 'Собаки', href: '/routes?type=winter' },
  { img: '/images/activities/sea.jpg', label: 'Океан', href: '/routes?type=sea' },
  { img: '/images/activities/snowmobile.jpg', label: 'Снегоход', href: '/routes?type=snowmobile' },
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

        {/* Bento photo grid */}
        <BentoSection />

        {/* Activities horizontal scroll */}
        <section className="border-t border-[var(--border)] bg-[var(--bg-card)]">
          <div className="max-w-7xl mx-auto px-4 md:px-8 py-10">
            <p className="text-[11px] uppercase tracking-[0.3em] text-[var(--text-muted)] font-semibold mb-6">
              Активности
            </p>
            <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-none -mx-4 px-4 md:mx-0 md:px-0">
              {ACTIVITIES.map(({ img, label, href }) => (
                <Link
                  key={label}
                  href={href}
                  className="group flex-shrink-0 relative overflow-hidden rounded-lg"
                  style={{ width: 120, height: 140 }}
                >
                  <img
                    src={img}
                    alt={label}
                    className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                  <span className="absolute bottom-3 left-0 right-0 text-center text-[11px] font-bold text-white tracking-wide">
                    {label}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* AI-консьерж + карта */}
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch px-4 md:px-8 py-14">
          <MessengerAgentsSection />
          <div className="min-h-[420px] rounded-lg overflow-hidden border border-[var(--border)]">
            <HomeMapPreview />
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
