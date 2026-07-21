import type { Metadata } from 'next'
import loadDynamic from 'next/dynamic'
import { headers } from 'next/headers'
import { pool } from '@/lib/db-pool'
import { Header } from '@/components/layout/Header'
import { HeroStatus, type SafetyStatusData } from '@/components/homepage/HeroStatus'
import { StoriesRail } from '@/components/homepage/StoriesRail'
import { TravelerCard } from '@/components/homepage/TravelerCard'
import { LiveOnTrails } from '@/components/homepage/LiveOnTrails'
import { StatsBand, type PlatformStats } from '@/components/homepage/StatsBand'
import { KuzmichBriefing } from '@/components/homepage/KuzmichBriefing'
import { BentoSection } from '@/components/homepage/BentoSection'
import { EditorialSection } from '@/components/homepage/EditorialSection'
import { MessengerAgentsSection } from '@/components/homepage/MessengerAgentsSection'
import { Footer } from '@/components/layout/Footer'
import { OnSiteBanner } from '@/components/geo/OnSiteBanner'
import { HomeMapPreviewLazy } from '@/components/homepage/HomeMapPreviewLazy'
import { SectionErrorBoundary } from '@/components/shared/SectionErrorBoundary'
import { MoodEntry } from '@/components/homepage/MoodEntry'
import HomeV8Client from './home-v7/_HomeV8Client'
import { getHomeV8Data } from './home-v7/data'
import { getPlatformCounts } from '@/lib/stats/platform-counts'

export const dynamic = 'force-dynamic'

const SOSButton = loadDynamic(() => import('@/components/shared/SOSButton'));

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
  // Раньше оба дерева (мобайл v8 + десктоп-стек) рендерились и гидрировались на
  // ЛЮБОМ устройстве через CSS `hidden` — display:none прячет, но JS всё равно
  // качается и гидрируется. Теперь сервер по User-Agent рендерит ТОЛЬКО нужное
  // дерево: телефон не тянет десктоп-секции, десктоп не тянет v8. Страница уже
  // force-dynamic, так что UA читается на каждый запрос без проблем с кэшем.
  //
  // Боты — ВСЕГДА десктоп (SEO): Google/Yandex индексируют mobile-first, и лёгкое
  // v8-дерево лишило бы их editorial/stats/маршрутов — весь SSR-SEO Шага 3.
  // Неоднозначный UA → десктоп (безопасный дефолт: полный, SEO-богатый лейаут).
  const ua = (await headers()).get('user-agent') ?? '';
  const isBot = /bot|crawler|spider|googlebot|yandex|bingbot|duckduckbot|slurp|baiduspider|facebookexternalhit|telegram|whatsapp|twitterbot|applebot|petalbot/i.test(ua);
  const isPhone = /android|iphone|ipod|opera mini|iemobile|blackberry|webos|mobile safari/i.test(ua) && !/ipad|tablet/i.test(ua);
  const isMobile = isPhone && !isBot;

  // ── Мобильное дерево: только v8, только для телефонов ──────────────
  if (isMobile) {
    const homeData = await getHomeV8Data();
    return (
      <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
        <OnSiteBanner />
        <main className="flex-1">
          {/* Новая Главная v8 «Воронка» — фото-герой, радар безопасности,
              карусель, стеклянные «Стихии», реальная сейсмика. Своя навигация и SOS. */}
          <HomeV8Client data={homeData} />
        </main>
      </div>
    );
  }

  // ── Десктоп-дерево (и все боты/SEO): единый источник цифр ──────────
  const [safety, counts] = await Promise.all([
    getSafetyStatus(), getPlatformCounts().catch(() => null),
  ]);
  const platformStats: PlatformStats | null = counts
    ? { routes: counts.routes, places: counts.places, mchsRoutes: counts.mchsRoutes, safetyProfiles: counts.safetyProfiles }
    : null;
  const fetchedAt = new Date().toISOString();

  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh] flex flex-col">
      <Header />
      <OnSiteBanner />
      <main className="flex-1 pt-[56px]">

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
        <StatsBand stats={platformStats} />

        {/* Mood/vibe entry — emotional starting point */}
        <MoodEntry />

        {/* Explore by element — 6 categories */}
        <BentoSection />

        {/* Editorial strip — цифры из единого источника, не хардкод */}
        <EditorialSection mchsRoutes={counts?.mchsRoutes ?? null} safetyProfiles={counts?.safetyProfiles ?? null} />

        {/* Kuzmich channels */}
        <MessengerAgentsSection />

        {/* Map preview — lazy, full-width */}
        <SectionErrorBoundary>
          <div className="border-t border-[var(--border)] h-[380px] md:h-[440px]">
            <HomeMapPreviewLazy />
          </div>
        </SectionErrorBoundary>

      </main>
      {/* Футер — только desktop (CLAUDE.md §2); на мобильном — своя нижняя навигация v8 */}
      <Footer />
      <SOSButton />
    </div>
  );
}
