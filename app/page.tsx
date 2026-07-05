import type { Metadata } from 'next'
import loadDynamic from 'next/dynamic'
import { pool } from '@/lib/db-pool'
import { Header } from '@/components/layout/Header'
import { HeroStatus, type SafetyStatusData } from '@/components/homepage/HeroStatus'
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
import { MoodEntry } from '@/components/homepage/MoodEntry'
import { MobileDashboardHeader } from '@/components/homepage/MobileDashboardHeader'
import { MobileHeroDashboard } from '@/components/homepage/MobileHeroDashboard'
import { MobileAlertBanner } from '@/components/homepage/MobileAlertBanner'
import { MobileBentoDashboard } from '@/components/homepage/MobileBentoDashboard'
import { MobilePullToRefresh } from '@/components/shared/MobilePullToRefresh'

export const dynamic = 'force-dynamic'

const BottomNav = loadDynamic(() => import('@/components/shared/BottomNav'));
const SOSButton = loadDynamic(() => import('@/components/shared/SOSButton'));
const MobileOnboarding = loadDynamic(() => import('@/components/onboarding/MobileOnboarding'));

async function getSafetyStatus(): Promise<SafetyStatusData | null> {
  try {
    const [alertsRes, lastIngestRes] = await Promise.all([
      pool.query<{
        max_severity: string;
        active_count: string;
        top_title: string | null;
        top_type: string | null;
      }>(`
        SELECT
          COALESCE(MAX(severity), 0)::text AS max_severity,
          COUNT(*)::text                   AS active_count,
          (SELECT title FROM external_alerts
           WHERE expires_at > NOW()
           ORDER BY severity DESC, created_at DESC
           LIMIT 1)                        AS top_title,
          (SELECT alert_type FROM external_alerts
           WHERE expires_at > NOW()
           ORDER BY severity DESC, created_at DESC
           LIMIT 1)                        AS top_type
        FROM external_alerts
        WHERE expires_at > NOW()
      `),
      // Время последнего прогона cron safety-ingest.
      // MAX(created_at) по всем записям — включая истёкшие — показывает когда последний раз
      // данные реально обновлялись. Null = cron ни разу не запускался.
      pool.query<{ last_ingest: string | null }>(`
        SELECT MAX(created_at)::text AS last_ingest FROM external_alerts
      `),
    ]);

    const row = alertsRes.rows[0];
    const activeCount = parseInt(row?.active_count ?? '0');

    return {
      hasAlert: activeCount > 0,
      maxSeverity: parseInt(row?.max_severity ?? '0'),
      activeCount,
      topTitle: row?.top_title ?? null,
      topType: row?.top_type ?? null,
      dataUpdatedAt: lastIngestRes.rows[0]?.last_ingest ?? null,
      source: 'КБГС РАН',
    };
  } catch {
    return null;
  }
}

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
  const safety = await getSafetyStatus();
  const fetchedAt = new Date().toISOString();

  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <div className="hidden md:block">
        <Header />
      </div>
      <OnSiteBanner />
      <main className="flex-1 md:pt-[56px]">

        {/* Mobile: Field OS Dashboard — принудительно тёмная тема (data-theme
            переопределяет токены для потомков, см. globals.css), плавающий
            статус-бар + AI-hero + bento */}
        <div data-theme="dark" className="md:hidden relative flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)] pb-28">
          {/* Онбординг — один раз при первом визите (localStorage), учит long-press СОС */}
          <MobileOnboarding />
          <MobilePullToRefresh>
            <MobileDashboardHeader />
            <MobileHeroDashboard />
            {/* Активная тревога — заметный баннер, а не только строка в радаре */}
            <MobileAlertBanner safety={safety} />
            <SectionErrorBoundary>
              <MobileBentoDashboard />
            </SectionErrorBoundary>
          </MobilePullToRefresh>
        </div>

        {/* Desktop: текущий лейаут без изменений */}
        <div className="hidden md:block">

        {/* Hero — статус дня: уровень безопасности + поиск маршрута */}
        <HeroStatus safety={safety} fetchedAt={fetchedAt} />

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

        {/* Mood/vibe entry — emotional starting point */}
        <MoodEntry />

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

        </div>

      </main>
      {/* Футер — только desktop (CLAUDE.md §2); на мобильном дашборд завершается bento-сеткой */}
      <div className="hidden md:block">
        <Footer />
      </div>
      {/* data-theme=dark — нав на главной в тёмной теме дашборда (Field OS) */}
      <div data-theme="dark">
        <BottomNav activePath="/" />
      </div>
      <div className="hidden md:block">
        <SOSButton />
      </div>
    </div>
  );
}
